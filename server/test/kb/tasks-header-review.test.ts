/**
 * G4.S10.T7 — header review gate: pause/resume transitions in the ingest task
 * stage machine. Documents with enough headings land in `pending_header_review`
 * after parsing instead of auto-advancing to refinement; approve applies the
 * curated draft (idempotent header rewrite) then releases into refinement; skip
 * keeps the old behavior (straight to LLM grading). Tiny docs and disabled
 * projects bypass the gate entirely.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IngestTaskQueue,
  TaskNotFoundError,
  type IngestTask,
} from "../../src/kb/tasks.js";
import {
  HeaderReviewNotPendingError,
  applyOps,
  countCardChanges,
  rewriteMarkdown,
  type HeaderReviewSettingsStore,
} from "../../src/kb/header-review.js";

const MANY_HEADERS = [
  "# Intro",
  ...Array.from({ length: 40 }, (_, i) => `## Field ${i}\n\nBody of field ${i}.`),
  "# Appendix",
  "## Related Information\n\nLinks.",
].join("\n\n");

const TINY_DOC = "# Intro\n\n## Only Two\n\nBody.";

/** Fake settings store: enabled by default, injectable values. */
function settingsStore(over: Partial<{
  enabled: boolean;
  minHeaders: number;
  templateWords: string[];
}> = {}): HeaderReviewSettingsStore {
  let current = {
    enabled: over.enabled ?? true,
    minHeaders: over.minHeaders ?? 16,
    templateWords: over.templateWords ?? ["Purpose", "Prerequisites", "Related Information"],
  };
  return {
    async get() {
      return { ...current };
    },
    async update(patch) {
      current = { ...current, ...patch };
      return { ...current };
    },
  };
}

interface Fakes {
  queue: IngestTaskQueue;
  calls: { kind: string; args: unknown[] }[];
  /** Which markdown the refiner received last (if any). */
  refinedInputs: string[];
  settings: HeaderReviewSettingsStore;
}

function makeFakes(opts: {
  markdown?: string;
  outline?: unknown;
  settings?: HeaderReviewSettingsStore;
  draftDir?: string;
} = {}): Fakes {
  const calls: { kind: string; args: unknown[] }[] = [];
  const refinedInputs: string[] = [];
  const parser = {
    async parse(input: string) {
      calls.push({ kind: "parser.parse", args: [input] });
      return {
        markdown: opts.markdown ?? MANY_HEADERS,
        outputPath: "/shared/input/doc.md",
        stem: "doc",
        ...(opts.outline !== undefined ? { outline: opts.outline } : {}),
      };
    },
  };
  const refiner = async (markdown: string, _topicHint?: string, _fileName?: string, outline?: unknown) => {
    refinedInputs.push(markdown);
    calls.push({ kind: "refiner.refine", args: [markdown.slice(0, 40), outline] });
    return {
      ref: {
        md_ref: "/storage/doc/markdown.md",
        chunks_ref: "/storage/doc/chunks.json",
        preview: "preview",
        char_count: markdown.length,
        line_count: 1,
        header_count: 42,
        chunk_count: 1,
        frontmatter: { type: "concept", topic: "sommerseminar" },
        entities: [],
        relations: [],
        keywords: [],
        quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
        mode: "single",
        sections: [],
      },
      markdown: "# Refined\n\nbody",
      ragMarkdown: "# Refined\n\nbody",
    };
  };
  const ingest = {
    async prepareForIngest(input: { title: string; content: string }) {
      return {
        classification: { category: "concept", pagePath: "wiki/concepts/doc.md", topic: "sommerseminar" },
        frontmatterContent: `---\ntype: concept\ntitle: ${input.title}\ntopic: sommerseminar\n---\n\n${input.content}`,
      };
    },
    async ingestLlmWiki() {
      calls.push({ kind: "ingest.llmwiki" });
      return { ok: true };
    },
  };
  const settings = opts.settings ?? settingsStore();
  const queue = new IngestTaskQueue({
    parser: parser as never,
    ingest: ingest as never,
    refiner: refiner as never,
    headerReview: {
      settings,
      draftDir: opts.draftDir,
    },
  });
  return { queue, calls, refinedInputs, settings };
}

async function untilStatus(queue: IngestTaskQueue, id: string, status: string): Promise<IngestTask> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const task = queue.getTask(id)!;
    if (task.status === status || task.status === "failed") return task;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`task did not reach ${status} in time (got ${queue.getTask(id)?.status})`);
}

