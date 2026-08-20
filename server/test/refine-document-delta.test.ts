import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RefinedDocument, RefinementPatch } from "../src/agents/refine-document.js";
import {
  ATHENA_MODEL,
  ATHENA_PROVIDER,
  EMIT_GLOBAL_REFINEMENT_TOOL,
  EMIT_HEADER_LEVELS_TOOL,
  buildRefinedDocument,
  createRefineDocumentTool,
} from "../src/agents/refine-document.js";
import { splitParagraphSemantic, applyPatches, type RefineOutputRef } from "../src/agents/refine-output.js";

/**
 * G4.S8.T1 — delta/extraction contract.
 *
 * The stage-2 per-section (and single-pass) LLM must NOT re-emit the full re-leveled markdown or full
 * chunk texts. It returns ONLY extraction fields + an optional `patches` array; Athena rebuilds the
 * markdown locally (apply stage-1 header levels + optional patches to the original md) and builds the
 * chunks locally with splitParagraphSemantic.
 */

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
  getModel?: () => unknown;
} = {}): { runtime: ModelRuntime; calls: FakeRuntimeCalls[] } {
  const calls: FakeRuntimeCalls[] = [];
  const runtime = {
    calls,
    getModel() {
      if (opts.getModel) return opts.getModel();
      return { id: ATHENA_MODEL, provider: ATHENA_PROVIDER };
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

function fakeStore(recorder: { stored?: RefinedDocument } = {}) {
  return async (doc: RefinedDocument, storageDir: string): Promise<RefineOutputRef> => {
    recorder.stored = doc;
    return {
      md_ref: `${storageDir}/doc.md`,
      chunks_ref: `${storageDir}/doc/chunks.json`,
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
      section_paths: [],
      mode: "single",
    };
  };
}

function parseResult<T>(result: { content: { type: string; text?: string }[] }): T {
  const text = (result.content[0] as { text: string }).text;
  return JSON.parse(text) as T;
}

// --- fixture: a large-ish section rebuilt locally + local semantic chunks ---

test("fixture: buildRefinedDocument rebuilds md_final locally (header-applied original + patch) and chunks locally", () => {
  // ~150k chars / 9000+ tokens of synthetic section, as paragraph-semantic blocks.
  const para = "x".repeat(12_000); // ~3000 tokens — each paragraph > the 1200-token chunk target
  const sectionMd = [
    "# Group Reporting",
    "## Overview",
    para,
    "## Methodology",
    para,
    "## Consolidation",
    para,
    "## Appendix",
    para,
  ].join("\n\n");

  // The LLM emits ONLY extraction + an optional patch (refactor the Methodology heading to h3).
  const patches: RefinementPatch[] = [{ op: "refactor_heading", index: 3, level: 3 }];
  const delta = {
    summary: "Group reporting process overview.",
    sections: [{ title: "Group Reporting", summary: "How group reporting works." }],
    frontmatter: { type: "report", topic: "sap/consolidation/group-reporting" },
    entities: [{ name: "SAP", type: "org", description: "ERP vendor" }],
    relations: [],
    keywords: ["group", "reporting", "consolidation"],
    quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
    patches,
  };
  const doc = buildRefinedDocument(sectionMd, delta);

  // Local rebuild = apply patches to the (already header-applied) original — zero re-generation.
  assert.equal(doc.markdown, applyPatches(sectionMd, patches));
  assert.match(doc.markdown, /^### Methodology$/m, "patch applied: Methodology re-leveled to h3");

  // Chunks built locally: one paragraph-semantic chunk per oversized paragraph.
  const expectedChunks = splitParagraphSemantic(applyPatches(sectionMd, patches));
  assert.equal(doc.chunks.length, expectedChunks.length, "chunks length == paragraph-semantic block count");
  assert.deepEqual(
    doc.chunks.map((c) => c.id),
    expectedChunks.map((c) => c.id),
  );
  assert.deepEqual(doc.chunks.map((c) => c.heading_path), expectedChunks.map((c) => c.heading_path));
  assert.ok(doc.chunks.every((c) => c.text.length > 0), "no empty chunk text");

  // Extraction fields flow through.
  assert.deepEqual(doc.frontmatter, { type: "report", topic: "sap/consolidation/group-reporting" });
  assert.equal(doc.entities[0].name, "SAP");
  assert.equal(doc.quality.action, "auto_accept");
});

// --- 8k-token output canary: the full stage-2 pipeline completes under an 8192 output budget ---

test("canary: two-stage pipeline succeeds when the LLM output is capped at 8192 tokens (delta-only, no truncation)", async () => {
  const md = "# Report\n\n" + Array.from({ length: 60 }, (_, i) => `## Section ${i}\n\n${"body ".repeat(4000)}\n`).join("\n");
  assert.ok(Buffer.byteLength(md, "utf8") > 1024 * 1024, "fixture exceeds 1MB so it takes the two-stage path");

  const recorder: { stored?: RefinedDocument } = {};
  const { runtime } = makeFakeRuntime({
    completeResultFor: (ctx) => {
      const tool = (ctx.tools as Array<{ name?: string }>)[0]?.name;
      if (tool === EMIT_HEADER_LEVELS_TOOL) {
        return {
          role: "assistant",
          content: [{ type: "toolCall", id: "h", name: EMIT_HEADER_LEVELS_TOOL, arguments: { levels: [{ index: 0, level: 1 }] } }],
          usage: zeroUsage,
          stopReason: "stop",
        };
      }
      if (tool === EMIT_GLOBAL_REFINEMENT_TOOL) {
        return {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "g",
              name: EMIT_GLOBAL_REFINEMENT_TOOL,
              arguments: {
                summary: "Final report summary.",
                sections: [{ title: "Report", summary: "S1." }],
                frontmatter: { type: "report", topic: "sap/consolidation/group-reporting" },
                entities: [],
                relations: [],
                keywords: ["report"],
                quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
              },
            },
          ],
          usage: zeroUsage,
          stopReason: "stop",
        };
      }
      // Stage-2 per-section: the LLM returns ONLY the small delta contract (extraction + optional patch).
      return {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "s",
            name: "emit_refined_document",
            arguments: {
              summary: "Section summary.",
              sections: [],
              frontmatter: { type: "report", topic: "sap/consolidation/group-reporting" },
              entities: [],
              relations: [],
              keywords: [],
              quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
            },
          },
        ],
        usage: zeroUsage,
        stopReason: "stop",
      };
    },
  });
  const tool = createRefineDocumentTool(runtime, {
    storageDir: "storage",
    storeImpl: fakeStore(recorder),
    globalMergeImpl: undefined,
  });

  const result = await tool.execute("c", { markdown: md }, undefined, undefined, {} as never);
  const details = result.details as { fallback?: boolean; error?: string };

  // No truncation class of failure: the small delta output fits any budget; chunks come from local rebuild.
  assert.equal(details.fallback, undefined, "no fallback under the small delta output budget");
  assert.ok(recorder.stored, "full document stored");
  assert.ok(recorder.stored!.chunks.length > 0, "chunks built LOCALLY (not 0-chunk truncation fallback)");
  assert.ok(recorder.stored!.markdown.length > 0, "markdown rebuilt locally");
});

