import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RefinedDocument } from "../src/agents/refine-document.js";
import {
  ATHENA_MODEL,
  ATHENA_PROVIDER,
  EMIT_HEADER_LEVELS_TOOL,
  buildHeaderJudgePrompt,
  createRefineDocumentTool,
  extractGlobalMerge,
  extractHeaderLevels,
  judgeHeaderLevelsLLM,
  refineLargeDocument,
} from "../src/agents/refine-document.js";
import {
  HEADER_RELEVEL_BATCH_SIZE,
  mergeRefinements,
  splitByHeaders,
  type RefineOutputRef,
  type RefinementMode,
} from "../src/agents/refine-output.js";

const zeroUsage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface FakeRuntimeCalls {
  providerId?: string;
  modelId?: string;
  options?: unknown;
  context?: { systemPrompt?: string; messages: unknown[]; tools: unknown[] };
}

function makeFakeRuntime(opts: {
  completeResultFor?: (ctx: { systemPrompt?: string; messages: unknown[]; tools: unknown[] }) => unknown;
} = {}): { runtime: ModelRuntime; calls: FakeRuntimeCalls[] } {
  const calls: FakeRuntimeCalls[] = [];
  const runtime = {
    calls,
    getModel(providerId: string, modelId: string) {
      return { id: modelId, provider: providerId };
    },
    async completeSimple(
      model: { provider: string; id: string },
      context: { systemPrompt?: string; messages: unknown[]; tools: unknown[] },
      options: unknown,
    ) {
      calls.push({ providerId: model.provider, modelId: model.id, options, context });
      if (opts.completeResultFor) return opts.completeResultFor(context);
      throw new Error("unexpected completeSimple call in test");
    },
  } as unknown as ModelRuntime;
  return { runtime, calls };
}

function fakeStore(recorder: { stored?: RefinedDocument; storageDir?: string } = {}) {
  return async (
    doc: RefinedDocument,
    storageDir: string,
    opts: { stem?: string; mode?: RefinementMode; sections?: string[] } = {},
  ): Promise<RefineOutputRef> => {
    recorder.stored = doc;
    recorder.storageDir = storageDir;
    return {
      md_ref: `${storageDir}/${opts.stem ?? "doc"}.md`,
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
      mode: opts.mode ?? "single",
      sections: opts.sections ?? [],
    };
  };
}

function parseResult<T>(result: { content: { type: string; text?: string }[] }): T {
  const text = (result.content[0] as { text: string }).text;
  return JSON.parse(text) as T;
}

const sectionDoc = (heading: string, body: string): RefinedDocument => ({
  markdown: `# ${heading}\n\n${body}`,
  frontmatter: { type: "document", topic: "t" },
  chunks: [{ id: "c1", text: body, heading_path: heading }],
  entities: [{ name: heading.toUpperCase(), type: "concept", description: heading }],
  relations: [],
  keywords: [heading.toLowerCase()],
  quality: { complete: true, confidence: 0.8, issues: [], action: "auto_accept" },
});

