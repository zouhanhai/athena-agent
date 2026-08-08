import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IngestTaskQueue,
  NothingToRetryError,
  TaskBusyError,
  TaskNotFoundError,
} from "../../src/kb/tasks.js";
import type { IngestTask } from "../../src/kb/tasks.js";

function makeFakes(opts: {
  markdown?: string;
  lightragOk?: boolean;
  llmwikiOk?: boolean;
  parseError?: Error;
  lightragTrack?: {
    /** Status sequence returned by the fake /documents/track_status (last repeats). */
    statuses?: string[];
    chunksCount?: number;
    errorMsg?: string;
    historyMessages?: string[];
  };
  dedup?: {
    duplicate?: boolean;
    method?: "hash" | "chunks";
    existingSource?: string;
  };
  nearDuplicate?: string;
  /** Injectable poller sleep so tests can gate/avoid real timer delays. */
  sleep?: (ms: number) => Promise<void>;
  /** LightRAG poll loop timeout (ms). */
  lightragWaitTimeoutMs?: number;
} = {}) {
  const flags = {
    lightragOk: opts.lightragOk !== false,
    llmwikiOk: opts.llmwikiOk !== false,
    parseError: opts.parseError,
    /** Optional gate awaited by the llm_wiki fake so tests can observe the
     *  retry reset before the re-run re-drives the stage. */
    llmwikiGate: undefined as Promise<void> | undefined,
  };
  const calls: { kind: string; args: unknown[] }[] = [];
  const parser = {
    async parse(input: string) {
      calls.push({ kind: "parser.parse", args: [input] });
      if (flags.parseError) throw flags.parseError;
      return { markdown: opts.markdown ?? "# Doc", outputPath: "/shared/input/doc.md", stem: "doc" };
    },
  };
  const lightragStatuses = opts.lightragTrack?.statuses ?? ["processed"];
  let trackStatusIdx = 0;
  const ingest = {
    async ingestLightRag(markdown: string, fileName: string) {
      calls.push({ kind: "ingest.lightrag", args: [markdown, fileName] });
      return flags.lightragOk
        ? { ok: true, trackId: "insert_1" }
        : { ok: false, error: "LightRAG down" };
    },
    async getLightRagTrackStatus(trackId: string) {
      const status = lightragStatuses[Math.min(trackStatusIdx, lightragStatuses.length - 1)];
      trackStatusIdx += 1;
      return {
        track_id: trackId,
        total_count: 1,
        status_summary: { [status]: 1 },
        documents: [
          {
            id: "d1",
            status,
            ...(opts.lightragTrack?.chunksCount !== undefined
              ? { chunks_count: opts.lightragTrack.chunksCount }
              : {}),
            ...(opts.lightragTrack?.errorMsg ? { error_msg: opts.lightragTrack.errorMsg } : {}),
          },
        ],
      };
    },
    async getLightRagPipelineStatus() {
      return { history_messages: opts.lightragTrack?.historyMessages ?? [] };
    },
    async ingestLlmWiki(fileName: string, markdown: string, onStep?: (step: string, status: "running" | "done") => void) {
      calls.push({ kind: "ingest.llmwiki", args: [fileName, markdown] });
      if (flags.llmwikiGate) await flags.llmwikiGate;
      if (!onStep) return flags.llmwikiOk ? { ok: true } : { ok: false, error: "wiki down" };
      onStep("classify", "running");
      onStep("classify", "done");
      if (!flags.llmwikiOk) return { ok: false, error: "wiki down" };
      onStep("write_page", "running");
      onStep("write_page", "done");
      onStep("rebuild_index", "running");
      onStep("rebuild_index", "done");
      return { ok: true };
    },
    async findNearDuplicate(_content: string, _fileName: string) {
      return opts.nearDuplicate ?? undefined;
    },
  };
  const dedup = opts.dedup
    ? {
        async check() {
          return {
            duplicate: opts.dedup!.duplicate !== false,
            ...(opts.dedup!.method ? { method: opts.dedup!.method } : {}),
            ...(opts.dedup!.existingSource ? { existingSource: opts.dedup!.existingSource } : {}),
          };
        },
        async record() {},
      }
    : undefined;
  const queue = new IngestTaskQueue({
    parser: parser as never,
    ingest: ingest as never,
    dedup: dedup as never,
    sleep: opts.sleep ?? (async () => {}),
    lightragWaitTimeoutMs: opts.lightragWaitTimeoutMs,
  });
  return { queue, calls, flags };
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

async function waitFor(check: () => boolean, deadlineMs = 2000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("condition not met in time");
}

test("createTask seeds per-system sub-steps (docling/LightRAG/llm_wiki) each pending", () => {
  const { queue } = makeFakes({});
  const task = queue.createTask("report.pdf");
  assert.equal(task.stages.parsing.status, "pending");
  assert.equal(task.stages.ingesting_lightrag.status, "pending");
  assert.equal(task.stages.ingesting_llmwiki.status, "pending");

  // docling sub-steps
  assert.deepEqual(
    task.stages.parsing.steps.map((s) => [s.name, s.status]),
    [
      ["read_file", "pending"],
      ["parse_ocr_image_desc", "pending"],
    ],
  );
  // LightRAG sub-steps
  assert.deepEqual(
    task.stages.ingesting_lightrag.steps.map((s) => [s.name, s.status]),
    [
      ["chunking", "pending"],
      ["entity_extraction", "pending"],
      ["graph_build", "pending"],
      ["embedding", "pending"],
    ],
  );
  // llm_wiki sub-steps
  assert.deepEqual(
    task.stages.ingesting_llmwiki.steps.map((s) => [s.name, s.status]),
    [
      ["classify", "pending"],
      ["write_page", "pending"],
      ["rebuild_index", "pending"],
    ],
  );
});

test("successful ingest marks every per-system sub-step done", async () => {
  const { queue } = makeFakes({});
  const { taskId } = queue.submitFile("/tmp/report.pdf", "report.pdf");
  await untilDone(queue, taskId);
  const task = queue.getTask(taskId)!;
  assert.equal(task.status, "done");
  for (const stage of [task.stages.parsing, task.stages.ingesting_lightrag, task.stages.ingesting_llmwiki]) {
    assert.equal(stage.status, "done");
    for (const step of stage.steps) {
      assert.equal(step.status, "done", `${stage.name}.${step.name} done`);
    }
  }
});

test("docling failure marks the parsing sub-steps failed", async () => {
  const { queue } = makeFakes({ parseError: new Error("parse exploded") });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);
  const task = queue.getTask(taskId)!;
  assert.equal(task.status, "failed");
  assert.equal(task.stages.parsing.status, "failed");
  for (const step of task.stages.parsing.steps) {
    assert.equal(step.status, "failed", `${step.name} failed`);
  }
});

