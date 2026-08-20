import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/app.js";
import { IngestTaskQueue } from "../../src/kb/tasks.js";
import type { FastifyInstance } from "fastify";

const CDS_FIXTURE = join(import.meta.dirname, "..", "fixtures", "cds", "gr-cds-scope.cds");
const ABAP_CLASS_FIXTURE = join(import.meta.dirname, "..", "fixtures", "abap", "zcl_fi_delivery.clas.abap");

/** Point the code-store at a temp dir so CDS intake writes stay test-local. Returns
 *  a teardown that restores the previous env value. */
function useCodeDir(dir: string): () => void {
  const prev = process.env.CODE_OUTPUT_DIR;
  process.env.CODE_OUTPUT_DIR = dir;
  return () => {
    if (prev === undefined) delete process.env.CODE_OUTPUT_DIR;
    else process.env.CODE_OUTPUT_DIR = prev;
  };
}

const BOUNDARY = "test-boundary-123";

function makeTaskQueue(opts: {
  failParse?: boolean;
  llmwikiFailures?: number;
  neo4j?: boolean;
} = {}) {
  const counts = { llmwiki: 0 };
  const parser = {
    async parse(input: string) {
      if (opts.failParse) throw new Error("docling failed");
      return { markdown: "# Uploaded", outputPath: "/shared/input/uploaded.md", stem: "uploaded" };
    },
  };
  const ingest = {
    async prepareForIngest(input: { title: string; content: string }) {
      return {
        classification: { category: "concept", pagePath: "wiki/concepts/uploaded.md", topic: "sommerseminar" },
        frontmatterContent: `---\ntype: concept\ntitle: ${input.title}\ntopic: sommerseminar\n---\n\n${input.content}`,
      };
    },
    async ingestLlmWiki() {
      counts.llmwiki += 1;
      if (opts.llmwikiFailures !== undefined && counts.llmwiki <= opts.llmwikiFailures) {
        return { ok: false, error: "wiki down" };
      }
      return { ok: true };
    },
  };
  const refiner = async () => ({
    ref: {
      md_ref: "/storage/uploaded/markdown.md",
      chunks_ref: "/storage/uploaded/chunks.json",
      preview: "preview",
      char_count: 1,
      line_count: 1,
      header_count: 1,
      chunk_count: 1,
      frontmatter: { type: "concept", topic: "sommerseminar" },
      entities: [],
      relations: [],
      keywords: [],
      quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
      mode: "single",
      sections: [],
    },
    markdown: "# Uploaded",
    ragMarkdown: "# Uploaded",
  });
  return new IngestTaskQueue({
    parser: parser as never,
    ingest: ingest as never,
    refiner: refiner as never,
    ...(opts.neo4j
      ? {
          neo4j: {
            async ingest(input: {
              ref: unknown;
              documentId: string;
              title: string;
              onProgress?: (p: { chunksStored: number; chunksTotal: number; progress: number }) => void;
            }) {
              input.onProgress?.({ chunksStored: 1, chunksTotal: 2, progress: 0.5 });
              input.onProgress?.({ chunksStored: 2, chunksTotal: 2, progress: 1 });
              return { chunksStored: 2, entitiesStored: 0, relationsStored: 0 };
            },
          } as never,
        }
      : {}),
  });
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

test("GET /api/kb/task/:id surfaces ingesting_neo4j chunk progress (G4.S3.T8)", async () => {
  const app = buildApp({ taskQueue: makeTaskQueue({ neo4j: true }) });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/ingest-url",
      payload: { url: "https://example.com/progress" },
    });
    const { taskId } = res.json() as { taskId: string };
    const task = await pollTask(app, taskId);
    const stage = (task.stages as { ingesting_neo4j: { status: string; chunksStored?: number; chunksTotal?: number; progress?: number } })
      .ingesting_neo4j;
    assert.equal(stage.status, "done");
    assert.equal(stage.chunksStored, 2);
    assert.equal(stage.chunksTotal, 2);
    assert.equal(stage.progress, 1);
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

test("POST /api/kb/ingest/retry re-runs only the failed stage and returns the updated task", async () => {
  const app = buildApp({ taskQueue: makeTaskQueue({ llmwikiFailures: 1, neo4j: true }) });
  try {
    const ingest = await app.inject({
      method: "POST",
      url: "/api/kb/ingest-url",
      payload: { url: "https://example.com/retry" },
    });
    const { taskId } = ingest.json() as { taskId: string };

    const failed = await pollTask(app, taskId);
    assert.equal(failed.status, "done");
    assert.equal(
      ((failed as { stages: { ingesting_llmwiki: { status: string } } }).stages)
        .ingesting_llmwiki.status,
      "failed",
    );
    assert.equal(
      ((failed as { stages: { ingesting_neo4j: { status: string } } }).stages)
        .ingesting_neo4j.status,
      "done",
    );

    const retry = await app.inject({
      method: "POST",
      url: "/api/kb/ingest/retry",
      payload: { taskId },
    });
    assert.equal(retry.statusCode, 200);
    assert.equal((retry.json() as { id: string }).id, taskId);

    const recovered = await pollTask(app, taskId);
    assert.equal(recovered.status, "done");
    assert.equal(
      ((recovered as { stages: { ingesting_llmwiki: { status: string } } }).stages)
        .ingesting_llmwiki.status,
      "done",
    );
  } finally {
    await app.close();
  }
});

test("POST /api/kb/ingest/retry returns 404 for an unknown task id", async () => {
  const app = buildApp({ taskQueue: makeTaskQueue() });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/ingest/retry",
      payload: { taskId: "does-not-exist" },
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("POST /api/kb/ingest/retry rejects a missing taskId", async () => {
  const app = buildApp({ taskQueue: makeTaskQueue() });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/ingest/retry",
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await app.close();
  }
});

function makeDeleteIngest(opts: { fail?: boolean } = {}) {
  return {
    async deleteDocument(path: string) {
      if (opts.fail) {
        return { ok: false, llmwiki: { path, error: "delete failed" } };
      }
      return { ok: true, llmwiki: { path } };
    },
  } as never;
}

test("DELETE /api/kb/doc deletes the wiki page", async () => {
  const app = buildApp({ ingest: makeDeleteIngest(), taskQueue: makeTaskQueue() });
  try {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/kb/doc",
      payload: { path: "wiki/concepts/foo.md" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { ok: boolean; llmwiki: { path: string } };
    assert.equal(body.ok, true);
    assert.equal(body.llmwiki.path, "wiki/concepts/foo.md");
  } finally {
    await app.close();
  }
});

test("POST /api/kb/doc/delete is an alias for the delete endpoint", async () => {
  const app = buildApp({ ingest: makeDeleteIngest(), taskQueue: makeTaskQueue() });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/doc/delete",
      payload: { path: "wiki/sommerseminar/s1.md" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { ok: boolean }).ok, true);
  } finally {
    await app.close();
  }
});

test("DELETE /api/kb/doc rejects missing, invalid and unsafe paths", async () => {
  const app = buildApp({ ingest: makeDeleteIngest(), taskQueue: makeTaskQueue() });
  try {
    const badPaths = ["", "foo.md", "wiki/../evil.md", "/etc/passwd", "wiki/concepts/foo.txt"];
    for (const path of badPaths) {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/kb/doc",
        payload: { path },
      });
      assert.equal(res.statusCode, 400, `path=${path}`);
    }
    const missing = await app.inject({ method: "DELETE", url: "/api/kb/doc", payload: {} });
    assert.equal(missing.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("DELETE /api/kb/doc returns 500 when deletion fails", async () => {
  const app = buildApp({ ingest: makeDeleteIngest({ fail: true }), taskQueue: makeTaskQueue() });
  try {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/kb/doc",
      payload: { path: "wiki/concepts/foo.md" },
    });
    assert.equal(res.statusCode, 500);
    assert.equal((res.json() as { ok: boolean }).ok, false);
  } finally {
    await app.close();
  }
});

test("POST /api/kb/ingest kind=cds submits a task that parses DDL via the code channel (no docling)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-cds-"));
  const teardown = useCodeDir(dir);
  const app = buildApp({ taskQueue: makeTaskQueue() });
  try {
    const content = await readFile(CDS_FIXTURE, "utf8");
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/ingest",
      payload: {
        kind: "cds",
        filename: "gr-cds-scope.cds",
        system: "S4H",
        devclass: "ZCNSLD",
        content,
      },
    });
    assert.equal(res.statusCode, 202);
    const { taskId, kind } = res.json() as { taskId: string; kind: string };
    assert.ok(taskId);
    assert.equal(kind, "cds");

    const task = await pollTask(app, taskId);
    assert.equal(task.status, "done");
    // The CDS source parsed into one chunk per `define view ... }` boundary and
    // flowed into the llm_wiki stage.
    assert.equal(
      (task.stages as { ingesting_llmwiki: { status: string } }).ingesting_llmwiki.status,
      "done",
    );
  } finally {
    await app.close();
    teardown();
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /api/kb/ingest kind=cds rejects empty content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-cds-"));
  const teardown = useCodeDir(dir);
  const app = buildApp({ taskQueue: makeTaskQueue() });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/ingest",
      payload: { kind: "cds", content: "" },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await app.close();
    teardown();
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /api/kb/ingest kind=cds fails the task when the source has no CDS views", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-cds-"));
  const teardown = useCodeDir(dir);
  const app = buildApp({ taskQueue: makeTaskQueue() });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/ingest",
      payload: { kind: "cds", content: "this is not cds\nno view here\n" },
    });
    const { taskId } = res.json() as { taskId: string };
    const task = await pollTask(app, taskId);
    assert.equal(task.status, "failed");
    assert.match(task.error as string, /no .*define view/i);
  } finally {
    await app.close();
    teardown();
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /api/kb/ingest kind=abap submits a task that parses source via the code channel (no docling)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-abap-"));
  const teardown = useCodeDir(dir);
  const app = buildApp({ taskQueue: makeTaskQueue() });
  try {
    const content = await readFile(ABAP_CLASS_FIXTURE, "utf8");
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/ingest",
      payload: {
        kind: "abap",
        filename: "zcl_fi_delivery.clas.abap",
        system: "S4H",
        devclass: "ZFIDL",
        content,
      },
    });
    assert.equal(res.statusCode, 202);
    const { taskId, kind } = res.json() as { taskId: string; kind: string };
    assert.ok(taskId);
    assert.equal(kind, "abap");

    const task = await pollTask(app, taskId);
    assert.equal(task.status, "done");
    // The ABAP source parsed into one chunk per METHOD and flowed into the
    // llm_wiki stage.
    assert.equal(
      (task.stages as { ingesting_llmwiki: { status: string } }).ingesting_llmwiki.status,
      "done",
    );
  } finally {
    await app.close();
    teardown();
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /api/kb/ingest kind=abap rejects empty content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-abap-"));
  const teardown = useCodeDir(dir);
  const app = buildApp({ taskQueue: makeTaskQueue() });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/ingest",
      payload: { kind: "abap", content: "" },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await app.close();
    teardown();
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /api/kb/ingest kind=abap fails the task when the source has no ABAP units", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-abap-"));
  const teardown = useCodeDir(dir);
  const app = buildApp({ taskQueue: makeTaskQueue() });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/ingest",
      payload: { kind: "abap", content: "this is not abap\nnothing here\n" },
    });
    const { taskId } = res.json() as { taskId: string };
    const task = await pollTask(app, taskId);
    assert.equal(task.status, "failed");
    assert.match(task.error as string, /no .*abap|no .*class|no .*unit/i);
  } finally {
    await app.close();
    teardown();
    await rm(dir, { recursive: true, force: true });
  }
});
