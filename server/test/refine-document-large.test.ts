import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RefinedDocument, RefineLlmCaller } from "../src/agents/refine-document.js";
import {
  buildHeaderJudgePrompt,
  createRefineDocumentTool,
  EMIT_HEADER_LEVELS_TOOL,
  extractGlobalMerge,
  extractHeaderLevels,
  judgeHeaderLevelsLLM,
  refineLargeDocument,
} from "../src/agents/refine-document.js";
import {
  HEADER_RELEVEL_BATCH_SIZE,
  mergeRefinements,
  SECTION_MAX_BYTES_DEFAULT,
  sectionMaxBytes,
  splitByHeaders,
  splitByRefinedH1,
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

function makeCaller(opts: {
  completeResultFor?: (ctx: { systemPrompt?: string; userContent: string; schema?: unknown }) => unknown;
} = {}): { runtime: ModelRuntime; caller: RefineLlmCaller } {
  const caller: RefineLlmCaller = async (ctx) => {
    const message = opts.completeResultFor
      ? opts.completeResultFor(ctx)
      : { role: "assistant", content: [{ type: "text", text: "oops" }] };
    return { usage: zeroUsage, message: message as never };
  };
  return { runtime: {} as ModelRuntime, caller };
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
      summary: doc.summary,
      sections: doc.sections,
      section_paths: opts.section_paths ?? [],
      mode: opts.mode ?? "single",
    };
  };
}

function parseResult<T>(result: { content: { type: string; text?: string }[] }): T {
  const text = (result.content[0] as { text: string }).text;
  return JSON.parse(text) as T;
}