test("llm_wiki failure marks only its sub-steps failed; classify done, later steps failed", async () => {
  const { queue } = makeFakes({ llmwikiOk: false });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);
  const task = queue.getTask(taskId)!;
  assert.equal(task.stages.ingesting_llmwiki.status, "failed");
  const status = new Map(task.stages.ingesting_llmwiki.steps.map((s) => [s.name, s.status]));
  assert.equal(status.get("classify"), "done", "classify succeeded before the wiki call failed");
  assert.equal(status.get("write_page"), "failed");
  assert.equal(status.get("rebuild_index"), "failed");
});

test("task propagates per-system sub-step failure status on retry reset", async () => {
  const { queue, calls, flags } = makeFakes({ llmwikiOk: false });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);
  const failed = queue.getTask(taskId)!;
  assert.equal(failed.stages.ingesting_llmwiki.status, "failed");
  // classify succeeded before the wiki call failed; the later steps were skipped.
  const before = new Map(failed.stages.ingesting_llmwiki.steps.map((s) => [s.name, s.status]));
  assert.equal(before.get("classify"), "done");
  assert.equal(before.get("write_page"), "failed");
  assert.equal(before.get("rebuild_index"), "failed");

  // Gate the re-run so the synchronous retry() reset is observable before run()
  // re-drives the stage.
  let release: () => void = () => {};
  flags.llmwikiGate = new Promise((r) => (release = r));
  flags.llmwikiOk = true;
  const retried = queue.retry(taskId);
  const reset = new Map(retried.stages.ingesting_llmwiki.steps.map((s) => [s.name, s.status]));
  assert.equal(reset.get("classify"), "pending");
  assert.equal(reset.get("write_page"), "pending");
  assert.equal(reset.get("rebuild_index"), "pending");

  release();
  await untilDone(queue, taskId);
  const task = queue.getTask(taskId)!;
  assert.equal(task.stages.ingesting_llmwiki.status, "done");
  for (const step of task.stages.ingesting_llmwiki.steps) {
    assert.equal(step.status, "done", `${step.name} done after retry`);
  }
  assert.equal(
    calls.filter((c) => c.kind === "ingest.llmwiki").length,
    2,
    "failed llm_wiki stage is re-run once",
  );
});

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
  // Top-level error surfaces the first failed stage's reason (not a generic message).
  assert.match(task.error ?? "", /LightRAG down/);
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

