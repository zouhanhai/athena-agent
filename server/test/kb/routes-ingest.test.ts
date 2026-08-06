import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/app.js";
import { IngestTaskQueue } from "../../src/kb/tasks.js";
import type { FastifyInstance } from "fastify";

const BOUNDARY = "test-boundary-123";

function makeTaskQueue(opts: { failParse?: boolean } = {}) {
  const parser = {
    async parse(input: string) {
      if (opts.failParse) throw new Error("docling failed");
      return { markdown: "# Uploaded", outputPath: "/shared/input/uploaded.md", stem: "uploaded" };
    },
  };
  const ingest = {
    async ingestLightRag() {
      return { ok: true, trackId: "insert_1" };
    },
    async ingestLlmWiki() {
      return { ok: true };
    },
  };
  return new IngestTaskQueue({ parser: parser as never, ingest: ingest as never });
}

function multipartBody(filename: string, content: string): Buffer {
  return Buffer.from(
    [
      `--${BOUNDARY}`,
      `Content-Disposition: form-data; name="file"; filename="${filename}"`,
      "Content-Type: application/pdf",
      "",
      content,
      `--${BOUNDARY}--`,
      "",
    ].join("\r\n"),
  );
}

async function pollTask(app: FastifyInstance, taskId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const res = await app.inject({ method: "GET", url: `/api/kb/task/${taskId}` });
    assert.equal(res.statusCode, 200);
    const task = res.json() as { status: string };
    if (task.status === "done" || task.status === "failed") return res.json();
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("task did not finish in time");
}

test("POST /api/kb/ingest with multipart upload returns a taskId and reaches done", async () => {
  const uploadDir = await mkdtemp(join(tmpdir(), "kb-upload-"));
  const app = buildApp({ taskQueue: makeTaskQueue(), maxFileSize: 1024 * 1024 });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/ingest",
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody("report.pdf", "%PDF-1.4 fake"),
    });
    assert.equal(res.statusCode, 202);
    const { taskId } = res.json() as { taskId: string };
    assert.ok(taskId);

    const task = await pollTask(app, taskId);
    assert.equal(task.status, "done");
    assert.equal(task.progress, 100);
    assert.equal((task as { documentId: string }).documentId, "uploaded");
  } finally {
    await app.close();
    await rm(uploadDir, { recursive: true, force: true });
  }
});

test("POST /api/kb/ingest without a file returns 400", async () => {
  const app = buildApp({ taskQueue: makeTaskQueue() });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/ingest",
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: Buffer.from(`--${BOUNDARY}--\r\n`),
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("POST /api/kb/ingest-url accepts a valid URL and tracks task to done", async () => {
  const app = buildApp({ taskQueue: makeTaskQueue() });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/ingest-url",
      payload: { url: "https://example.com/docs/runbook" },
    });
    assert.equal(res.statusCode, 202);
    const { taskId } = res.json() as { taskId: string };

    const task = await pollTask(app, taskId);
    assert.equal(task.status, "done");
    assert.equal(task.source, "https://example.com/docs/runbook");
  } finally {
    await app.close();
  }
});

test("POST /api/kb/ingest-url rejects missing / invalid url", async () => {
  const app = buildApp({ taskQueue: makeTaskQueue() });
  try {
    const missing = await app.inject({ method: "POST", url: "/api/kb/ingest-url", payload: {} });
    assert.equal(missing.statusCode, 400);
    const notUrl = await app.inject({
      method: "POST",
      url: "/api/kb/ingest-url",
      payload: { url: "not-a-url" },
    });
    assert.equal(notUrl.statusCode, 400);
    const ftp = await app.inject({
      method: "POST",
      url: "/api/kb/ingest-url",
      payload: { url: "ftp://example.com/x" },
    });
    assert.equal(ftp.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("GET /api/kb/task/:id returns the task and 404 for unknown ids", async () => {
  const app = buildApp({ taskQueue: makeTaskQueue() });
  try {
    const res = await app.inject({ method: "GET", url: "/api/kb/task/does-not-exist" });
    assert.equal(res.statusCode, 404);

    const ingest = await app.inject({
      method: "POST",
      url: "/api/kb/ingest-url",
      payload: { url: "https://example.com/" },
    });
    const { taskId } = ingest.json() as { taskId: string };
    const taskRes = await app.inject({ method: "GET", url: `/api/kb/task/${taskId}` });
    assert.equal(taskRes.statusCode, 200);
    const task = taskRes.json() as { id: string };
    assert.equal(task.id, taskId);
  } finally {
    await app.close();
  }
});

test("failed docling parse surfaces a failed task via the task endpoint", async () => {
  const app = buildApp({ taskQueue: makeTaskQueue({ failParse: true }) });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/ingest-url",
      payload: { url: "https://example.com/broken" },
    });
    const { taskId } = res.json() as { taskId: string };
    const task = await pollTask(app, taskId);
    assert.equal(task.status, "failed");
    assert.match(task.error as string, /docling failed/);
    assert.equal(
      ((task as { stages: { parsing: { status: string } } }).stages).parsing.status,
      "failed",
    );
  } finally {
    await app.close();
  }
});
