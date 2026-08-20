import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RefinedDocument, RefinementPatch, RefineLlmCaller } from "../src/agents/refine-document.js";
import {
  HEADER_LEVELS_SCHEMA,
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
  const { caller } = makeCaller({
    completeResultFor: (ctx) => {
      const isHeader = JSON.stringify(ctx.schema) === JSON.stringify(HEADER_LEVELS_SCHEMA);
      const user = ctx.userContent;
      if (isHeader) {
        return {
          role: "assistant",
          content: [{ type: "text", text: JSON.stringify({ levels: [{ index: 0, level: 1 }] }) }],
          usage: zeroUsage,
          stopReason: "stop",
        };
      }
      if (user.startsWith("The document was refined in")) {
        // global merge
        return {
          role: "assistant",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: "Final report summary.",
                sections: [{ title: "Report", summary: "S1." }],
                frontmatter: { type: "report", topic: "sap/consolidation/group-reporting" },
                entities: [],
                relations: [],
                keywords: ["report"],
                quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
              }),
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
            type: "text",
            text: JSON.stringify({
              summary: "Section summary.",
              sections: [],
              frontmatter: { type: "report", topic: "sap/consolidation/group-reporting" },
              entities: [],
              relations: [],
              keywords: [],
              quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
            }),
          },
        ],
        usage: zeroUsage,
        stopReason: "stop",
      };
    },
  });
  const tool = createRefineDocumentTool({} as ModelRuntime, {
    httpCaller: caller,
    storageDir: "storage",
    storeImpl: fakeStore(recorder),
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
  const { caller } = makeCaller({
    completeResultFor: () => ({
      role: "assistant",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            // NOTE: NO markdown, NO chunks — delta contract only.
            summary: "CALEO's annual Sommerseminar.",
            sections: [{ title: "Sommerseminar", summary: "The annual CALEO event." }],
            frontmatter: { type: "event", topic: "internal/events" },
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

test("emit_refined_document schema carries the delta contract (no markdown/chunks)", async () => {
  let sentSchema: unknown;
  const caller: RefineLlmCaller = async ({ schema }) => {
    sentSchema = schema;
    return {
      usage: zeroUsage,
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              summary: "",
              sections: [],
              frontmatter: { type: "document", topic: "unclassified" },
              entities: [],
              relations: [],
              keywords: [],
              quality: { complete: true, confidence: 0.5, issues: [], action: "auto_accept" },
            }),
          },
        ],
      },
    };
  };
  const tool = createRefineDocumentTool({} as ModelRuntime, { httpCaller: caller, storageDir: "storage", storeImpl: fakeStore() });
  await tool.execute("c", { markdown: "# D\n\nbody" }, undefined, undefined, {} as never);

  assert.ok(sentSchema, "the delta schema is passed to the caller");
  const schema = JSON.parse(JSON.stringify(sentSchema)) as {
    properties?: { markdown?: unknown; chunks?: unknown; patches?: unknown };
  };
  assert.equal(schema.properties?.markdown, undefined, "markdown is ABSENT from the emit contract");
  assert.equal(schema.properties?.chunks, undefined, "chunks are ABSENT from the emit contract");
  assert.ok(schema.properties?.patches, "optional patches array present");
});