test("retry re-runs only the failed llm_wiki stage and keeps the done LightRAG stage", async () => {
  const { queue, calls, flags } = makeFakes({ llmwikiOk: false });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);
  let task = queue.getTask(taskId)!;
  assert.equal(task.status, "done");
  assert.equal(task.stages.ingesting_lightrag.status, "done");
  assert.equal(task.stages.ingesting_llmwiki.status, "failed");
  assert.equal(calls.filter((c) => c.kind === "ingest.lightrag").length, 1);

  flags.llmwikiOk = true;
  const retried = queue.retry(taskId);
  assert.equal(retried.id, taskId);

  await untilDone(queue, taskId);
  task = queue.getTask(taskId)!;
  assert.equal(task.stages.ingesting_llmwiki.status, "done");
  assert.equal(task.status, "done");
  assert.equal(calls.filter((c) => c.kind === "parser.parse").length, 1, "parse is not re-run");
  assert.equal(
    calls.filter((c) => c.kind === "ingest.lightrag").length,
    1,
    "successful LightRAG stage is not re-run",
  );
  assert.equal(
    calls.filter((c) => c.kind === "ingest.llmwiki").length,
    2,
    "failed llm_wiki stage is re-run once",
  );
});

test("retry re-runs parsing when parsing failed", async () => {
  const { queue, calls, flags } = makeFakes({ parseError: new Error("parse exploded") });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);
  assert.equal(queue.getTask(taskId)!.status, "failed");
  assert.equal(calls.filter((c) => c.kind === "parser.parse").length, 1);

  flags.parseError = undefined;
  queue.retry(taskId);
  await untilDone(queue, taskId);

  const task = queue.getTask(taskId)!;
  assert.equal(task.status, "done");
  assert.equal(task.stages.parsing.status, "done");
  assert.equal(task.stages.ingesting_lightrag.status, "done");
  assert.equal(task.stages.ingesting_llmwiki.status, "done");
  assert.equal(calls.filter((c) => c.kind === "parser.parse").length, 2);
  assert.equal(calls.filter((c) => c.kind === "ingest.lightrag").length, 1);
  assert.equal(calls.filter((c) => c.kind === "ingest.llmwiki").length, 1);
});

test("retry rejects a task that is still running", async () => {
  const { queue } = makeFakes({});
  const task = queue.createTask("x.pdf");
  (task as IngestTask).status = "ingesting";
  assert.throws(() => queue.retry(task.id), TaskBusyError);
});

