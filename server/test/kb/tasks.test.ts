import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IngestTaskQueue,
  NothingToRetryError,
  TaskBusyError,
  TaskNotFoundError,
} from "../../src/kb/tasks.js";
import type { IngestTask } from "../../src/kb/tasks.js";

function makeFakes(opts: {
  markdown?: string;
  llmwikiOk?: boolean;
  parseError?: Error;
  refineError?: Error;
  refineQualityAction?: "auto_accept" | "review_required";
  refinedMarkdown?: string;
  /** File B (refined text-only, G4.S1.T6) — when set the refiner returns it separately. */
  ragMarkdown?: string;
  dedup?: {
    duplicate?: boolean;
    method?: "hash" | "chunks";
    existingSource?: string;
  };
  /** Extra refinement ref fields merged into the fake refiner's ref (e.g. md_ref/rag_md_ref). */
  ref?: Record<string, unknown>;
  /** Docling-extracted images dir returned by the fake parser (G3.S5.T5). */
  imagesDir?: string;
  /** When true, the queue is wired with a fake Neo4j store that records ingests. */
  neo4j?: boolean;
  /** Force the Neo4j ingest to fail (G4.S2.T4). */
  neo4jError?: Error;
} = {}) {
  const flags = {
    llmwikiOk: opts.llmwikiOk !== false,
    parseError: opts.parseError,
    refineError: opts.refineError,
    neo4jError: opts.neo4jError,
    /** Optional gate awaited by the llm_wiki fake so tests can observe the
     *  retry reset before the re-run re-drives the stage. */
    llmwikiGate: undefined as Promise<void> | undefined,
  };
  const calls: { kind: string; args: unknown[] }[] = [];
  const parser = {
    async parse(input: string) {
      calls.push({ kind: "parser.parse", args: [input] });
      if (flags.parseError) throw flags.parseError;
      return {
        markdown: opts.markdown ?? "# Doc",
        outputPath: "/shared/input/doc.md",
        stem: "doc",
        ...(opts.imagesDir ? { imagesDir: opts.imagesDir } : {}),
      };
    },
  };
  const refiner = async (markdown: string, topicHint?: string) => {
    calls.push({ kind: "refiner.refine", args: [markdown, topicHint] });
    if (flags.refineError) throw flags.refineError;
    return {
      ref: {
        md_ref: "/storage/doc/markdown.md",
        chunks_ref: "/storage/doc/chunks.json",
        preview: "preview",
        char_count: 1,
        line_count: 1,
        header_count: 1,
        chunk_count: 1,
        frontmatter: { type: "concept", topic: "sommerseminar" },
        entities: [{ name: "CALEO", type: "org", description: "an org" }],
        relations: [],
        keywords: ["sommerseminar"],
        quality: { complete: true, confidence: 0.9, issues: [], action: opts.refineQualityAction ?? "auto_accept" },
        summary: "CALEO's annual Sommerseminar.",
        sections: [{ title: "Sommerseminar", summary: "The annual CALEO event." }],
        mode: "single",
        section_paths: [],
        ...(opts.ref ?? {}),
      },
      markdown: opts.refinedMarkdown ?? "# Refined\n\nbody",
      ragMarkdown: opts.ragMarkdown ?? opts.refinedMarkdown ?? "# Refined\n\nbody",
    };
  };
  const ingest = {
    async prepareForIngest(input: { title: string; content: string }) {
      calls.push({ kind: "ingest.prepare", args: [input.title] });
      return {
        classification: { category: "concept", pagePath: "wiki/concepts/doc.md", topic: "sommerseminar" },
        frontmatterContent: `---\ntype: concept\ntitle: ${input.title}\ntopic: sommerseminar\n---\n\n${input.content}`,
      };
    },
    async ingestLlmWiki(fileName: string, markdown: string, onStep?: (step: string, status: "running" | "done") => void, preclassified?: unknown, images?: unknown, summary?: string) {
      calls.push({ kind: "ingest.llmwiki", args: [fileName, markdown, onStep, preclassified, images, summary] });
      if (flags.llmwikiGate) await flags.llmwikiGate;
      if (!onStep) return flags.llmwikiOk ? { ok: true } : { ok: false, error: "wiki down" };
      // classify is folded into refinement (G4.S1.T4): the preclassified result
      // from Athena is passed straight through — the llm_wiki stage is pure I/O.
      if (!preclassified) {
        onStep("classify", "running");
        onStep("classify", "done");
      }
      if (!flags.llmwikiOk) return { ok: false, error: "wiki down" };
      onStep("write_page", "running");
      onStep("write_page", "done");
      onStep("rebuild_index", "running");
      onStep("rebuild_index", "done");
      return { ok: true };
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
    refiner: refiner as never,
    dedup: dedup as never,
    ...(opts.neo4j
      ? {
          neo4j: {
            async ingest(input: { ref: unknown; documentId: string; title: string }) {
              calls.push({ kind: "neo4j.ingest", args: [input.documentId, input.title] });
              if (flags.neo4jError) throw flags.neo4jError;
              return { chunksStored: 2, entitiesStored: 1, relationsStored: 1 };
            },
          } as never,
        }
      : {}),
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

test("createTask seeds per-system sub-steps (docling/refinement/llm_wiki/neo4j) each pending", () => {
  const { queue } = makeFakes({});
  const task = queue.createTask("report.pdf");
  assert.equal(task.stages.parsing.status, "pending");
  assert.equal(task.stages.refinement.status, "pending");
  assert.equal(task.stages.ingesting_llmwiki.status, "pending");
  assert.equal(task.stages.ingesting_neo4j.status, "pending");

  // docling sub-steps
  assert.deepEqual(
    task.stages.parsing.steps.map((s) => [s.name, s.status]),
    [
      ["read_file", "pending"],
      ["parse_ocr_image_desc", "pending"],
    ],
  );
  // refinement sub-step (G4.S1.T4: the Athena single full-doc pass)
  assert.deepEqual(
    task.stages.refinement.steps.map((s) => [s.name, s.status]),
    [
      ["refine_document", "pending"],
    ],
  );
  // llm_wiki sub-steps (classify is folded into refinement, G4.S1.T4)
  assert.deepEqual(
    task.stages.ingesting_llmwiki.steps.map((s) => [s.name, s.status]),
    [
      ["write_page", "pending"],
      ["rebuild_index", "pending"],
    ],
  );
  // Neo4j sub-steps (G4.S2.T4)
  assert.deepEqual(
    task.stages.ingesting_neo4j.steps.map((s) => [s.name, s.status]),
    [
      ["embed_store", "pending"],
    ],
  );
});

test("successful ingest marks every per-system sub-step done", async () => {
  const { queue } = makeFakes({});
  const { taskId } = queue.submitFile("/tmp/report.pdf", "report.pdf");
  await untilDone(queue, taskId);
  const task = queue.getTask(taskId)!;
  assert.equal(task.status, "done");
  for (const stage of [task.stages.parsing, task.stages.refinement, task.stages.ingesting_llmwiki, task.stages.ingesting_neo4j]) {
    assert.equal(stage.status, "done");
    for (const step of stage.steps) {
      assert.equal(step.status, "done", `${stage.name}.${step.name} done`);
    }
  }
});

test("the Athena file summary flows from the refinement ref into the llm_wiki page write (G4.S2.T13)", async () => {
  const { queue, calls } = makeFakes({
    ref: { summary: "CALEO's annual Sommerseminar covers workshops and talks." },
  });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);

  const llmwiki = calls.find((c) => c.kind === "ingest.llmwiki");
  assert.ok(llmwiki, "llm_wiki ingest called");
  assert.equal(
    llmwiki!.args[5],
    "CALEO's annual Sommerseminar covers workshops and talks.",
    "refinement summary passed to the wiki page writer",
  );
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

test("llm_wiki failure marks only its sub-steps failed; write_page/rebuild_index failed (classify folded into refinement)", async () => {
  const { queue } = makeFakes({ llmwikiOk: false });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);
  const task = queue.getTask(taskId)!;
  assert.equal(task.stages.ingesting_llmwiki.status, "failed");
  const status = new Map(task.stages.ingesting_llmwiki.steps.map((s) => [s.name, s.status]));
  assert.equal(status.get("classify"), undefined, "classify is no longer a llm_wiki step (G4.S1.T4)");
  assert.equal(status.get("write_page"), "failed");
  assert.equal(status.get("rebuild_index"), "failed");
  assert.equal(task.stages.refinement.status, "done", "refinement ran before the llm_wiki failure");
});

test("refinement failure marks the stage failed but falls back to raw docling (never worse than today)", async () => {
  const { queue, calls } = makeFakes({ refineError: new Error("athena down") });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);

  const task = queue.getTask(taskId)!;
  // refinement fails but never blocks ingestion: raw docling markdown is used
  assert.equal(task.stages.refinement.status, "failed");
  assert.equal(task.status, "done");
  assert.equal(task.stages.ingesting_llmwiki.status, "done");

  const llmwiki = calls.find((c) => c.kind === "ingest.llmwiki");
  assert.equal(llmwiki!.args[1], "# Doc", "llm_wiki got the raw docling markdown");
});

test("quality.action=review_required is surfaced on the task for operator review (G4.S1.T5)", async () => {
  const { queue } = makeFakes({ refineQualityAction: "review_required" });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);

  const task = queue.getTask(taskId)!;
  assert.equal(task.status, "done");
  assert.equal(task.stages.refinement.status, "done");
  assert.equal(task.reviewRequired, true, "task flagged review_required");
  assert.equal(task.refinement?.quality.action, "review_required");
});

test("auto_accept refinement is NOT flagged review_required (G4.S1.T5)", async () => {
  const { queue } = makeFakes({});
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);

  const task = queue.getTask(taskId)!;
  assert.equal(task.status, "done");
  assert.equal(task.reviewRequired, undefined, "clean refinement has no review flag");
  assert.equal(task.refinement?.quality.action, "auto_accept");
});