test("refineLargeDocument runs judge → split by refined h1 → per-section refine → global merge", async () => {
  const md = "## A\n\naa\n\n## B\n\nbb\n\n## C\n\ncc";
  const calls: string[] = [];
  const result = await refineLargeDocument(
    md,
    {
      judgeHeaderLevels: async (blocks) => {
        calls.push("judge");
        return blocks.map((b) => ({ ...b, level: 1 }));
      },
      refineSection: async (section) => {
        calls.push(`refine:${section.heading_path}`);
        return { ...sectionDoc(section.heading_path, section.markdown), markdown: section.markdown };
      },
      globalMerge: async (refinements) => {
        calls.push("merge");
        return mergeRefinements(refinements);
      },
    },
    "internal/events",
  );

  assert.deepEqual(calls, ["judge", "refine:A", "refine:B", "refine:C", "merge"]);
  assert.deepEqual(result.sections, ["A", "B", "C"]);
  // merged markdown reassembles the re-leveled doc
  assert.match(result.document.markdown, /^# A\n\naa\n\n# B\n\nbb\n\n# C\n\ncc$/);
  assert.equal(result.document.chunks.length, 3);
});

test("judgeHeaderLevelsLLM re-levels header batches via the emit_header_levels tool", async () => {
  const md = "# A\n\na\n\n# B\n\nb\n\n# C\n\nc\n\n# D\n\nd\n\n# E\n\ne";
  const { blocks } = splitByHeaders(md);
  assert.equal(blocks.length, 5);

  const { runtime, calls } = makeFakeRuntime({
    completeResultFor: (ctx) => {
      // demote the LAST index of each batch (indices are absolute block positions)
      const content = ctx.messages[0].content as string;
      const indices = [...content.matchAll(/\[index (\d+)\]/g)].map((m) => Number(m[1]));
      return {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t",
            name: EMIT_HEADER_LEVELS_TOOL,
            arguments: { levels: [{ index: indices[indices.length - 1], level: 2 }] },
          },
        ],
        usage: zeroUsage,
        stopReason: "stop",
      };
    },
  });
  const model = { id: ATHENA_MODEL, provider: ATHENA_PROVIDER } as never;
  const corrected = await judgeHeaderLevelsLLM(runtime as unknown as ModelRuntime, model, blocks, {
    headerBatchSize: 2,
  });

  assert.equal(corrected.length, 5);
  assert.equal(corrected[0].level, 1, "index 0 not demoted");
  assert.equal(corrected[1].level, 2, "index 1 (batch 0 last) demoted to h2");
  assert.equal(corrected[2].level, 1, "index 2 not covered by the response keeps original level");
  assert.equal(corrected[3].level, 2, "index 3 (batch 1 last) demoted to h2");
  assert.equal(corrected[4].level, 2, "index 4 (batch 2 last) demoted to h2");
  // ceil(5/2) = 3 batches → 3 LLM calls, each carrying the emit_header_levels tool
  assert.equal(calls.length, 3);
  const emitTools = calls.flatMap((c) => (c.context!.tools as Array<{ name?: string }>).map((t) => t.name));
  assert.equal(emitTools.filter((n) => n === EMIT_HEADER_LEVELS_TOOL).length, 3);
});

test("buildHeaderJudgePrompt includes header text + body excerpt per index", () => {
  const { blocks } = splitByHeaders("## A\n\nbody a\n\n## B\n\nbody b");
  const prompt = buildHeaderJudgePrompt(blocks);
  assert.match(prompt, /\[index 0\]/);
  assert.match(prompt, /Heading: "A"/);
  assert.match(prompt, /body a/);
  assert.match(prompt, /\[index 1\]/);
});

test("extractHeaderLevels parses emit tool args and plain-text JSON", () => {
  const fromTool = extractHeaderLevels({
    role: "assistant",
    content: [
      { type: "toolCall", id: "t", name: EMIT_HEADER_LEVELS_TOOL, arguments: { levels: [{ index: 0, level: 2 }, { index: 1, level: 3 }] } },
    ],
  });
  assert.equal(fromTool.get(0), 2);
  assert.equal(fromTool.get(1), 3);

  const fromText = extractHeaderLevels({
    role: "assistant",
    content: [{ type: "text", text: JSON.stringify({ levels: [{ index: 4, level: 1 }] }) }],
  });
  assert.equal(fromText.get(4), 1);

  const empty = extractHeaderLevels({ role: "assistant", content: [{ type: "text", text: "no json" }] });
  assert.equal(empty.size, 0);
});

test("extractGlobalMerge returns the global frontmatter/entities/keywords/quality", () => {
  const g = extractGlobalMerge({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "t",
        name: "emit_global_refinement",
        arguments: {
          frontmatter: { type: "report", topic: "sap/consolidation/group-reporting" },
          entities: [{ name: "CALEO", type: "org", description: "org" }],
          relations: [],
          keywords: ["group", "reporting"],
          quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
        },
      },
    ],
  });
  assert.ok(g);
  assert.deepEqual(g!.frontmatter, { type: "report", topic: "sap/consolidation/group-reporting" });
  assert.deepEqual(g!.keywords, ["group", "reporting"]);
});