test("retry rejects a task with no failed stages", async () => {
  const { queue } = makeFakes({});
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);
  assert.equal(queue.getTask(taskId)!.status, "done");
  assert.throws(() => queue.retry(taskId), NothingToRetryError);
});

test("retry throws TaskNotFoundError for an unknown task id", async () => {
  const { queue } = makeFakes({});
  assert.throws(() => queue.retry("nope"), TaskNotFoundError);
});

test("content duplicate skips both pipelines and marks the task done with a dedup notice", async () => {
  const { queue, calls } = makeFakes({
    dedup: { duplicate: true, method: "hash", existingSource: "wiki/a.md" },
  });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);

  const task = queue.getTask(taskId)!;
  assert.equal(task.status, "done");
  assert.equal(task.progress, 100);
  assert.deepEqual(task.dedup, {
    duplicate: true,
    method: "hash",
    existingSource: "wiki/a.md",
  });
  assert.equal(task.error, undefined);
  // parsing ran; neither ingest system was contacted
  assert.equal(task.stages.parsing.status, "done");
  assert.equal(
    calls.filter((c) => c.kind === "ingest.lightrag").length,
    0,
  );
  assert.equal(
    calls.filter((c) => c.kind === "ingest.llmwiki").length,
    0,
  );
});

test("non-duplicate content proceeds through the full pipeline", async () => {
  const { queue, calls } = makeFakes({
    dedup: { duplicate: false },
  });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);

  assert.equal(queue.getTask(taskId)!.status, "done");
  assert.deepEqual(
    calls.map((c) => c.kind),
    ["parser.parse", "ingest.lightrag", "ingest.llmwiki"],
  );
});

test("task records a LightRAG semantic near-duplicate notice when found", async () => {
  const { queue } = makeFakes({
    dedup: { duplicate: false },
    nearDuplicate: "sommerseminar-l-sen.pdf.md",
  });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);

  const task = queue.getTask(taskId)!;
  assert.equal(task.status, "done");
  assert.equal(task.nearDuplicate, "sommerseminar-l-sen.pdf.md");
  assert.equal(task.dedup, undefined);
});

test("task stays ingesting (not done) while LightRAG reports processing; chunk total surfaces", async () => {
  // Gate the poller's first sleep so the running mid-state is observable
  // before the fake backend flips to processed.
  let release: () => void = () => {};
  let sleepCalls = 0;
  const sleep = async () => {
    sleepCalls += 1;
    if (sleepCalls === 1) await new Promise<void>((r) => (release = r));
  };
  const { queue } = makeFakes({
    lightragTrack: { statuses: ["processing", "processed"], chunksCount: 182 },
    sleep,
  });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");

  await waitFor(() => queue.getTask(taskId)!.lightrag?.backendStatus === "processing");
  const mid = queue.getTask(taskId)!;
  assert.equal(mid.status, "ingesting", "task must not be done while LightRAG processes");
  assert.equal(mid.stages.ingesting_lightrag.status, "running");
  assert.equal(mid.stages.ingesting_lightrag.steps.find((s) => s.name === "chunking")!.status, "done", "chunking is done once the chunk total is known");
  assert.equal(mid.lightrag!.backendStatus, "processing");
  assert.equal(mid.lightrag!.chunksCount, 182);
  assert.equal(mid.lightrag!.chunksProcessed, 0);

  release();
  await untilDone(queue, taskId);
  const task = queue.getTask(taskId)!;
  assert.equal(task.status, "done");
  assert.equal(task.stages.ingesting_lightrag.status, "done");
  assert.equal(task.lightrag!.backendStatus, "processed");
  assert.equal(task.lightrag!.chunksCount, 182);
  assert.equal(task.lightrag!.chunksProcessed, 182);
});