// --- single-pass regression (event/internal/events + entity extraction stays green, delta contract) ---

test("regression: single-pass sub-1MB path uses the SAME delta contract and still extracts entities/type/topic", async () => {
  const recorder: { stored?: RefinedDocument } = {};
  const { runtime } = makeFakeRuntime({
    completeResultFor: () => ({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "s",
          name: "emit_refined_document",
          arguments: {
            // NOTE: NO markdown, NO chunks — delta contract only.
            summary: "CALEO's annual Sommerseminar.",
            sections: [{ title: "Sommerseminar", summary: "The annual CALEO event." }],
            frontmatter: { type: "event", topic: "internal/events" },
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

  const result = await tool.execute(
    "c",
    { markdown: "# Sommerseminar\n\n## Workshops\n\ndetails" },
    undefined,
    undefined,
    {} as never,
  );
  const ref = parseResult<RefineOutputRef>(result);
  const details = result.details as { fallback?: boolean };

  assert.equal(details.fallback, undefined, "delta single-pass succeeds (no fallback)");
  assert.deepEqual(ref.frontmatter, { type: "event", topic: "internal/events" });
  assert.equal(ref.entities[0].name, "CALEO");
  assert.equal(ref.summary, "CALEO's annual Sommerseminar.");
  assert.ok(ref.chunk_count > 0, "chunks built locally");
  assert.equal(recorder.stored!.markdown, "# Sommerseminar\n\n## Workshops\n\ndetails", "markdown rebuilt locally, verbatim");
});

// --- emit_refined_document schema no longer requires markdown/chunks ---

test("emit_refined_document tool schema carries the delta contract (no markdown/chunks)", async () => {
  const { runtime, calls } = makeFakeRuntime({
    completeResultFor: () => ({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "s",
          name: "emit_refined_document",
          arguments: {
            summary: "",
            sections: [],
            frontmatter: { type: "document", topic: "unclassified" },
            entities: [],
            relations: [],
            keywords: [],
            quality: { complete: true, confidence: 0.5, issues: [], action: "auto_accept" },
          },
        },
      ],
      usage: zeroUsage,
      stopReason: "stop",
    }),
  });
  const tool = createRefineDocumentTool(runtime, { storageDir: "storage", storeImpl: fakeStore() });
  await tool.execute("c", { markdown: "# D\n\nbody" }, undefined, undefined, {} as never);

  const ctx = calls[0].context!;
  const emit = (ctx.tools as Array<{ name?: string; parameters?: unknown }>).find(
    (t) => t.name === "emit_refined_document",
  );
  assert.ok(emit, "emit_refined_document tool present");
  const schema = JSON.parse(JSON.stringify(emit!.parameters)) as {
    properties?: { markdown?: unknown; chunks?: unknown; patches?: unknown };
  };
  assert.equal(schema.properties?.markdown, undefined, "markdown is ABSENT from the emit contract");
  assert.equal(schema.properties?.chunks, undefined, "chunks are ABSENT from the emit contract");
  assert.ok(schema.properties?.patches, "optional patches array present");
});