const sectionDoc = (heading: string, body: string): RefinedDocument => ({
  markdown: `# ${heading}\n\n${body}`,
  summary: `Summary of ${heading}.`,
  sections: [{ title: heading, summary: `Section summary of ${heading}.` }],
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
        return { blocks: blocks.map((b) => ({ ...b, level: 1 })), batches: 1, failedBatches: 0 };
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

// --- G4.S10.T5: large-document refinement hardening ---

test("refineLargeDocument P1: a failing section degrades ONLY itself — others refine, original markdown kept", async () => {
  const md = "# A\n\ngood content alpha\n\n# B\n\npoison\n\n# C\n\ngood content gamma";
  const refined: string[] = [];
  const result = await refineLargeDocument(md, {
    judgeHeaderLevels: async (blocks) => ({ blocks, batches: 1, failedBatches: 0 }),
    refineSection: async (section) => {
      if (section.heading_path === "B") throw new Error("assistant returned no structured output");
      refined.push(section.heading_path);
      return sectionDoc(section.heading_path, section.markdown);
    },
    globalMerge: async (refs) => mergeRefinements(refs),
  });

  // healthy sections still refined
  assert.deepEqual(refined, ["A", "C"]);
  // the failing section is reported by heading path
  assert.deepEqual(result.degradedSections, ["B"]);
  // document NEVER collapses: chunks from ok sections survive AND the degraded
  // section keeps its ORIGINAL markdown as mechanical chunks
  assert.ok(result.document.chunks.length >= 3);
  const chunkTexts = result.document.chunks.map((c) => c.text).join("\n");
  assert.match(chunkTexts, /good content alpha/);
  assert.match(chunkTexts, /good content gamma/);
  assert.match(chunkTexts, /poison/, "degraded section keeps its original text as a chunk");
  // honest gate: review_required with the degraded count in the issues
  assert.equal(result.document.quality.action, "review_required");
  assert.equal(result.document.quality.complete, false);
  assert.ok(
    result.document.quality.issues.some((i) => i.includes("1/3") && i.includes("B")),
    `quality issues must carry the degraded-section count, got: ${JSON.stringify(result.document.quality.issues)}`,
  );
});

test("refineLargeDocument P1: globalMerge failure falls back to deterministic concatenation", async () => {
  const md = "# A\n\ncontent a\n\n# B\n\ncontent b";
  let mergeAttempts = 0;
  const result = await refineLargeDocument(md, {
    judgeHeaderLevels: async (blocks) => ({ blocks, batches: 1, failedBatches: 0 }),
    refineSection: async (section) => sectionDoc(section.heading_path, section.markdown),
    globalMerge: async () => {
      mergeAttempts += 1;
      throw new Error("global merge LLM exploded");
    },
  });

  assert.equal(mergeAttempts, 1);
  assert.ok(result.document.chunks.length >= 2, "chunks survive via concat fallback");
  assert.match(result.document.markdown, /content a/);
  assert.match(result.document.markdown, /content b/);
  assert.deepEqual(result.degradedSections, []);
});

test("refineLargeDocument P1: ALL sections failing still yields chunks + review_required (no 0-chunk collapse)", async () => {
  const md = "# A\n\nalpha body\n\n# B\n\nbeta body";
  const result = await refineLargeDocument(md, {
    judgeHeaderLevels: async (blocks) => ({ blocks, batches: 1, failedBatches: 0 }),
    refineSection: async () => {
      throw new Error("assistant returned no structured output");
    },
    globalMerge: async (refs) => mergeRefinements(refs),
  });

  assert.deepEqual(result.degradedSections, ["A", "B"]);
  assert.ok(result.document.chunks.length >= 2, "original markdown becomes mechanical chunks");
  assert.match(result.document.chunks.map((c) => c.text).join("\n"), /alpha body/);
  assert.match(result.document.chunks.map((c) => c.text).join("\n"), /beta body/);
  assert.equal(result.document.quality.action, "review_required");
});

test("splitByRefinedH1 P5: flat docling output (single deep header level) descends h2..h6 before size cuts", () => {
  // GR-shaped degenerate case: ONE h1 title, real structure only at h5
  const md = [
    "# Group Reporting",
    ...Array.from({ length: 8 }, (_, i) => `##### Chapter ${i}\n\nchapter ${i} body`),
  ].join("\n\n");

  const sections = splitByRefinedH1(md);

  assert.ok(sections.length > 1, "must NOT return one giant section when deeper structure exists");
  // the lone h1 title becomes the leading block; chapters split at their real h5 boundaries
  assert.equal(sections[0].heading_path, "");
  assert.equal(sections[0].markdown, "# Group Reporting");
  assert.equal(sections[1].heading_path, "Chapter 0");
  assert.equal(sections.length, 9);
});

test("SECTION_MAX_BYTES default is 512KB and env-tunable (G4.S10.T5 P4)", async () => {
  assert.equal(SECTION_MAX_BYTES_DEFAULT, 512 * 1024);
  const previous = process.env.SECTION_MAX_BYTES;
  try {
    process.env.SECTION_MAX_BYTES = "262144";
    assert.equal(sectionMaxBytes(), 262144);
    delete process.env.SECTION_MAX_BYTES;
    assert.equal(sectionMaxBytes(), SECTION_MAX_BYTES_DEFAULT);
    process.env.SECTION_MAX_BYTES = "not-a-number";
    assert.equal(sectionMaxBytes(), SECTION_MAX_BYTES_DEFAULT);
  } finally {
    if (previous === undefined) delete process.env.SECTION_MAX_BYTES;
    else process.env.SECTION_MAX_BYTES = previous;
  }
});

test("judgeHeaderLevelsLLM re-levels header batches via the direct OpenRouter caller", async () => {
  const md = "# A\n\na\n\n# B\n\nb\n\n# C\n\nc\n\n# D\n\nd\n\n# E\n\ne";
  const { blocks } = splitByHeaders(md);
  assert.equal(blocks.length, 5);

  let calls = 0;
  const { caller } = makeCaller({
    completeResultFor: (ctx) => {
      calls += 1;
      // demote the LAST index of each batch (indices are absolute block positions in the prompt)
      const content = ctx.userContent;
      const indices = [...content.matchAll(/\[index (\d+)\]/g)].map((m) => Number(m[1]));
      return {
        role: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify({ levels: [{ index: indices[indices.length - 1], level: 2 }] }),
          },
        ],
        usage: zeroUsage,
        stopReason: "stop",
      };
    },
  });
  const corrected = await judgeHeaderLevelsLLM(caller, blocks, {
    headerBatchSize: 2,
  });

  assert.equal(corrected.blocks.length, 5);
  assert.equal(corrected.batches, 3, "ceil(5/2) = 3 batches dispatched");
  assert.equal(corrected.failedBatches, 0);
  assert.equal(corrected.blocks[0].level, 1, "index 0 not demoted");
  assert.equal(corrected.blocks[1].level, 2, "index 1 (batch 0 last) demoted to h2");
  assert.equal(corrected.blocks[2].level, 1, "index 2 not covered by the response keeps original level");
  assert.equal(corrected.blocks[3].level, 2, "index 3 (batch 1 last) demoted to h2");
  assert.equal(corrected.blocks[4].level, 2, "index 4 (batch 2 last) demoted to h2");
  // ceil(5/2) = 3 batches → 3 LLM calls
  assert.equal(calls, 3);
});

