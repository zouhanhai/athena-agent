import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../src/app.js";
import type { FastifyInstance } from "fastify";
import { FeedbackService, type FeedbackServiceOptions } from "../../src/kb/feedback.js";
import type { SemanticMappingStore } from "../../src/kb/semantic-mappings.js";
import { MemorySemanticMappingStore } from "../../src/kb/semantic-mappings.js";
import { MemoryQaPairStore, type QaPairStore } from "../../src/kb/qa-pairs.js";
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

function stubFeedback(): FeedbackService {
  const store = new MemoryQaPairStore();
  const index = new MemoryQaEmbeddingIndex({ embedder: { embed: tokenEmbedder } });
  const options: FeedbackServiceOptions = {
    store,
    syncer: fakeSyncer() as never,
    index,
    dedupThreshold: 0.8,
  };
  return new FeedbackService(options);
}

async function appWith(options: {
  feedback?: FeedbackService;
  mappings?: SemanticMappingStore;
} = {}): Promise<FastifyInstance> {
  return buildApp({
    feedback: options.feedback ?? stubFeedback(),
    mappings: options.mappings ?? new MemorySemanticMappingStore(),
  });
}

test("GET /api/kb/mappings lists the stored semantic mappings", async () => {
  const mappings = new MemorySemanticMappingStore();
  await mappings.upsert({ term: "C-Day", canonical: "CALEO Day" });
  const app = await appWith({ mappings });
  try {
    const res = await app.inject({ method: "GET", url: "/api/kb/mappings" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.mappings.length, 1);
    assert.equal(body.mappings[0].term, "C-Day");
    assert.equal(body.mappings[0].canonical, "CALEO Day");
  } finally {
    await app.close();
  }
});

test("POST /api/kb/mappings upserts a term→canonical mapping", async () => {
  const app = await appWith();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/mappings",
      payload: { term: "HW", canonical: "Haushaltswaren" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.mapping.term, "HW");
    assert.equal(body.mapping.canonical, "Haushaltswaren");
  } finally {
    await app.close();
  }
});

test("POST /api/kb/mappings rejects a missing term or canonical", async () => {
  const app = await appWith();
  try {
    const noTerm = await app.inject({
      method: "POST",
      url: "/api/kb/mappings",
      payload: { canonical: "CALEO Day" },
    });
    assert.equal(noTerm.statusCode, 400);
    const noCanonical = await app.inject({
      method: "POST",
      url: "/api/kb/mappings",
      payload: { term: "C-Day" },
    });
    assert.equal(noCanonical.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("DELETE /api/kb/mappings/:id removes a mapping", async () => {
  const mappings = new MemorySemanticMappingStore();
  const mapping = await mappings.upsert({ term: "C-Day", canonical: "CALEO Day" });
  const app = await appWith({ mappings });
  try {
    const res = await app.inject({ method: "DELETE", url: `/api/kb/mappings/${mapping.id}` });
    assert.equal(res.statusCode, 200);
    assert.equal((await mappings.list()).length, 0);
    const missing = await app.inject({ method: "DELETE", url: "/api/kb/mappings/nope" });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("POST /api/kb/qa/manual inserts a new Q&A pair", async () => {
  const app = await appWith();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/qa/manual",
      payload: { question: "Who founded CALEO?", answer: "The founders did." },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.action, "inserted");
    assert.ok(body.pair);
    assert.equal(body.pair.question, "Who founded CALEO?");
  } finally {
    await app.close();
  }
});

test("POST /api/kb/qa/manual returns needs_decision when a similar question exists", async () => {
  const app = await appWith();
  try {
    const first = await app.inject({
      method: "POST",
      url: "/api/kb/qa/manual",
      payload: { question: "What is C-Day?", answer: "C-Day is the CALEO Day." },
    });
    assert.equal(first.statusCode, 200);

    const second = await app.inject({
      method: "POST",
      url: "/api/kb/qa/manual",
      payload: { question: "What is C Day?", answer: "A new answer." },
    });
    assert.equal(second.statusCode, 200);
    const body = second.json();
    assert.equal(body.action, "needs_decision");
    assert.equal(body.pair, null);
    assert.ok(body.similar);
    assert.ok(body.similar.score >= 0.8);
  } finally {
    await app.close();
  }
});

test("POST /api/kb/qa/manual with mode merges into the similar pair", async () => {
  const app = await appWith();
  try {
    await app.inject({
      method: "POST",
      url: "/api/kb/qa/manual",
      payload: { question: "What is C-Day?", answer: "C-Day is the CALEO Day." },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/qa/manual",
      payload: { question: "What is C Day?", answer: "It is in September.", mode: "merge" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.action, "merged");
    assert.ok(body.pair!.answer.includes("September"));
  } finally {
    await app.close();
  }
});

test("POST /api/kb/qa/manual rejects missing question/answer and bad mode", async () => {
  const app = await appWith();
  try {
    const noQuestion = await app.inject({
      method: "POST",
      url: "/api/kb/qa/manual",
      payload: { answer: "a" },
    });
    assert.equal(noQuestion.statusCode, 400);
    const noAnswer = await app.inject({
      method: "POST",
      url: "/api/kb/qa/manual",
      payload: { question: "q" },
    });
    assert.equal(noAnswer.statusCode, 400);
    const badMode = await app.inject({
      method: "POST",
      url: "/api/kb/qa/manual",
      payload: { question: "q", answer: "a", mode: "sideways" },
    });
    assert.equal(badMode.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("DELETE /api/kb/qa/:id removes a Q&A pair (also from the vector index)", async () => {
  const app = await appWith();
  try {
    const add = await app.inject({
      method: "POST",
      url: "/api/kb/qa/manual",
      payload: { question: "What is C-Day?", answer: "C-Day is the CALEO Day." },
    });
    const id = add.json().pair.id;
    const res = await app.inject({ method: "DELETE", url: `/api/kb/qa/${id}` });
    assert.equal(res.statusCode, 200);
    const list = await app.inject({ method: "GET", url: "/api/kb/qa" });
    assert.equal(list.json().pairs.length, 0);
  } finally {
    await app.close();
  }
});