test("two-file design: llm_wiki gets File A′ (image refs); File B working copy deleted after ingest (G4.S1.T6)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t6-"));
  const mdRef = join(dir, "markdown.md");
  const ragRef = join(dir, "rag.md");
  const fileAprime = "# Doc\n\n![Image](images/x.png)\n\nThe image displays a bright sky.\n\nbody";
  const fileB = "# Doc\n\nThe image displays a bright sky.\n\nbody";
  await writeFile(mdRef, fileAprime, "utf8");
  await writeFile(ragRef, fileB, "utf8");

  const { queue } = makeFakes({
    markdown: fileAprime,
    refinedMarkdown: fileAprime,
    ragMarkdown: fileB,
    ref: { md_ref: mdRef, rag_md_ref: ragRef },
  });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);

  const task = queue.getTask(taskId)!;
  assert.ok(task.refinedMarkdown?.includes("![Image](images/x.png)"), "llm_wiki (File A′) keeps the image refs");
  assert.equal(task.ragMarkdown, fileB, "task retains the in-memory File B for retry");
  assert.equal(existsSync(ragRef), false, "File B working copy deleted once ingestion is done");
  assert.equal(existsSync(mdRef), true, "File A′ durable artifact kept");
});

test("raw-docling fallback after refinement failure flags the task for operator review (G4.S1.T5)", async () => {
  const { queue } = makeFakes({ refineError: new Error("athena down") });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);

  const task = queue.getTask(taskId)!;
  assert.equal(task.stages.refinement.status, "failed");
  // never worse than today: raw docling markdown was used → operator must review
  assert.equal(task.reviewRequired, true, "fallback output flags review_required");
});