test("judgeHeaderLevelsLLM counts failed batches instead of silently swallowing them (G4.S10.T5 P3)", async () => {
  const md = "## A\n\na\n\n## B\n\nb\n\n## C\n\nc\n\n## D\n\nd";
  const { blocks } = splitByHeaders(md);

  let calls = 0;
  const { caller } = makeCaller({
    completeResultFor: (ctx) => {
      calls += 1;
      if (calls === 2) throw new Error("openrouter 502");
      const indices = [...ctx.userContent.matchAll(/\[index (\d+)\]/g)].map((m) => Number(m[1]));
      return {
        role: "assistant",
        content: [{ type: "text", text: JSON.stringify({ levels: [{ index: indices[0], level: 3 }] }) }],
        usage: zeroUsage,
        stopReason: "stop",
      };
    },
  });
  const result = await judgeHeaderLevelsLLM(caller, blocks, { headerBatchSize: 2 });

  assert.equal(result.batches, 2);
  assert.equal(result.failedBatches, 1, "the 502 batch is counted, not swallowed");
  assert.equal(result.blocks.length, 4);
  assert.equal(result.blocks[0].level, 3, "healthy batch still re-leveled");
  assert.equal(result.blocks[2].level, 2, "failed batch (index 2) keeps its ORIGINAL h2 level");
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

test("extractGlobalMerge returns the global frontmatter/entities/keywords/quality/summary/sections", () => {
  const g = extractGlobalMerge({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "t",
        name: "emit_global_refinement",
        arguments: {
          summary: "A consolidated report on SAP group reporting.",
          sections: [{ title: "Intro", summary: "About the report." }],
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
  assert.equal(g!.summary, "A consolidated report on SAP group reporting.");
  assert.deepEqual(g!.sections, [{ title: "Intro", summary: "About the report." }]);
});

test("refine_document routes a >1MB doc through the two-stage path and returns the small ref", async () => {
  const md = Array.from(
    { length: 60 },
    (_, i) => `## Section ${i}\n\n${"body ".repeat(4000)}${i === 59 ? "ENDMARKER-9a3c" : ""}\n`,
  ).join("\n");
  assert.ok(Buffer.byteLength(md, "utf8") > 1024 * 1024, "fixture must exceed 1MB");

  const recorder: { stored?: RefinedDocument } = {};
  const sectionsRefined: string[] = [];
  const tool = createRefineDocumentTool({} as ModelRuntime, {
    storageDir: "storage",
    storeImpl: fakeStore(recorder),
    judgeHeaderLevelsImpl: async (blocks) => ({
      blocks: blocks.map((b) => ({ ...b, level: b.index < 3 ? 1 : 2 })),
      batches: 1,
      failedBatches: 0,
    }),
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
  // sections 0-1 fit; section 2 (the rest of the 1.2MB doc) is hard-split under the
  // 512KB per-section budget (G4.S10.T5 P4): ceil(1.14MB / 512KB) = 3 parts
  assert.deepEqual(ref.section_paths, ["Section 0", "Section 1", "Section 2", "Section 2 (part 2)", "Section 2 (part 3)"]);
  assert.equal(ref.frontmatter.topic, "internal/events");
  assert.equal(sectionsRefined.length, 5);
  assert.ok(ref.preview.length < 1000, "only a short preview in context");
  // full merged markdown + all chunks land in storage, not in the returned ref
  assert.ok(recorder.stored, "full output stored to disk/storage");
  assert.equal(recorder.stored!.chunks.length, 5);
  assert.equal(recorder.stored!.summary, "Summary of Section 0.", "two-stage merge keeps a doc-level summary");
  assert.deepEqual(
    recorder.stored!.sections,
    [
      { title: "Section 0", summary: "Section summary of Section 0." },
      { title: "Section 1", summary: "Section summary of Section 1." },
      { title: "Section 2", summary: "Section summary of Section 2." },
      { title: "Section 2 (part 2)", summary: "Section summary of Section 2 (part 2)." },
      { title: "Section 2 (part 3)", summary: "Section summary of Section 2 (part 3)." },
    ],
    "two-stage merge keeps per-section summaries",
  );
  assert.ok(Buffer.byteLength(recorder.stored!.markdown, "utf8") > 1024 * 1024);
  assert.ok(!JSON.stringify(ref).includes("ENDMARKER-9a3c"), "full md body not in the returned ref");
});

test("refine_document single path stores the full output and returns the small ref (sub-1MB)", async () => {
  const recorder: { stored?: RefinedDocument } = {};
  const { caller } = makeCaller({
    completeResultFor: () => ({
      role: "assistant",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            markdown: "# Sommerseminar\n\n## Workshops\n\ndetails",
            summary: "CALEO's annual Sommerseminar.",
            sections: [{ title: "Sommerseminar", summary: "The annual CALEO event." }],
            frontmatter: { type: "event", topic: "internal/events" },
            chunks: [{ id: "c1", text: "details", heading_path: "Sommerseminar / Workshops" }],
            entities: [{ name: "CALEO", type: "org", description: "An organization" }],
            relations: [],
            keywords: ["sommerseminar"],
            quality: { complete: true, confidence: 0.85, issues: [], action: "auto_accept" },
          }),
        },
      ],
      usage: zeroUsage,
      stopReason: "stop",
    }),
  });
  const tool = createRefineDocumentTool({} as ModelRuntime, { httpCaller: caller, storageDir: "storage", storeImpl: fakeStore(recorder) });

  const result = await tool.execute("c", { markdown: "# Sommerseminar\n\n## Workshops\n\ndetails" }, undefined, undefined, {} as never);
  const ref = parseResult<RefineOutputRef>(result);

  assert.equal(ref.mode, "single");
  assert.deepEqual(ref.frontmatter, { type: "event", topic: "internal/events" });
  assert.equal(ref.summary, "CALEO's annual Sommerseminar.");
  assert.deepEqual(ref.sections, [{ title: "Sommerseminar", summary: "The annual CALEO event." }]);
  assert.equal(ref.chunk_count, 1);
  assert.equal(ref.entities[0].name, "CALEO");
  assert.equal(recorder.stored!.markdown, "# Sommerseminar\n\n## Workshops\n\ndetails");
  assert.equal(recorder.stored!.chunks.length, 1);
  // big-output: the returned ref is metadata + refs; the full markdown lives in storage only
  assert.ok(ref.md_ref.length > 0 && !("markdown" in ref), "ref carries md_ref, not the full markdown");
});

test("refine_document fallback stores the raw docling markdown and returns a review_required ref", async () => {
  const recorder: { stored?: RefinedDocument } = {};
  const tool = createRefineDocumentTool({} as ModelRuntime, {
    storageDir: "storage",
    storeImpl: fakeStore(recorder),
    judgeHeaderLevelsImpl: async (b) => b,
    refineSectionImpl: async () => {
      throw new Error("section failed");
    },
    globalMergeImpl: async (r) => mergeRefinements(r),
    httpCaller: async () => {
      throw new Error("openrouter 429 rate limited");
    },
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