test("gate enabled + enough headers → task pauses in header_review, refinement NOT run", async () => {
  const { queue, refinedInputs } = makeFakes();
  const { taskId } = queue.submitFile("/tmp/doc.pdf", "doc.pdf");
  const task = await untilStatus(queue, taskId, "header_review");
  assert.equal(task.status, "header_review");
  assert.equal(task.headerReview?.state, "pending");
  assert.equal(task.stages.parsing.status, "done");
  assert.equal(task.stages.refinement.status, "pending");
  assert.equal(refinedInputs.length, 0, "refiner NOT called while paused");
  assert.equal(task.headerReviewOutline?.headingCount, 43);
});

test("tiny document auto-skips the gate (refinement runs immediately)", async () => {
  const { queue, refinedInputs } = makeFakes({ markdown: TINY_DOC });
  const { taskId } = queue.submitFile("/tmp/doc.pdf", "doc.pdf");
  await untilStatus(queue, taskId, "done");
  assert.equal(refinedInputs.length, 1, "refiner ran without a pause");
});

test("disabled project flag skips the gate entirely", async () => {
  const { queue, refinedInputs } = makeFakes({ settings: settingsStore({ enabled: false }) });
  const { taskId } = queue.submitFile("/tmp/doc.pdf", "doc.pdf");
  await untilStatus(queue, taskId, "done");
  assert.equal(refinedInputs.length, 1);
});

test("skip keeps old behavior: refinement runs on the ORIGINAL markdown", async () => {
  const { queue, refinedInputs } = makeFakes();
  const { taskId } = queue.submitFile("/tmp/doc.pdf", "doc.pdf");
  const paused = await untilStatus(queue, taskId, "header_review");
  const original = queue.getTask(taskId)!.markdown!;
  const outline = queue.getHeaderReviewOutline(taskId);
  assert.equal(outline.headingCount, 43);
  assert.equal(outline.draft, null, "no draft yet");
  void queue.skipHeaderReview(taskId);
  await untilStatus(queue, taskId, "done");
  assert.equal(refinedInputs[0], original);
  assert.equal(queue.getTask(taskId)?.headerReview?.state, "skipped");
  assert.equal(queue.getTask(taskId)?.headerReview?.edits, undefined);
  assert.ok(paused.headerReview?.pausedAt);
});