test("retry re-runs only the failed refinement stage on retry", async () => {
  const { queue, calls, flags } = makeFakes({ refineError: new Error("athena down") });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);
  let task = queue.getTask(taskId)!;
  assert.equal(task.stages.refinement.status, "failed");
  assert.equal(calls.filter((c) => c.kind === "refiner.refine").length, 1);
  assert.equal(calls.filter((c) => c.kind === "ingest.llmwiki").length, 1);

  flags.refineError = undefined;
  const retried = queue.retry(taskId);
  assert.notEqual(retried.stages.refinement.status, "failed", "retry resets the failed refinement stage");

  await untilDone(queue, taskId);
  task = queue.getTask(taskId)!;
  assert.equal(task.stages.refinement.status, "done");
  assert.equal(task.stages.ingesting_llmwiki.status, "done");
  assert.equal(calls.filter((c) => c.kind === "refiner.refine").length, 2, "refinement re-run once");
  assert.equal(calls.filter((c) => c.kind === "ingest.llmwiki").length, 1, "done ingest stage not re-run");
});

test("task propagates per-system sub-step failure status on retry reset", async () => {
  const { queue, calls, flags } = makeFakes({ llmwikiOk: false });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);
  const failed = queue.getTask(taskId)!;
  assert.equal(failed.stages.ingesting_llmwiki.status, "failed");
  // The llm_wiki stage is pure I/O (write_page/rebuild_index) — classify is
  // folded into the refinement stage (G4.S1.T4), which already succeeded.
  const before = new Map(failed.stages.ingesting_llmwiki.steps.map((s) => [s.name, s.status]));
  assert.equal(before.get("classify"), undefined);
  assert.equal(before.get("write_page"), "failed");
  assert.equal(before.get("rebuild_index"), "failed");
  assert.equal(failed.stages.refinement.status, "done");

  // Gate the re-run so the synchronous retry() reset is observable before run()
  // re-drives the stage.
  let release: () => void = () => {};
  flags.llmwikiGate = new Promise((r) => (release = r));
  flags.llmwikiOk = true;
  const retried = queue.retry(taskId);
  const reset = new Map(retried.stages.ingesting_llmwiki.steps.map((s) => [s.name, s.status]));
  assert.equal(reset.get("classify"), undefined);
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

test("submitFile runs parse → refine → llmwiki → neo4j and finishes done with full progress", async () => {
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
  assert.equal(task.stages.refinement.status, "done");
  assert.equal(task.stages.ingesting_llmwiki.status, "done");

  assert.deepEqual(
    calls.map((c) => c.kind),
    ["parser.parse", "refiner.refine", "ingest.llmwiki"],
  );
});

test("submitFile feeds llm_wiki the refined markdown + preclassified type/topic from Athena (G4.S1.T4)", async () => {
  const { queue, calls } = makeFakes({});
  const { taskId } = queue.submitFile("/tmp/report.pdf", "report.pdf");
  await untilDone(queue, taskId);
  assert.equal(queue.getTask(taskId)!.status, "done");

  // llm_wiki receives the refined markdown + the Athena preclassified result
  // (pure I/O write — no classify LLM call).
  const llmwiki = calls.find((c) => c.kind === "ingest.llmwiki");
  assert.ok(llmwiki, "llm_wiki is reached");
  assert.equal(llmwiki!.args[1], "# Refined\n\nbody");
  assert.deepEqual((llmwiki!.args[3] as { category: string; topic: string }).category, "concept");
});

test("submitFile flows Athena refinement output to the Neo4j store in parallel with llm_wiki (G4.S2.T4)", async () => {
  const { queue, calls } = makeFakes({ neo4j: true });
  const { taskId } = queue.submitFile("/tmp/report.pdf", "report.pdf");
  await untilDone(queue, taskId);

  const task = queue.getTask(taskId)!;
  assert.equal(task.status, "done");
  assert.equal(task.stages.ingesting_neo4j.status, "done");
  assert.equal(task.stages.ingesting_neo4j.steps.find((s) => s.name === "embed_store")!.status, "done");
  assert.equal(task.neo4jStored, true);

  // The Neo4j stage receives the Athena documentId + title (chunks/entities come
  // via the ref it carries).
  const neo4j = calls.find((c) => c.kind === "neo4j.ingest");
  assert.ok(neo4j, "Neo4j store is reached in parallel with llm_wiki");
  assert.equal(neo4j!.args[0], "doc");
  assert.equal(neo4j!.args[1], "Refined");
  // llm_wiki still runs in the same batch (parallel, not serialized).
  assert.ok(calls.some((c) => c.kind === "ingest.llmwiki"), "llm_wiki still reached in parallel");
});

test("Neo4j stage failure is per-system: task done if another system ok, stage failed (G4.S2.T4)", async () => {
  const { queue } = makeFakes({ neo4j: true, neo4jError: new Error("neo4j down") });
  const { taskId } = queue.submitFile("/tmp/report.pdf", "report.pdf");
  await untilDone(queue, taskId);

  const task = queue.getTask(taskId)!;
  assert.equal(task.status, "done", "llm_wiki succeeded → task done");
  assert.equal(task.stages.ingesting_neo4j.status, "failed");
  assert.match(task.stages.ingesting_neo4j.error ?? "", /neo4j down/);
  assert.equal(task.neo4jStored, undefined);
});

test("Neo4j stage is a no-op (done) without a wired store or refinement output (G4.S2.T4)", async () => {
  // No Neo4j store wired → stage marked done but not a real store write.
  const { queue, calls } = makeFakes({});
  const { taskId } = queue.submitFile("/tmp/report.pdf", "report.pdf");
  await untilDone(queue, taskId);

  const task = queue.getTask(taskId)!;
  assert.equal(task.status, "done");
  assert.equal(task.stages.ingesting_neo4j.status, "done");
  assert.equal(task.neo4jStored, undefined, "no real store write without a wired store");
  assert.equal(calls.filter((c) => c.kind === "neo4j.ingest").length, 0);

  // Refinement fails → no Athena output, nothing to store even with a wired store.
  const { queue: q2, calls: calls2 } = makeFakes({ neo4j: true, refineError: new Error("athena down") });
  const { taskId: id2 } = q2.submitFile("/tmp/report.pdf", "report.pdf");
  await untilDone(q2, id2);
  assert.equal(q2.getTask(id2)!.stages.ingesting_neo4j.status, "done");
  assert.equal(calls2.filter((c) => c.kind === "neo4j.ingest").length, 0, "no ingest without refinement output");
});

test("task still fails overall when all knowledge systems fail (llm_wiki + Neo4j)", async () => {
  const { queue } = makeFakes({ llmwikiOk: false, neo4j: true, neo4jError: new Error("neo4j down") });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);
  const task = queue.getTask(taskId)!;
  assert.equal(task.status, "failed");
});

