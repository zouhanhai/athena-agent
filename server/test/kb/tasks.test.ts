import { test } from "node:test";
import assert from "node:assert/strict";
import { IngestTaskQueue } from "../../src/kb/tasks.js";

function makeFakes(opts: {
  markdown?: string;
  lightragOk?: boolean;
  llmwikiOk?: boolean;
  parseError?: Error;
}) {
  const calls: { kind: string; args: unknown[] }[] = [];
  const parser = {
    async parse(input: string) {
      calls.push({ kind: "parser.parse", args: [input] });
      if (opts.parseError) throw opts.parseError;
      return { markdown: opts.markdown ?? "# Doc", outputPath: "/shared/input/doc.md", stem: "doc" };
    },
  };
  const ingest = {
    async ingestLightRag(markdown: string, fileName: string) {
      calls.push({ kind: "ingest.lightrag", args: [markdown, fileName] });
      return opts.lightragOk === false
        ? { ok: false, error: "LightRAG down" }
        : { ok: true, trackId: "insert_1" };
    },
    async ingestLlmWiki(fileName: string, markdown: string) {
      calls.push({ kind: "ingest.llmwiki", args: [fileName, markdown] });
      return opts.llmwikiOk === false
        ? { ok: false, error: "wiki down" }
        : { ok: true };
    },
  };
  const queue = new IngestTaskQueue({
    parser: parser as never,
    ingest: ingest as never,
  });
  return { queue, calls };
}

async function untilDone(queue: IngestTaskQueue, id: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const task = queue.getTask(id)!;
    if (task.status === "done" || task.status === "failed") return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("task did not finish in time");
}

test("submitFile runs parse → lightrag → llmwiki and finishes done with full progress", async () => {
  const { queue, calls } = makeFakes({});
  const pendingTask = queue.createTask("report.pdf");
  assert.equal(pendingTask.status, "pending");
  assert.equal(pendingTask.stages.parsing.status, "pending");
  assert.equal(pendingTask.progress, 0);

  const { taskId } = queue.submitFile("/tmp/report.pdf", "report.pdf");
  assert.ok(taskId);
  await untilDone(queue, taskId);
  const task = queue.getTask(taskId)!;
  assert.equal(task.status, "done");
  assert.equal(task.progress, 100);
  assert.equal(task.documentId, "doc");
  assert.equal(task.stages.parsing.status, "done");
  assert.equal(task.stages.ingesting_lightrag.status, "done");
  assert.equal(task.stages.ingesting_llmwiki.status, "done");

  assert.deepEqual(
    calls.map((c) => c.kind),
    ["parser.parse", "ingest.lightrag", "ingest.llmwiki"],
  );
});

test("submitUrl passes the URL straight to docling parsing", async () => {
  const { queue, calls } = makeFakes({});
  const { taskId } = queue.submitUrl("https://example.com/page");
  await untilDone(queue, taskId);
  assert.deepEqual(calls[0], { kind: "parser.parse", args: ["https://example.com/page"] });
});

test("task records per-system failure when llm_wiki fails but LightRAG ok", async () => {
  const { queue } = makeFakes({ llmwikiOk: false });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);
  const task = queue.getTask(taskId)!;
  assert.equal(task.status, "done");
  assert.equal(task.stages.ingesting_lightrag.status, "done");
  assert.equal(task.stages.ingesting_llmwiki.status, "failed");
  assert.match(task.stages.ingesting_llmwiki.error ?? "", /wiki down/);
});

test("task fails overall when both systems fail", async () => {
  const { queue } = makeFakes({ lightragOk: false, llmwikiOk: false });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);
  const task = queue.getTask(taskId)!;
  assert.equal(task.status, "failed");
  assert.equal(task.stages.ingesting_lightrag.status, "failed");
  assert.equal(task.stages.ingesting_llmwiki.status, "failed");
  assert.match(task.error ?? "", /Both knowledge systems failed/);
});

test("task fails at parsing stage when docling errors", async () => {
  const { queue } = makeFakes({ parseError: new Error("parse exploded") });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);
  const task = queue.getTask(taskId)!;
  assert.equal(task.status, "failed");
  assert.equal(task.stages.parsing.status, "failed");
  assert.match(task.error ?? "", /parse exploded/);
});

test("getTask returns undefined for an unknown id", () => {
  const { queue } = makeFakes({});
  assert.equal(queue.getTask("nope"), undefined);
});