test("approve applies the draft idempotently, then releases into refinement with the corrected markdown", async () => {
  const { queue, refinedInputs } = makeFakes();
  const { taskId } = queue.submitFile("/tmp/doc.pdf", "doc.pdf");
  await untilStatus(queue, taskId, "header_review");
  const original = queue.getTask(taskId)!.markdown!;
  const outline = queue.getHeaderReviewOutline(taskId);
  // draft: demote "Appendix" under "Intro" and demote "Related Information" to bold
  const appendix = outline.cards.find((c) => c.text === "Appendix")!;
  const rela = outline.cards.find((c) => c.text === "Related Information")!;
  const draft = await queue.putHeaderReviewDraft(taskId, [
    { type: "move", index: appendix.index, parentId: outline.cards[0]!.id, position: 0 },
    { type: "bold", index: rela.index },
  ]);
  // structural badge: the bolded card + the re-parented card = 2
  assert.equal(draft.changes, 2);
  // approve
  void queue.approveHeaderReview(taskId, "hartmut");
  await untilStatus(queue, taskId, "done");
  const task = queue.getTask(taskId)!;
  assert.equal(task.headerReview?.state, "approved");
  assert.equal(task.headerReview?.who, "hartmut");
  assert.equal(task.headerReview?.edits?.ops, 2);
  assert.ok(task.headerReview?.durationMs !== undefined);
  // refiner received the CORRECTED markdown (Appendix now inside Intro; Related Info bold)
  const corrected = refinedInputs[0] ?? "";
  assert.notEqual(corrected, original);
  assert.match(corrected, /## Appendix/);
  assert.match(corrected, /\*\*Related Information\*\*/);
  // the approved outline replaced the raw docling outline → TOC-first grading uses the curated tree
  const refineCall = queue.getTask(taskId)!;
  assert.ok(refineCall.outline, "curated TocNode exported to the refiner outline slot");
  // idempotency: reapplying the draft produces the same markdown bytes
  const again = rewriteMarkdown(original, applyOps(outline.cards, draft.ops));
  assert.equal(again.markdown, corrected);
});

test("approve with a pending-header draft persists the draft JSON sidecar", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hr-review-"));
  try {
    const { queue } = makeFakes({ draftDir: dir });
    const { taskId } = queue.submitFile("/tmp/doc.pdf", "doc.pdf");
    await untilStatus(queue, taskId, "header_review");
    const outline = queue.getHeaderReviewOutline(taskId);
    const rela = outline.cards.find((c) => c.text === "Related Information")!;
    await queue.putHeaderReviewDraft(taskId, [{ type: "bold", index: rela.index }]);
    const sidecar = join(dir, `${taskId}.json`);
    const persisted = JSON.parse(await readFile(sidecar, "utf8"));
    assert.equal(persisted.ops.length, 1);
    assert.equal(persisted.ops[0].type, "bold");
    // approving prunes the sidecar (the work is baked into the markdown)
    void queue.approveHeaderReview(taskId, "alice");
    await untilStatus(queue, taskId, "done");
    await assert.rejects(readFile(sidecar, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("approve/skip on a non-paused task is rejected", async () => {
  const { queue } = makeFakes({ markdown: TINY_DOC });
  const { taskId } = queue.submitFile("/tmp/doc.pdf", "doc.pdf");
  await untilStatus(queue, taskId, "done");
  const done = queue.getTask(taskId)!;
  assert.equal(done.headerReview, undefined);
  await assert.rejects(queue.approveHeaderReview(taskId, "x"), HeaderReviewNotPendingError);
  await assert.rejects(queue.skipHeaderReview(taskId), HeaderReviewNotPendingError);
});

test("approving twice is rejected; the second release cannot re-pause", async () => {
  const { queue } = makeFakes();
  const { taskId } = queue.submitFile("/tmp/doc.pdf", "doc.pdf");
  await untilStatus(queue, taskId, "header_review");
  void queue.skipHeaderReview(taskId);
  await untilStatus(queue, taskId, "done");
  await assert.rejects(queue.approveHeaderReview(taskId, "x"), HeaderReviewNotPendingError);
});

test("unknown task errors for the header-review endpoints", async () => {
  const { queue } = makeFakes();
  assert.throws(() => queue.getHeaderReviewOutline("nope"), TaskNotFoundError);
  await assert.rejects(queue.putHeaderReviewDraft("nope", []), TaskNotFoundError);
});

test("draft edits are validated against the payload contract (bad index / cycles)", async () => {
  const { queue } = makeFakes();
  const { taskId } = queue.submitFile("/tmp/doc.pdf", "doc.pdf");
  await untilStatus(queue, taskId, "header_review");
  const outline = queue.getHeaderReviewOutline(taskId);
  const appendix = outline.cards.find((c) => c.text === "Appendix")!;
  const rela = outline.cards.find((c) => c.text === "Related Information")!;
  await assert.rejects(
    queue.putHeaderReviewDraft(taskId, [{ type: "move", index: 9999, parentId: null, position: 0 }]),
  );
  // moving "Appendix" under its own descendant "Related Information" → cycle
  await assert.rejects(
    queue.putHeaderReviewDraft(taskId, [{ type: "move", index: appendix.index, parentId: rela.id, position: 0 }]),
  );
});

test("approved outline cards feed a TOC-first refiner outline (curated tree wins)", async () => {
  const { queue } = makeFakes();
  const { taskId } = queue.submitFile("/tmp/doc.pdf", "doc.pdf");
  await untilStatus(queue, taskId, "header_review");
  const outline = queue.getHeaderReviewOutline(taskId);
  const rela = outline.cards.find((c) => c.text === "Related Information")!;
  await queue.putHeaderReviewDraft(taskId, [{ type: "promote", index: rela.index }]);
  void queue.approveHeaderReview(taskId, "alice");
  await untilStatus(queue, taskId, "done");
  const toc = queue.getTask(taskId)!.outline as {
    level: number;
    children?: Array<{ text: string; children?: Array<{ text: string }> }>;
  };
  assert.equal(toc.level, 0);
  assert.ok(toc.children?.some((c) => c.text === "Intro"));
  assert.ok(toc.children?.some((c) => c.text === "Related Information"), "promoted to root level");
  const appendix = toc.children?.find((c) => c.text === "Appendix");
  assert.ok(appendix);
  assert.ok(!appendix.children?.some((c) => c.text === "Related Information"), "no longer under Appendix");
});