test("submitUrl passes the URL straight to docling parsing", async () => {
  const { queue, calls } = makeFakes({});
  const { taskId } = queue.submitUrl("https://example.com/page");
  await untilDone(queue, taskId);
  assert.deepEqual(calls[0], { kind: "parser.parse", args: ["https://example.com/page"] });
});

test("task records per-system failure when llm_wiki fails but Neo4j ok", async () => {
  const { queue } = makeFakes({ llmwikiOk: false, neo4j: true });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);
  const task = queue.getTask(taskId)!;
  assert.equal(task.status, "done");
  assert.equal(task.stages.ingesting_llmwiki.status, "failed");
  assert.match(task.stages.ingesting_llmwiki.error ?? "", /wiki down/);
  assert.equal(task.stages.ingesting_neo4j.status, "done");
});

test("task fails overall when both llm_wiki and Neo4j fail", async () => {
  const { queue } = makeFakes({ llmwikiOk: false, neo4j: true, neo4jError: new Error("neo4j down") });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);
  const task = queue.getTask(taskId)!;
  assert.equal(task.status, "failed");
  assert.equal(task.stages.ingesting_llmwiki.status, "failed");
  // Top-level error surfaces the first failed stage's reason (not a generic message).
  assert.match(task.error ?? "", /wiki down/);
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

test("retry re-runs only the failed llm_wiki stage and keeps the done Neo4j stage", async () => {
  const { queue, calls, flags } = makeFakes({ llmwikiOk: false, neo4j: true });
  const { taskId } = queue.submitFile("/tmp/a.pdf", "a.pdf");
  await untilDone(queue, taskId);
  let task = queue.getTask(taskId)!;
  assert.equal(task.status, "done");
  assert.equal(task.stages.ingesting_llmwiki.status, "failed");
  assert.equal(calls.filter((c) => c.kind === "ingest.llmwiki").length, 1);

  flags.llmwikiOk = true;
  const retried = queue.retry(taskId);
  assert.equal(retried.id, taskId);

  await untilDone(queue, taskId);
  task = queue.getTask(taskId)!;
  assert.equal(task.stages.ingesting_llmwiki.status, "done");
  assert.equal(task.status, "done");
  assert.equal(calls.filter((c) => c.kind === "parser.parse").length, 1, "parse is not re-run");
  assert.equal(
    calls.filter((c) => c.kind === "ingest.llmwiki").length,
    2,
    "failed llm_wiki stage is re-run once",
  );
  assert.equal(calls.filter((c) => c.kind === "neo4j.ingest").length, 1, "done Neo4j stage not re-run");
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
  assert.equal(task.stages.ingesting_llmwiki.status, "done");
  assert.equal(calls.filter((c) => c.kind === "parser.parse").length, 2);
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

test("content duplicate skips the ingest pipeline and marks the task done with a dedup notice", async () => {
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
  // parsing ran; no ingest system was contacted
  assert.equal(task.stages.parsing.status, "done");
  assert.equal(calls.filter((c) => c.kind === "ingest.llmwiki").length, 0);
  assert.equal(calls.filter((c) => c.kind === "neo4j.ingest").length, 0);
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
    ["parser.parse", "refiner.refine", "ingest.llmwiki"],
  );
});

test("task passes docling-extracted images to the llm_wiki stage (G3.S5.T5)", async () => {
  const { queue, calls } = makeFakes({
    markdown: "# Doc\n\n![img](images/doc.pdf/image_x.png)",
    imagesDir: "/shared/input/images/doc.pdf",
  });
  const { taskId } = queue.submitFile("/tmp/doc.pdf", "doc.pdf");
  await untilDone(queue, taskId);
  const task = queue.getTask(taskId)!;
  assert.equal(task.status, "done");
  assert.deepEqual(task.images, {
    sourceDir: "/shared/input/images/doc.pdf",
    relativeDir: "images/doc.pdf",
  });
  const llmwiki = calls.find((c) => c.kind === "ingest.llmwiki");
  assert.deepEqual(llmwiki!.args[4], {
    sourceDir: "/shared/input/images/doc.pdf",
    relativeDir: "images/doc.pdf",
  });
});

test("retry of the llm_wiki stage still passes the stored images (G3.S5.T5)", async () => {
  const { queue, calls, flags } = makeFakes({
    markdown: "# Doc",
    imagesDir: "/shared/input/images/doc.pdf",
    llmwikiOk: false,
  });
  const { taskId } = queue.submitFile("/tmp/doc.pdf", "doc.pdf");
  await untilDone(queue, taskId);
  assert.equal(queue.getTask(taskId)!.stages.ingesting_llmwiki.status, "failed");

  flags.llmwikiOk = true;
  queue.retry(taskId);
  await untilDone(queue, taskId);
  assert.equal(queue.getTask(taskId)!.stages.ingesting_llmwiki.status, "done");
  const llmwikiCalls = calls.filter((c) => c.kind === "ingest.llmwiki");
  assert.equal(llmwikiCalls.length, 2);
  for (const c of llmwikiCalls) {
    assert.deepEqual(c.args[4], {
      sourceDir: "/shared/input/images/doc.pdf",
      relativeDir: "images/doc.pdf",
    });
  }
});