test("chunk progress (N/M) is surfaced from the LightRAG pipeline log while processing", async () => {
  let release: () => void = () => {};
  let sleepCalls = 0;
  const sleep = async () => {
    sleepCalls += 1;
    if (sleepCalls === 1) await new Promise<void>((r) => (release = r));
  };
  const { queue } = makeFakes({
    lightragTrack: {
      statuses: ["processing", "processed"],
      chunksCount: 182,
      historyMessages: ["Indexing files", "Chunk 12 of 182 extracted 3 Ent + 2 Rel chunk-abc"],
    },
    sleep,
  });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");

  await waitFor(() => queue.getTask(taskId)!.lightrag?.chunksProcessed === 12);
  const mid = queue.getTask(taskId)!;
  assert.equal(mid.lightrag!.chunksProcessed, 12);
  assert.equal(mid.lightrag!.chunksCount, 182);

  release();
  await untilDone(queue, taskId);
  assert.equal(queue.getTask(taskId)!.lightrag!.chunksProcessed, 182);
});

test("task reflects the real LightRAG backend failure (stage failed, backend error surfaced)", async () => {
  const { queue } = makeFakes({
    lightragTrack: { statuses: ["failed"], errorMsg: "chunking exploded" },
  });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);

  const task = queue.getTask(taskId)!;
  assert.equal(task.stages.ingesting_lightrag.status, "failed");
  assert.equal(task.lightrag!.backendStatus, "failed");
  assert.match(task.stages.ingesting_lightrag.error ?? "", /chunking exploded/);
  // llm_wiki still ran; the task stays done but surfaces the failed stage reason.
  assert.equal(task.status, "done");
  assert.equal(task.stages.ingesting_llmwiki.status, "done");
  assert.match(task.error ?? "", /chunking exploded/);
});

test("no false done: LightRAG polling timeout marks the lightrag stage failed", async () => {
  const { queue } = makeFakes({
    lightragTrack: { statuses: ["processing"] },
    lightragWaitTimeoutMs: 30,
  });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);

  const task = queue.getTask(taskId)!;
  assert.equal(task.stages.ingesting_lightrag.status, "failed");
  assert.match(task.stages.ingesting_lightrag.error ?? "", /timed out/);
  assert.notEqual(task.stages.ingesting_lightrag.status, "done", "never falsely done");
  // llm_wiki is independent and still runs to completion.
  assert.equal(task.stages.ingesting_llmwiki.status, "done");
});

test("failed LightRAG submit is recorded as a failed stage without polling", async () => {
  const { queue, calls } = makeFakes({ lightragOk: false });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);

  const task = queue.getTask(taskId)!;
  assert.equal(task.stages.ingesting_lightrag.status, "failed");
  assert.match(task.stages.ingesting_lightrag.error ?? "", /LightRAG down/);
  assert.equal(
    calls.filter((c) => c.kind === "ingest.lightrag").length,
    1,
  );
});

test("retry re-runs a failed LightRAG stage and polls it to completion", async () => {
  const { queue, calls } = makeFakes({
    lightragTrack: { statuses: ["failed", "processed"], errorMsg: "transient" },
  });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);
  assert.equal(queue.getTask(taskId)!.stages.ingesting_lightrag.status, "failed");
  assert.equal(calls.filter((c) => c.kind === "ingest.lightrag").length, 1);

  // Second attempt succeeds at the backend.
  const retried = queue.retry(taskId);
  assert.notEqual(retried.stages.ingesting_lightrag.status, "failed", "retry resets the failed stage and re-drives it");
  await untilDone(queue, taskId);
  const task = queue.getTask(taskId)!;
  assert.equal(task.status, "done");
  assert.equal(task.stages.ingesting_lightrag.status, "done");
  assert.equal(task.lightrag!.backendStatus, "processed");
  assert.equal(calls.filter((c) => c.kind === "ingest.lightrag").length, 2, "failed stage re-run once");
});
