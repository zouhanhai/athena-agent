import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../src/app.js";
import type { FastifyInstance } from "fastify";
import type { FeedbackService } from "../../src/kb/feedback.js";
import type { QaPair, QaPairStore } from "../../src/kb/qa-pairs.js";

function stubPair(): QaPair {
  return {
    id: "pair-1",
    question: "What is C-Day?",
    answer: "C-Day is the CALEO Day.",
    sources: [],
    feedback: "up",
    created_at: "2026-08-12T00:00:00.000Z",
    updated_at: "2026-08-12T00:00:00.000Z",
  };
}

interface RecordCall {
  input?: Record<string, unknown>;
}

const recorded: RecordCall[] = [];

function stubFeedback(): FeedbackService {
  const list: QaPair[] = [];
  return {
    record: async (input) => {
      recorded.push({ input });
      const pair = { ...stubPair(), question: input.question, feedback: input.feedback };
      list.push(pair);
      return { pair, deduped: false, confidenceUpdates: [] };
    },
    qaStore: {
      list: async () => list,
    } as unknown as QaPairStore,
    close: async () => {},
  } as unknown as FeedbackService;
}

async function appWith(): Promise<FastifyInstance> {
  return buildApp({ feedback: stubFeedback() });
}

test("POST /api/kb/feedback records a Q&A pair and returns pair + confidenceUpdates", async () => {
  recorded.length = 0;
  const app = await appWith();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/feedback",
      payload: {
        question: "What is C-Day?",
        answer: "C-Day is the CALEO Day.",
        sources: [{ path: "wiki/events/c-day.md", title: "C-Day" }],
        feedback: "up",
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.pair.question, "What is C-Day?");
    assert.equal(body.pair.feedback, "up");
    assert.deepEqual(body.confidenceUpdates, []);
    assert.equal(recorded[0]!.input!.question, "What is C-Day?");
    assert.equal(recorded[0]!.input!.feedback, "up");
    assert.deepEqual(recorded[0]!.input!.sources, [
      { path: "wiki/events/c-day.md", title: "C-Day" },
    ]);
  } finally {
    await app.close();
  }
});

test("POST /api/kb/feedback rejects a missing question / answer / bad feedback", async () => {
  const app = await appWith();
  try {
    const noQuestion = await app.inject({
      method: "POST",
      url: "/api/kb/feedback",
      payload: { answer: "x", feedback: "up" },
    });
    assert.equal(noQuestion.statusCode, 400);

    const noAnswer = await app.inject({
      method: "POST",
      url: "/api/kb/feedback",
      payload: { question: "q", feedback: "up" },
    });
    assert.equal(noAnswer.statusCode, 400);

    const badFeedback = await app.inject({
      method: "POST",
      url: "/api/kb/feedback",
      payload: { question: "q", answer: "a", feedback: "sideways" },
    });
    assert.equal(badFeedback.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("POST /api/kb/feedback tolerates missing sources (empty array)", async () => {
  recorded.length = 0;
  const app = await appWith();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/feedback",
      payload: { question: "q", answer: "a", feedback: "down" },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(recorded[0]!.input!.sources, []);
  } finally {
    await app.close();
  }
});

test("GET /api/kb/qa lists the stored Q&A pairs", async () => {
  const app = await appWith();
  try {
    const res = await app.inject({ method: "POST", url: "/api/kb/feedback", payload: {
      question: "What is C-Day?",
      answer: "C-Day is the CALEO Day.",
      feedback: "up",
    } });
    assert.equal(res.statusCode, 200);

    const list = await app.inject({ method: "GET", url: "/api/kb/qa" });
    assert.equal(list.statusCode, 200);
    const body = list.json();
    assert.equal(body.pairs.length, 1);
    assert.equal(body.pairs[0].question, "What is C-Day?");
  } finally {
    await app.close();
  }
});
