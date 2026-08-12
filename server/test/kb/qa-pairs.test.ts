import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MemoryQaPairStore,
  isFeedbackDirection,
  type QaPair,
  type QaPairUpsertInput,
} from "../../src/kb/qa-pairs.js";
import {
  MemoryQaEmbeddingIndex,
  Neo4jQaEmbeddingIndex,
  cosineSimilarity,
  QA_PAIR_LABEL,
  QA_QUESTION_EMBEDDING_INDEX,
  type QaSimilarMatch,
} from "../../src/kb/qa-index.js";
import type { Neo4jDriverLike } from "../../src/kb/store/schema.js";

function input(overrides: Partial<QaPairUpsertInput> = {}): QaPairUpsertInput {
  return {
    question: "What is C-Day?",
    answer: "C-Day is the CALEO Day.",
    sources: [{ path: "wiki/events/c-day.md" }],
    feedback: "up",
    ...overrides,
  };
}

// ---- MemoryQaPairStore (the Q&A table) ----

test("MemoryQaPairStore inserts a new pair with sources + feedback", async () => {
  const store = new MemoryQaPairStore();
  const pair = await store.upsert(input());

  assert.ok(pair.id.length > 0);
  assert.equal(pair.question, "What is C-Day?");
  assert.equal(pair.answer, "C-Day is the CALEO Day.");
  assert.deepEqual(pair.sources, [{ path: "wiki/events/c-day.md" }]);
  assert.equal(pair.feedback, "up");
  assert.ok(pair.created_at && pair.updated_at);
});

test("MemoryQaPairStore findByQuestion finds a stored pair (normalized question)", async () => {
  const store = new MemoryQaPairStore();
  await store.upsert(input());

  const found = await store.findByQuestion("  What is C-Day?  ");
  assert.ok(found);
  assert.equal(found!.question, "What is C-Day?");
  assert.equal(await store.findByQuestion("totally different"), null);
});

test("MemoryQaPairStore upsert updates an exact-text duplicate in place (no new row)", async () => {
  const store = new MemoryQaPairStore();
  const first = await store.upsert(input({ feedback: "up" }));
  const second = await store.upsert(input({ answer: "revised answer", feedback: "down" }));

  assert.equal(second.id, first.id, "same pair id — no duplicate row");
  assert.equal(second.answer, "revised answer");
  assert.equal(second.feedback, "down");
  assert.equal((await store.list()).length, 1);
});

test("MemoryQaPairStore merge appends the answer and aggregates feedback + sources", async () => {
  const store = new MemoryQaPairStore();
  const first = await store.upsert(input({ feedback: "up" }));
  const merged = await store.merge(first.id, {
    question: "What is C-Day?",
    answer: "It is celebrated annually.",
    sources: [{ path: "wiki/events/calendar.md" }],
    feedback: "down",
  });

  assert.equal(merged.id, first.id);
  assert.equal(merged.answer, "C-Day is the CALEO Day.\n\nIt is celebrated annually.");
  assert.equal(merged.feedback, "down", "feedback aggregated to the latest signal");
  assert.equal(merged.sources.length, 2, "sources unioned");
  assert.equal((await store.list()).length, 1, "still one row after merge");
});

test("MemoryQaPairStore merge falls back to an insert for an unknown id", async () => {
  const store = new MemoryQaPairStore();
  const pair = await store.merge("missing", input());
  assert.ok(pair.id);
  assert.equal(pair.answer, "C-Day is the CALEO Day.");
  assert.equal((await store.list()).length, 1);
});

test("MemoryQaPairStore setFeedback updates the stored direction", async () => {
  const store = new MemoryQaPairStore();
  const pair = await store.upsert(input({ feedback: "up" }));

  const updated = await store.setFeedback(pair.id, "down");
  assert.equal(updated?.feedback, "down");
  assert.equal((await store.getById(pair.id))?.feedback, "down");
  assert.equal(await store.setFeedback("missing", "up"), null);
});

test("isFeedbackDirection guards the accepted directions", () => {
  assert.equal(isFeedbackDirection("up"), true);
  assert.equal(isFeedbackDirection("down"), true);
  assert.equal(isFeedbackDirection("sideways"), false);
  assert.equal(isFeedbackDirection(undefined), false);
});

