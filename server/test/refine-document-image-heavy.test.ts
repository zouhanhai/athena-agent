import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RefinedDocument } from "../src/agents/refine-document.js";
import { createRefineDocumentTool, extractRefinedDocument } from "../src/agents/refine-document.js";
import { hasImageRefs, stripImageRefs, syncRefinedHeadersToSource } from "../src/agents/refine-output.js";
import type { RefineOutputRef, RefinementMode } from "../src/agents/refine-output.js";

/**
 * G4.S1.T6 fixture — a complex/image-heavy docling markdown exactly like the
 * observed `Infos_Sommerseminar_2026.pdf`: flat docling h2 headers, `![Image](images/...)`
 * reference lines, and qwen VLM descriptions as following plain-text paragraphs.
 */
const IMAGE_HEAVY_MD = `# Infos Sommerseminar 2026

## Willkommen

![Image](images/image_1.jpeg)

The image displays a bright welcome banner with the CALEO logo and the headline "Sommerseminar 2026".

Willkommen zum Sommerseminar 2026 der CALEO.

## Programm

![Image](images/image_2.jpeg)

The image displays a bright sky scene with the program schedule.

Freitag: SAP Group Reporting Workshop, geleitet von John Müller.

## Workshops

![Image](images/image_3.jpeg)

The image displays an aerial photograph of the campus.

Die Workshops finden im Hörsaal statt.`;

