import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createRefineDocumentTool, HEADER_LEVELS_SCHEMA, type RefinedDocument, type RefineLlmCaller } from "../src/agents/refine-document.js";
import { storeRefinementOutput, type RefineOutputRef, type RefinementMode } from "../src/agents/refine-output.js";
import type { HeaderGradingReport, TocNode } from "../src/agents/header-toc.js";

const zeroUsage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface CallRecord {
  systemPrompt?: string;
  userContent: string;
  schema?: unknown;
}

function makeCaller(opts: {
  completeResultFor?: (ctx: { systemPrompt?: string; userContent: string; schema?: unknown }) => unknown;
}): { caller: RefineLlmCaller; calls: CallRecord[] } {
  const calls: CallRecord[] = [];
  const caller: RefineLlmCaller = async (ctx) => {
    calls.push({ systemPrompt: ctx.systemPrompt, userContent: ctx.userContent, schema: ctx.schema });
    const message = opts.completeResultFor
      ? opts.completeResultFor(ctx)
      : { role: "assistant", content: [{ type: "text", text: "oops" }] };
    return { usage: zeroUsage, message: message as never };
  };
  return { caller, calls };
}

function extractionDelta(overrides: Record<string, unknown> = {}) {
  return {
    summary: "Extraction summary.",
    sections: [{ title: "Chapter One", summary: "S1." }],
    frontmatter: { type: "manual", topic: "sap/cds" },
    entities: [],
    relations: [],
    keywords: ["cds"],
    quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
    ...overrides,
  };
}

function fakeStore() {
  const calls: Array<{ doc: RefinedDocument; storageDir: string; opts: Record<string, unknown> }> = [];
  const store = async (
    doc: RefinedDocument,
    storageDir: string,
    opts: { stem?: string; mode?: RefinementMode; section_paths?: string[]; headerGrading?: HeaderGradingReport } = {},
  ): Promise<RefineOutputRef> => {
    calls.push({ doc, storageDir, opts: { ...opts } });
    return {
      md_ref: `${storageDir}/${opts.stem ?? "doc"}.md`,
      rag_md_ref: `${storageDir}/${opts.stem ?? "doc"}.md`,
      chunks_ref: `${storageDir}/${opts.stem ?? "doc"}/chunks.json`,
      preview: doc.markdown.slice(0, 200),
      char_count: doc.markdown.length,
      line_count: doc.markdown.split("\n").length,
      header_count: 0,
      chunk_count: doc.chunks.length,
      frontmatter: doc.frontmatter,
      entities: doc.entities,
      relations: doc.relations,
      keywords: doc.keywords,
      quality: doc.quality,
      summary: doc.summary,
      sections: doc.sections,
      section_paths: opts.section_paths ?? [],
      mode: opts.mode ?? "single",
      ...(opts.headerGrading ? { header_grading: opts.headerGrading } : {}),
    };
  };
  return { store, calls };
}

function parseResult<T>(result: { content: { type: string; text?: string }[] }): T {
  const text = (result.content[0] as { text: string }).text;
  return JSON.parse(text) as T;
}

const isHeaderJudge = (ctx: { schema?: unknown }): boolean =>
  JSON.stringify(ctx.schema) === JSON.stringify(HEADER_LEVELS_SCHEMA);

// --- two-stage: external TOC → deterministic grading replaces the LLM judge ---

const TWO_STAGE_TOC: TocNode = {
  text: "",
  level: 0,
  children: [
    { text: "Chapter One", level: 1, children: [{ text: "Section A", level: 2, children: [] }] },
    { text: "Chapter Two", level: 1, children: [] },
  ],
};

function largeTwoStageMd(): string {
  const body = "lorem ipsum dolor sit amet ".repeat(20000);
  return ["## Chapter One", body, "## Section A", body, "## Chapter Two", body].join("\n\n");
}

