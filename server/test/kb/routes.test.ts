import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../src/app.js";
import type { FastifyInstance } from "fastify";

function makeStubIngest(result: unknown, error?: Error) {
  return {
    async ingestMarkdown() {
      if (error) throw error;
      return result;
    },
  };
}

test("POST /api/kb/ingest requires title and content", async () => {
  const app = buildApp({ ingest: makeStubIngest({}) as never });
  try {
    const missingTitle = await app.inject({
      method: "POST",
      url: "/api/kb/ingest",
      payload: { content: "hi" },
    });
    assert.equal(missingTitle.statusCode, 400);
    const missingContent = await app.inject({
      method: "POST",
      url: "/api/kb/ingest",
      payload: { title: "Doc" },
    });
    assert.equal(missingContent.statusCode, 400);
    const blank = await app.inject({
      method: "POST",
      url: "/api/kb/ingest",
      payload: { title: "   ", content: "  " },
    });
    assert.equal(blank.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("POST /api/kb/ingest returns per-system ingest status", async () => {
  const result = {
    documentId: "runbook",
    systems: {
      llmwiki: { ok: true },
    },
  };
  const app = buildApp({ ingest: makeStubIngest(result) as never });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/ingest",
      payload: { title: "Runbook", content: "# Runbook", source: "runbook.md" },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), result);
  } finally {
    await app.close();
  }
});

test("POST /api/kb/ingest returns 500 when llm_wiki fails", async () => {
  const app = buildApp({
    ingest: makeStubIngest(undefined, new Error("wiki down")) as never,
  });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/ingest",
      payload: { title: "Runbook", content: "# Runbook" },
    });
    assert.equal(res.statusCode, 500);
    assert.match(res.json().error ?? "", /wiki down/);
  } finally {
    await app.close();
  }
});
