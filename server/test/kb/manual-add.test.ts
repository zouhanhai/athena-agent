import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryQaPairStore, type QaPair } from "../../src/kb/qa-pairs.js";
import { MemoryQaEmbeddingIndex } from "../../src/kb/qa-index.js";

function tokenEmbedder(texts: string[]): Promise<number[][]> {
  return Promise.resolve(
    texts.map((text) => {
      const vec = new Array<number>(256).fill(0);
      for (const token of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
        let h = 0;
        for (const ch of token) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        vec[h % 256]! += 1;
      }
      return vec;
    }),
  );
}

function fakeSyncer() {
  return {
    readLifecycle: async () => ({ confidence: 0.5 }),
    update: async () => {},
  };
}

async function makeService() {
  const store = new MemoryQaPairStore();
  const index = new MemoryQaEmbeddingIndex({ embedder: { embed: tokenEmbedder } });
  const { FeedbackService } = await import("../../src/kb/feedback.js");
  const service = new FeedbackService({
    store,
    syncer: fakeSyncer() as never,
    index,
    dedupThreshold: 0.8,
  });
  return { service, store, index };
}

function seedPair(): QaPair {
  return {
    id: "pair-1",
    question: "What is C-Day?",
    answer: "C-Day is the CALEO Day.",
    sources: [],
    feedback: null,
    created_at: "2026-08-12T00:00:00.000Z",
    updated_at: "2026-08-12T00:00:00.000Z",
  };
}

test("QaPairStore overwrite replaces answer + sources of a pair in place (keeps id + feedback)", async () => {
  const store = new MemoryQaPairStore();
  const pair = await store.upsert({
    question: "What is C-Day?",
    answer: "old answer",
    sources: [{ path: "wiki/a.md" }],
    feedback: "up",
  });

  const updated = await store.overwrite(pair.id, {
    question: "What is C-Day?",
    answer: "new answer",
    sources: [{ path: "wiki/b.md" }],
    feedback: null,
  });

  assert.equal(updated.id, pair.id, "same row id");
  assert.equal(updated.answer, "new answer", "answer replaced, not appended");
  assert.deepEqual(updated.sources, [{ path: "wiki/b.md" }], "sources replaced");
  assert.equal(updated.feedback, null, "feedback set to null (manual entry)");
  assert.equal((await store.list()).length, 1, "no duplicate row");
});

test("QaPairStore overwrite falls back to an insert for an unknown id", async () => {
  const store = new MemoryQaPairStore();
  const pair = await store.overwrite("missing", {
    question: "What is C-Day?",
    answer: "answer",
    feedback: null,
  });
  assert.ok(pair.id);
  assert.equal(pair.answer, "answer");
});

test("QaPairStore remove deletes a pair by id", async () => {
  const store = new MemoryQaPairStore();
  const pair = await store.upsert({
    question: "What is C-Day?",
    answer: "answer",
    feedback: "up",
  });
  assert.equal(await store.remove(pair.id), true);
  assert.equal(await store.remove(pair.id), false);
  assert.equal((await store.list()).length, 0);
});

test("manualAdd inserts a new pair when no similar question exists", async () => {
  const { service, store } = await makeService();
  const result = await service.manualAdd({
    question: "Who invented the wheel?",
    answer: "Unknown.",
  });

  assert.equal(result.action, "inserted");
  assert.ok(result.pair);
  assert.equal(result.similar, undefined);
  assert.equal((await store.list()).length, 1);
});

test("manualAdd without mode returns the similar match and does NOT insert", async () => {
  const { service, index } = await makeService();
  const first = await service.manualAdd({
    question: "What is C-Day?",
    answer: "C-Day is the CALEO Day.",
  });
  assert.equal(first.action, "inserted");
  await index.upsert(first.pair!.id, first.pair!.question);

  const second = await service.manualAdd({
    question: "What is C Day?",
    answer: "A new answer.",
  });

  assert.equal(second.action, "needs_decision", "no write without a decision mode");
  assert.ok(second.similar, "similar match surfaced for the front-end dialog");
  assert.ok(second.similar!.score >= 0.8);
  assert.equal(second.pair, null);
});

test("manualAdd with mode merge appends the new answer to the similar pair", async () => {
  const { service, index } = await makeService();
  const first = await service.manualAdd({
    question: "What is C-Day?",
    answer: "C-Day is the CALEO Day.",
  });
  await index.upsert(first.pair!.id, first.pair!.question);

  const result = await service.manualAdd(
    { question: "What is C Day?", answer: "It is celebrated in September." },
    "merge",
  );

  assert.equal(result.action, "merged");
  assert.ok(result.pair);
  assert.equal(result.pair!.id, first.pair!.id, "merged into the existing pair");
  assert.ok(
    result.pair!.answer.includes("CALEO Day") && result.pair!.answer.includes("September"),
    "both answers present",
  );
});

test("manualAdd with mode overwrite replaces the similar pair's answer", async () => {
  const { service, index } = await makeService();
  const first = await service.manualAdd({
    question: "What is C-Day?",
    answer: "C-Day is the CALEO Day.",
  });
  await index.upsert(first.pair!.id, first.pair!.question);

  const result = await service.manualAdd(
    { question: "What is C Day?", answer: "It is the company anniversary." },
    "overwrite",
  );

  assert.equal(result.action, "overwritten");
  assert.equal(result.pair!.id, first.pair!.id);
  assert.equal(result.pair!.answer, "It is the company anniversary.", "answer replaced");
});

test("manualAdd with mode add-anyway inserts a new row despite the similar match", async () => {
  const { service, index } = await makeService();
  const first = await service.manualAdd({
    question: "What is C-Day?",
    answer: "C-Day is the CALEO Day.",
  });
  await index.upsert(first.pair!.id, first.pair!.question);

  const result = await service.manualAdd(
    { question: "What is C Day?", answer: "A distinct variant." },
    "add-anyway",
  );

  assert.equal(result.action, "added_anyway");
  assert.ok(result.pair);
  assert.notEqual(result.pair!.id, first.pair!.id, "a new row");
});

test("findReference vector-searches the QA store and returns the pair as reference", async () => {
  const { service, index } = await makeService();
  const first = await service.manualAdd({
    question: "What is C-Day?",
    answer: "C-Day is the CALEO Day.",
  });
  await index.upsert(first.pair!.id, first.pair!.question);

  const ref = await service.findReference("What is C Day?");
  assert.ok(ref);
  assert.equal(ref!.id, first.pair!.id);
  assert.equal(ref!.question, "What is C-Day?");
  assert.equal(ref!.answer, "C-Day is the CALEO Day.");
  assert.ok(typeof ref!.score === "number");
});

test("findReference returns null when nothing is similar enough", async () => {
  const { service } = await makeService();
  const ref = await service.findReference("What is the capital of France?");
  assert.equal(ref, null);
});