test("two-stage with an external TOC: TOC hierarchy wins, LLM header judge never called, toc mode reported", async () => {
  const md = largeTwoStageMd();
  assert.ok(Buffer.byteLength(md, "utf8") > 1024 * 1024, "fixture exceeds 1MB so it takes the two-stage path");

  const { caller, calls } = makeCaller({
    completeResultFor: (ctx) => {
      if (isHeaderJudge(ctx)) {
        throw new Error("LLM header judge must NOT run when a TOC grades every section");
      }
      if (ctx.userContent.startsWith("The document was refined in")) {
        return {
          role: "assistant",
          content: [{ type: "text", text: JSON.stringify(extractionDelta()) }],
        };
      }
      return { role: "assistant", content: [{ type: "text", text: JSON.stringify(extractionDelta()) }] };
    },
  });
  const { store, calls: storeCalls } = fakeStore();
  const tool = createRefineDocumentTool({} as ModelRuntime, { httpCaller: caller, storageDir: "storage", storeImpl: store });

  const result = await tool.execute(
    "c",
    { markdown: md, toc: JSON.parse(JSON.stringify(TWO_STAGE_TOC.children)) },
    undefined,
    undefined,
    {} as never,
  );
  const ref = parseResult<RefineOutputRef>(result);
  const details = (result as { details?: Record<string, unknown> }).details;

  assert.deepEqual(details?.headerGrading, {
    mode: "toc",
    source: "external",
    tocMatched: 3,
    tocTotal: 3,
  });
  const stored = storeCalls[0]!.doc.markdown;
  assert.match(stored, /^# Chapter One$/m, "D4 → h1");
  assert.match(stored, /^## Section A$/m, "D5 → h2");
  assert.match(stored, /^# Chapter Two$/m);
  assert.equal(ref.header_grading?.mode, "toc", "header_grading rides the stored ref");
});

test("two-stage without any TOC: falls back unchanged to the LLM judge and reports mode llm", async () => {
  const md = largeTwoStageMd();
  const { caller, calls } = makeCaller({
    completeResultFor: (ctx) => {
      if (isHeaderJudge(ctx)) {
        return {
          role: "assistant",
          content: [{ type: "text", text: JSON.stringify({ levels: [{ index: 0, level: 1 }] }) }],
        };
      }
      return { role: "assistant", content: [{ type: "text", text: JSON.stringify(extractionDelta()) }] };
    },
  });
  const { store } = fakeStore();
  const tool = createRefineDocumentTool({} as ModelRuntime, { httpCaller: caller, storageDir: "storage", storeImpl: store });

  const result = await tool.execute("c", { markdown: md }, undefined, undefined, {} as never);
  const details = (result as { details?: Record<string, unknown> }).details;

  assert.ok(calls.some((c) => isHeaderJudge(c)), "LLM judge ran");
  assert.deepEqual(details?.headerGrading, { mode: "llm" });
});

// --- single-pass: markdown TOC preamble → deterministic post-pass, no LLM recovery ---

const PREAMBLE_MD = [
  "- [Chapter One](?c=1)",
  "  - [Section A](?c=1.1)",
  "  - [Section B](?c=1.2)",
  "- [Chapter Two](?c=2)",
  "",
  "## Chapter One",
  "",
  "body alpha",
  "",
  "## Section A",
  "",
  "body a",
  "",
  "## Section B",
  "",
  "body b",
  "",
  "## Chapter Two",
  "",
  "body two",
].join("\n");

test("single-pass with a markdown TOC preamble: re-levels deterministically, mode toc reported", async () => {
  const { caller, calls } = makeCaller({
    completeResultFor: (ctx) => {
      if (isHeaderJudge(ctx)) throw new Error("LLM header judge must NOT run in TOC mode");
      return { role: "assistant", content: [{ type: "text", text: JSON.stringify(extractionDelta()) }] };
    },
  });
  const { store, calls: storeCalls } = fakeStore();
  const tool = createRefineDocumentTool({} as ModelRuntime, { httpCaller: caller, storageDir: "storage", storeImpl: store });

  const result = await tool.execute("c", { markdown: PREAMBLE_MD }, undefined, undefined, {} as never);
  const details = (result as { details?: Record<string, unknown> }).details;

  assert.deepEqual(details?.headerGrading, {
    mode: "toc",
    source: "markdown-toc-preamble",
    tocMatched: 4,
    tocTotal: 4,
  });
  const stored = storeCalls[0]!.doc.markdown;
  assert.match(stored, /^# Chapter One$/m);
  assert.match(stored, /^## Section A$/m);
  assert.match(stored, /^## Section B$/m);
  assert.match(stored, /^# Chapter Two$/m);
  assert.match(stored, /^- \[Chapter One\]/, "preamble preserved");
  assert.equal(calls.length, 2, "main pass + audit only — the LLM flat-recovery did NOT run");
});

test("single-pass with a docling outline param: pdf-outline source grades the hierarchy", async () => {
  const md = [
    "## Chapter One",
    "",
    "body one",
    "",
    "## Sub One",
    "",
    "body sub",
  ].join("\n");
  const { caller } = makeCaller({
    completeResultFor: () => ({ role: "assistant", content: [{ type: "text", text: JSON.stringify(extractionDelta()) }] }),
  });
  const { store, calls: storeCalls } = fakeStore();
  const tool = createRefineDocumentTool({} as ModelRuntime, { httpCaller: caller, storageDir: "storage", storeImpl: store });

  const result = await tool.execute(
    "c",
    {
      markdown: md,
      outline: { text: "", level: 0, children: [{ text: "Chapter One", level: 1, children: [{ text: "Sub One", level: 2, children: [] }] }] },
    },
    undefined,
    undefined,
    {} as never,
  );
  const details = (result as { details?: Record<string, unknown> }).details;

  assert.equal((details?.headerGrading as HeaderGradingReport | undefined)?.mode, "toc");
  assert.equal((details?.headerGrading as HeaderGradingReport | undefined)?.source, "pdf-outline");
  assert.equal((details?.headerGrading as HeaderGradingReport | undefined)?.tocMatched, 2);
  assert.match(storeCalls[0]!.doc.markdown, /^# Chapter One$/m);
  assert.match(storeCalls[0]!.doc.markdown, /^## Sub One$/m);
});

test("single-pass without a TOC: no headerGrading reported, markdown unchanged (fallback regression)", async () => {
  const md = ["# Title", "", "## Section A", "", "body a", "", "### Sub Section", "", "body b"].join("\n");
  const { caller } = makeCaller({
    completeResultFor: () => ({ role: "assistant", content: [{ type: "text", text: JSON.stringify(extractionDelta()) }] }),
  });
  const { store, calls: storeCalls } = fakeStore();
  const tool = createRefineDocumentTool({} as ModelRuntime, { httpCaller: caller, storageDir: "storage", storeImpl: store });

  const result = await tool.execute("c", { markdown: md }, undefined, undefined, {} as never);
  const details = (result as { details?: Record<string, unknown> }).details;

  assert.equal(details?.headerGrading, undefined, "no grading report when no TOC and no recovery");
  assert.equal(storeCalls[0]!.doc.markdown, md, "markdown unchanged");
});

// --- the real store carries header_grading on the ref ---

test("storeRefinementOutput persists header_grading on the ref (real store)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "toc-refine-"));
  try {
    const doc: RefinedDocument = {
      markdown: "# Chapter One\n\nbody",
      summary: "s",
      sections: [],
      frontmatter: { type: "document", topic: "t" },
      chunks: [{ id: "c1", text: "body", heading_path: "Chapter One" }],
      entities: [],
      relations: [],
      keywords: [],
      quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
    };
    const ref = await storeRefinementOutput(doc, dir, {
      headerGrading: { mode: "toc", source: "markdown-toc-preamble", tocMatched: 2, tocTotal: 3 },
    });
    assert.deepEqual(ref.header_grading, { mode: "toc", source: "markdown-toc-preamble", tocMatched: 2, tocTotal: 3 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});