// ---- Q&A dedup index ----

/** Deterministic test embedder: a 256-dim bag-of-words vector. Near-identical
 *  questions share most tokens → high cosine; unrelated ones are disjoint. */
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

test("cosineSimilarity returns 1 for identical vectors and 0 for orthogonal ones", () => {
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
  assert.ok(cosineSimilarity([1, 0], [0, 1]) < 1e-9);
  assert.equal(cosineSimilarity([], []), 0);
});

test("MemoryQaEmbeddingIndex findSimilar returns a match at/above the threshold, else null", async () => {
  const index = new MemoryQaEmbeddingIndex({ embedder: { embed: tokenEmbedder } });
  await index.upsert("p1", "What is C-Day?");
  await index.upsert("p2", "How do I file an invoice?");

  const similar = await index.findSimilar("what is C-Day", 0.9);
  assert.ok(similar);
  assert.equal(similar!.id, "p1");
  assert.ok(similar!.score >= 0.9);

  const unrelated = await index.findSimilar("How do I file an invoice?", 0.9);
  assert.equal(unrelated!.id, "p2");

  const newQuestion = await index.findSimilar("What colour is the sky?", 0.9);
  assert.equal(newQuestion, null, "unrelated question stays below the threshold");

  await index.remove("p1");
  assert.equal(await index.findSimilar("what is C-Day", 0.9), null);
});

function scriptedDriver(records: Array<Record<string, unknown>>): {
  driver: Neo4jDriverLike;
  calls: { query: string; params?: Record<string, unknown> }[];
} {
  const calls: { query: string; params?: Record<string, unknown> }[] = [];
  const driver: Neo4jDriverLike = {
    session() {
      return {
        run: async (query: string, params?: Record<string, unknown>) => {
          calls.push({ query, params });
          return { records: records.map((r) => ({ get: (k: string) => r[k] })) };
        },
        close: async () => {},
      };
    },
  };
  return { driver, calls };
}

test("Neo4jQaEmbeddingIndex init creates the Q&A vector index + id constraint", async () => {
  const { driver, calls } = scriptedDriver([]);
  const index = new Neo4jQaEmbeddingIndex({ driver, embedder: { embed: tokenEmbedder } });

  await index.upsert("p1", "What is C-Day?");

  const ddl = calls.filter((c) => c.query.includes("CREATE"));
  assert.ok(ddl.some((c) => c.query.includes("VECTOR INDEX") && c.query.includes(QA_QUESTION_EMBEDDING_INDEX)));
  assert.ok(ddl.some((c) => c.query.includes("CONSTRAINT") && c.query.includes(QA_PAIR_LABEL)));
  assert.ok(calls.some((c) => c.query.includes(`MERGE (n:${QA_PAIR_LABEL}`)));
});

test("Neo4jQaEmbeddingIndex findSimilar parses the score and filters by threshold", async () => {
  const { driver, calls } = scriptedDriver([{ id: "p1", question: "What is C-Day?", score: 0.97 }]);
  const index = new Neo4jQaEmbeddingIndex({ driver, embedder: { embed: tokenEmbedder } });

  const match = (await index.findSimilar("what is C-Day", 0.9)) as QaSimilarMatch | null;
  assert.ok(match);
  assert.equal(match!.id, "p1");
  assert.equal(match!.question, "What is C-Day?");
  assert.equal(match!.score, 0.97);
  assert.ok(calls.some((c) => c.query.includes("VECTOR INDEX") && c.query.includes(QA_QUESTION_EMBEDDING_INDEX)));

  const below = await index.findSimilar("what is C-Day", 0.99);
  assert.equal(below, null, "score below the requested threshold is rejected");
});

test("Neo4jQaEmbeddingIndex remove deletes the pair node", async () => {
  const { driver, calls } = scriptedDriver([]);
  const index = new Neo4jQaEmbeddingIndex({ driver, embedder: { embed: tokenEmbedder } });

  await index.remove("p1");
  assert.ok(calls.some((c) => c.query.includes("DELETE") && c.query.includes(QA_PAIR_LABEL)));
});