/** The refined output the LLM pass is EXPECTED to produce: re-leveled headers, NO image refs. */
const REFINED_DOC: RefinedDocument = {
  markdown: `# Infos Sommerseminar 2026

## Willkommen

The image displays a bright welcome banner with the CALEO logo and the headline "Sommerseminar 2026".

Willkommen zum Sommerseminar 2026 der CALEO.

## Programm

The image displays a bright sky scene with the program schedule.

Freitag: SAP Group Reporting Workshop, geleitet von John Müller.

## Workshops

The image displays an aerial photograph of the campus.

Die Workshops finden im Hörsaal statt.`,
  frontmatter: { type: "event", topic: "internal/events" },
  chunks: [
    { id: "c1", text: "Willkommen zum Sommerseminar 2026 der CALEO.", heading_path: "Infos Sommerseminar 2026 / Willkommen" },
    { id: "c2", text: "Freitag: SAP Group Reporting Workshop, geleitet von John Müller.", heading_path: "Infos Sommerseminar 2026 / Programm" },
  ],
  entities: [
    { name: "CALEO", type: "org", description: "The department hosting the event" },
    { name: "John", type: "person", description: "Workshop lecturer" },
    { name: "SAP Group Reporting", type: "product", description: "Workshop topic" },
  ],
  relations: [
    {
      source: "CALEO",
      target: "Sommerseminar",
      keywords: ["hosts"],
      description: "CALEO hosts the Sommerseminar.",
    },
  ],
  keywords: ["sommerseminar", "workshop", "campus"],
  quality: { complete: true, confidence: 0.85, issues: [], action: "auto_accept" },
};

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
  missingModel?: boolean;
  completeResultFor?: (ctx: { systemPrompt?: string; messages: unknown[]; tools: unknown[] }) => unknown;
} = {}): { runtime: ModelRuntime; calls: FakeRuntimeCalls[] } {
  const calls: FakeRuntimeCalls[] = [];
  const runtime = {
    calls,
    getModel(providerId: string, modelId: string) {
      return opts.missingModel ? undefined : { id: modelId, provider: providerId };
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

interface FakeStoreRecorder {
  stored?: RefinedDocument;
  ragMarkdown?: string;
  storageDir?: string;
}

/** Fake big-output store mirroring the real two-file store: records File A′ + File B. */
function fakeStore(recorder: FakeStoreRecorder = {}) {
  return async (
    doc: RefinedDocument,
    storageDir: string,
    opts: { stem?: string; mode?: RefinementMode; sections?: string[]; ragMarkdown?: string } = {},
  ): Promise<RefineOutputRef> => {
    recorder.stored = doc;
    recorder.ragMarkdown = opts.ragMarkdown;
    recorder.storageDir = storageDir;
    const mdPath = `${storageDir}/${opts.stem ?? "doc"}/markdown.md`;
    const ragPath = opts.ragMarkdown && opts.ragMarkdown !== doc.markdown ? `${storageDir}/${opts.stem ?? "doc"}/rag.md` : mdPath;
    return {
      md_ref: mdPath,
      rag_md_ref: ragPath,
      chunks_ref: `${storageDir}/${opts.stem ?? "doc"}/chunks.json`,
      preview: doc.markdown.slice(0, 200) + (doc.markdown.length > 200 ? "…" : ""),
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

// --- stripImageRefs / hasImageRefs ---

test("stripImageRefs removes ![Image](...) lines but keeps the VLM description text", () => {
  assert.equal(hasImageRefs(IMAGE_HEAVY_MD), true);
  assert.equal(hasImageRefs(REFINED_DOC.markdown), false);

  const stripped = stripImageRefs(IMAGE_HEAVY_MD);
  assert.ok(!stripped.includes("![Image]"), "image-ref lines are gone");
  assert.ok(stripped.includes("The image displays a bright welcome banner"), "VLM description kept");
  assert.ok(stripped.includes("Willkommen zum Sommerseminar 2026 der CALEO."), "body kept");
  assert.ok(stripped.includes("## Willkommen"), "headers kept");

  // a doc with no image refs is returned unchanged
  const plain = "# Doc\n\nbody";
  assert.equal(stripImageRefs(plain), plain);
});

test("syncRefinedHeadersToSource applies the refined header levels back onto the source keeping image refs", () => {
  const source = `## Infos Sommerseminar 2026

## Willkommen

![Image](images/image_1.jpeg)

The image displays a bright welcome banner.

body`;
  const refined = `# Infos Sommerseminar 2026

## Willkommen

The image displays a bright welcome banner.

body`;

  const synced = syncRefinedHeadersToSource(source, refined);

  assert.match(synced, /^# Infos Sommerseminar 2026/);
  assert.match(synced, /^## Willkommen$/m);
  assert.ok(synced.includes("![Image](images/image_1.jpeg)"), "image ref kept in File A′");
  assert.ok(synced.includes("The image displays a bright welcome banner."), "VLM description kept");

  // source with no headers stays untouched
  assert.equal(syncRefinedHeadersToSource("plain text", "# Title\n\nbody"), "plain text");
});

// --- tool end-to-end: image-heavy fixture → structured output (not fallback) + two-file sync ---

test("refine_document returns structured output (not fallback) on image-heavy md and feeds the LLM the stripped File B", async () => {
  const recorder: FakeStoreRecorder = {};
  const { runtime, calls } = makeFakeRuntime({
    completeResultFor: () => ({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "t1",
          name: "emit_refined_document",
          arguments: REFINED_DOC,
        },
      ],
      usage: zeroUsage,
      stopReason: "stop",
    }),
  });
  const tool = createRefineDocumentTool(runtime, { storageDir: "storage", storeImpl: fakeStore(recorder) });

  const result = await tool.execute("c", { markdown: IMAGE_HEAVY_MD }, undefined, undefined, {} as never);
  const ref = parseResult<RefineOutputRef>(result);
  const details = result.details as { fallback?: boolean; imageRefsStripped?: boolean };

  // structured output, NOT the fallback (type=document / entities=0 / keywords=0)
  assert.equal(details.fallback, undefined);
  assert.equal(ref.frontmatter.type, "event");
  assert.equal(ref.frontmatter.topic, "internal/events");
  assert.equal(ref.entities.length, 3);
  assert.equal(ref.keywords.length, 3);
  assert.equal(ref.chunk_count, 2);
  assert.equal(ref.quality.action, "auto_accept");
  assert.equal(details.imageRefsStripped, true, "reports image refs were stripped");

  // the LLM pass read File B: image refs stripped, VLM descriptions kept
  const userContent = calls[0].context!.messages[0].content as string;
  assert.ok(!userContent.includes("![Image]"), "LLM input has no image refs");
  assert.ok(userContent.includes("The image displays a bright welcome banner"), "LLM input keeps VLM descriptions");

  // File A′ (durable, llm_wiki) keeps image refs + refined headers
  assert.ok(recorder.stored, "full output stored");
  assert.ok(recorder.stored!.markdown.includes("![Image](images/image_1.jpeg)"), "File A′ keeps image refs");
  assert.match(recorder.stored!.markdown, /^# Infos Sommerseminar 2026/);
  // File B (rag working copy) is text-only
  assert.ok(recorder.ragMarkdown !== undefined, "store received File B as ragMarkdown");
  assert.ok(!recorder.ragMarkdown!.includes("![Image]"), "File B has no image refs");
  assert.ok(recorder.ragMarkdown!.includes("The image displays a bright welcome banner"), "File B keeps VLM descriptions");
  // ref exposes both files
  assert.notEqual(ref.rag_md_ref, ref.md_ref, "File A′ and File B are distinct when image refs exist");
});

test("refine_document keeps a single md_ref when the doc has no image refs (no separate File B)", async () => {
  const recorder: FakeStoreRecorder = {};
  const { runtime } = makeFakeRuntime({
    completeResultFor: () => ({
      role: "assistant",
      content: [{ type: "toolCall", id: "t1", name: "emit_refined_document", arguments: REFINED_DOC }],
      usage: zeroUsage,
      stopReason: "stop",
    }),
  });
  const tool = createRefineDocumentTool(runtime, { storageDir: "storage", storeImpl: fakeStore(recorder) });

  const result = await tool.execute("c", { markdown: REFINED_DOC.markdown }, undefined, undefined, {} as never);
  const ref = parseResult<RefineOutputRef>(result);
  const details = result.details as { imageRefsStripped?: boolean };

  assert.equal(details.imageRefsStripped, false);
  assert.equal(ref.rag_md_ref, ref.md_ref, "RAG uses the same durable file when nothing to strip");
});

test("refine_document fallback on image-heavy md keeps the full md for llm_wiki and a stripped working copy for RAG", async () => {
  const recorder: FakeStoreRecorder = {};
  const { runtime } = makeFakeRuntime({
    completeResultFor: () => {
      throw new Error("openrouter 429 rate limited");
    },
  });
  const tool = createRefineDocumentTool(runtime, { storageDir: "storage", storeImpl: fakeStore(recorder) });

  const result = await tool.execute("c", { markdown: IMAGE_HEAVY_MD }, undefined, undefined, {} as never);
  const ref = parseResult<RefineOutputRef>(result);

  assert.equal(ref.frontmatter.type, "document");
  assert.equal(ref.quality.action, "review_required");
  assert.ok(recorder.stored!.markdown.includes("![Image](images/image_1.jpeg)"), "fallback File A′ keeps image refs");
  assert.ok(!recorder.ragMarkdown!.includes("![Image]"), "fallback File B is stripped for RAG");
  assert.notEqual(ref.rag_md_ref, ref.md_ref);
});

// --- lenient extractRefinedDocument ---

test("extractRefinedDocument accepts a JSON object nested inside assistant text", () => {
  const fromFence = extractRefinedDocument({
    role: "assistant",
    content: [
      {
        type: "text",
        text: `Here is the refined document:\n\`\`\`json\n${JSON.stringify(REFINED_DOC)}\n\`\`\`\nDone.`,
      },
    ],
  });
  assert.equal(fromFence.frontmatter.type, "event");
  assert.equal(fromFence.entities.length, 3);

  const fromProse = extractRefinedDocument({
    role: "assistant",
    content: [{ type: "text", text: `Sure — ${JSON.stringify(REFINED_DOC)} — hope that helps.` }],
  });
  assert.equal(fromProse.frontmatter.topic, "internal/events");
  assert.equal(fromProse.keywords[0], "sommerseminar");
});

test("extractRefinedDocument still throws when no JSON can be found at all", () => {
  assert.throws(
    () =>
      extractRefinedDocument({
        role: "assistant",
        content: [{ type: "text", text: "sorry, I could not produce the structure" }],
      }),
    /no structured output/,
  );
});

// --- retry ---

test("runRefinePass retries once before giving up when the first pass returns no structured output", async () => {
  const recorder: FakeStoreRecorder = {};
  let attempts = 0;
  const { runtime, calls } = makeFakeRuntime({
    completeResultFor: () => {
      attempts += 1;
      if (attempts === 1) {
        return { role: "assistant", content: [{ type: "text", text: "please hold" }], usage: zeroUsage };
      }
      return {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "emit_refined_document", arguments: REFINED_DOC }],
        usage: zeroUsage,
        stopReason: "stop",
      };
    },
  });
  const tool = createRefineDocumentTool(runtime, { storageDir: "storage", storeImpl: fakeStore(recorder) });

  const result = await tool.execute("c", { markdown: IMAGE_HEAVY_MD }, undefined, undefined, {} as never);
  const ref = parseResult<RefineOutputRef>(result);
  const details = result.details as { retries?: number; fallback?: boolean };

  assert.equal(calls.length, 2, "re-prompted once after the failed pass");
  assert.equal(details.retries, 1);
  assert.equal(details.fallback, undefined, "the retry produced structured output, no fallback");
  assert.equal(ref.frontmatter.type, "event");
  assert.equal(ref.entities.length, 3);
});

test("retry does not add calls when the first pass already returns structured output", async () => {
  const recorder: FakeStoreRecorder = {};
  const { runtime, calls } = makeFakeRuntime({
    completeResultFor: () => ({
      role: "assistant",
      content: [{ type: "toolCall", id: "t1", name: "emit_refined_document", arguments: REFINED_DOC }],
      usage: zeroUsage,
      stopReason: "stop",
    }),
  });
  const tool = createRefineDocumentTool(runtime, { storageDir: "storage", storeImpl: fakeStore(recorder) });

  const result = await tool.execute("c", { markdown: IMAGE_HEAVY_MD }, undefined, undefined, {} as never);
  const details = result.details as { retries?: number };

  assert.equal(calls.length, 1);
  assert.equal(details.retries, 0);
});