test("refine_document routes a >1MB doc through the two-stage path and returns the small ref", async () => {
  const md = Array.from(
    { length: 60 },
    (_, i) => `## Section ${i}\n\n${"body ".repeat(4000)}${i === 59 ? "ENDMARKER-9a3c" : ""}\n`,
  ).join("\n");
  assert.ok(Buffer.byteLength(md, "utf8") > 1024 * 1024, "fixture must exceed 1MB");

  const recorder: { stored?: RefinedDocument } = {};
  const { runtime } = makeFakeRuntime();
  const sectionsRefined: string[] = [];
  const tool = createRefineDocumentTool(runtime, {
    storageDir: "storage",
    storeImpl: fakeStore(recorder),
    judgeHeaderLevelsImpl: async (blocks) => blocks.map((b) => ({ ...b, level: b.index < 3 ? 1 : 2 })),
    refineSectionImpl: async (section, hint) => {
      sectionsRefined.push(section.heading_path);
      return { ...sectionDoc(section.heading_path, section.markdown), frontmatter: { type: "document", topic: hint ?? "t" }, markdown: section.markdown };
    },
    globalMergeImpl: async (refinements) => mergeRefinements(refinements),
  });

  const result = await tool.execute(
    "c",
    { markdown: md, topic_hint: "internal/events" },
    undefined,
    undefined,
    {} as never,
  );
  const ref = parseResult<RefineOutputRef>(result);

  assert.equal(ref.mode, "two-stage");
  // sections 0-1 fit; section 2 (the rest of the 1.2MB doc) is hard-split under the 1MB budget
  assert.deepEqual(ref.sections, ["Section 0", "Section 1", "Section 2", "Section 2 (part 2)"]);
  assert.equal(ref.frontmatter.topic, "internal/events");
  assert.equal(sectionsRefined.length, 4);
  assert.ok(ref.preview.length < 1000, "only a short preview in context");
  // full merged markdown + all chunks land in storage, not in the returned ref
  assert.ok(recorder.stored, "full output stored to disk/storage");
  assert.equal(recorder.stored!.chunks.length, 4);
  assert.ok(Buffer.byteLength(recorder.stored!.markdown, "utf8") > 1024 * 1024);
  assert.ok(!JSON.stringify(ref).includes("ENDMARKER-9a3c"), "full md body not in the returned ref");
});

test("refine_document single path stores the full output and returns the small ref (sub-1MB)", async () => {
  const recorder: { stored?: RefinedDocument } = {};
  const { runtime } = makeFakeRuntime({
    completeResultFor: () => ({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "t",
          name: "emit_refined_document",
          arguments: {
            markdown: "# Sommerseminar\n\n## Workshops\n\ndetails",
            frontmatter: { type: "event", topic: "internal/events" },
            chunks: [{ id: "c1", text: "details", heading_path: "Sommerseminar / Workshops" }],
            entities: [{ name: "CALEO", type: "org", description: "An organization" }],
            relations: [],
            keywords: ["sommerseminar"],
            quality: { complete: true, confidence: 0.85, issues: [], action: "auto_accept" },
          },
        },
      ],
      usage: zeroUsage,
      stopReason: "stop",
    }),
  });
  const tool = createRefineDocumentTool(runtime, { storageDir: "storage", storeImpl: fakeStore(recorder) });

  const result = await tool.execute("c", { markdown: "# Sommerseminar\n\n## Workshops\n\ndetails" }, undefined, undefined, {} as never);
  const ref = parseResult<RefineOutputRef>(result);

  assert.equal(ref.mode, "single");
  assert.deepEqual(ref.frontmatter, { type: "event", topic: "internal/events" });
  assert.equal(ref.chunk_count, 1);
  assert.equal(ref.entities[0].name, "CALEO");
  assert.equal(recorder.stored!.markdown, "# Sommerseminar\n\n## Workshops\n\ndetails");
  assert.equal(recorder.stored!.chunks.length, 1);
  // big-output: the returned ref is metadata + refs; the full markdown lives in storage only
  assert.ok(ref.md_ref.length > 0 && !("markdown" in ref), "ref carries md_ref, not the full markdown");
});

test("refine_document fallback stores the raw docling markdown and returns a review_required ref", async () => {
  const recorder: { stored?: RefinedDocument } = {};
  const { runtime } = makeFakeRuntime({
    completeResultFor: () => {
      throw new Error("openrouter 429 rate limited");
    },
  });
  const tool = createRefineDocumentTool(runtime, {
    storageDir: "storage",
    storeImpl: fakeStore(recorder),
    judgeHeaderLevelsImpl: async (b) => b,
    refineSectionImpl: async () => {
      throw new Error("section failed");
    },
    globalMergeImpl: async (r) => mergeRefinements(r),
  });

  const result = await tool.execute(
    "c",
    { markdown: "# Raw\n\nbody", topic_hint: "internal/events" },
    undefined,
    undefined,
    {} as never,
  );
  const ref = parseResult<RefineOutputRef>(result);

  assert.equal(recorder.stored!.markdown, "# Raw\n\nbody");
  assert.deepEqual(ref.frontmatter, { type: "document", topic: "internal/events" });
  assert.equal(ref.quality.complete, false);
  assert.equal(ref.quality.action, "review_required");
  assert.ok(ref.quality.issues.length > 0);
});

test("HEADER_RELEVEL_BATCH_SIZE is within the 30-50 batching range", () => {
  assert.ok(HEADER_RELEVEL_BATCH_SIZE >= 30 && HEADER_RELEVEL_BATCH_SIZE <= 50);
});
