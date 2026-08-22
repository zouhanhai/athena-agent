import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  ATHENA_MODEL,
  REFINED_DOCUMENT_DELTA_SCHEMA,
  createRefineDocumentTool,
  type RefinedDocument,
  type RefineLlmCaller,
} from "../src/agents/refine-document.js";
import type { RefineOutputRef, RefinementMode } from "../src/agents/refine-output.js";

const sampleRefined: RefinedDocument = {
  markdown: "# Sommerseminar\n\n## Workshops\n\nDetails about the workshops.",
  summary: "CALEO's annual Sommerseminar covers workshops and talks.",
  sections: [{ title: "Sommerseminar", summary: "The annual CALEO event with workshops and talks." }],
  frontmatter: { type: "event", topic: "internal/events" },
  chunks: [{ id: "c1", text: "Details about the workshops.", heading_path: "Sommerseminar / Workshops" }],
  entities: [
    { name: "CALEO", type: "org", description: "An organization" },
    { name: "Sommerseminar", type: "event", description: "The annual CALEO event" },
  ],
  relations: [
    {
      source: "CALEO",
      target: "Sommerseminar",
      keywords: ["hosts"],
      description: "CALEO hosts the Sommerseminar.",
    },
  ],
  keywords: ["sommerseminar", "workshop"],
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

interface CallerCalls {
  systemPrompt?: string;
  userContent: string;
  schema?: unknown;
  model?: string;
}

interface FakeStoreRecorder {
  stored?: RefinedDocument;
  storageDir?: string;
}

/** Fake big-output store: records the full doc, returns the small ref (no disk writes in tests). */
function makeFakeStore(recorder?: FakeStoreRecorder) {
  return async (
    doc: RefinedDocument,
    storageDir: string,
    opts: { stem?: string; mode?: RefinementMode; sections?: string[] } = {},
  ): Promise<RefineOutputRef> => {
    if (recorder) {
      recorder.stored = doc;
      recorder.storageDir = storageDir;
    }
    return {
      md_ref: `${storageDir}/${opts.stem ?? "doc"}.md`,
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
      summary: doc.summary,
      sections: doc.sections,
      section_paths: opts.section_paths ?? [],
      mode: opts.mode ?? "single",
    };
  };
}

/**
 * Fake direct-OpenRouter caller (G4.S8.T2 seam): records each call's system prompt / user content /
 * schema and returns a configured assistant message. No Pi ModelRuntime, no live HTTP.
 */
function makeCaller(opts: {
  completeResult?: unknown;
  completeThrows?: Error;
  toolCallArgs?: Record<string, unknown>;
  echoInputMarkdown?: boolean;
} = {}): { runtime: ModelRuntime; caller: RefineLlmCaller; calls: CallerCalls[] } {
  const calls: CallerCalls[] = [];
  const caller: RefineLlmCaller = async ({ systemPrompt, userContent, schema, model }) => {
    calls.push({ systemPrompt, userContent, schema, model });
    if (opts.completeThrows) throw opts.completeThrows;
    if (opts.completeResult) {
      return { usage: zeroUsage, message: { role: "assistant", content: [{ type: "text", text: String(opts.completeResult) }] } };
    }
    const args = opts.toolCallArgs ?? sampleRefined;
    const messageArgs = opts.echoInputMarkdown ? { ...args, markdown: userContent } : args;
    return { usage: zeroUsage, message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(messageArgs) }] } };
  };
  return { runtime: {} as ModelRuntime, caller, calls };
}

function parseResult<T>(result: { content: { type: string; text?: string }[] }): T {
  const text = (result.content[0] as { text: string }).text;
  return JSON.parse(text) as T;
}

function toolWith(caller: RefineLlmCaller, extra: Partial<{ storageDir: string; storeImpl: unknown }> = {}) {
  return createRefineDocumentTool({} as ModelRuntime, { httpCaller: caller, ...extra } as never);
}

test("refine_document registers markdown/topic_hint params + sequential execution", () => {
  const { caller } = makeCaller();
  const tool = toolWith(caller);

  assert.equal(tool.name, "refine_document");
  assert.equal(tool.executionMode, "sequential");

  const schema = tool.parameters as { properties?: Record<string, unknown>; required?: string[] };
  assert.ok(schema.properties?.markdown, "markdown is a required param");
  assert.ok(schema.properties?.topic_hint, "topic_hint is an optional param");
  assert.ok(schema.required?.includes("markdown"), "markdown listed as required");
});

test("execute stores the full output and returns the small ref (pi-docparser big-output pattern)", async () => {
  const recorder: FakeStoreRecorder = {};
  const { caller } = makeCaller({ echoInputMarkdown: true });
  const tool = createRefineDocumentTool({} as ModelRuntime, { httpCaller: caller, storageDir: "storage", storeImpl: makeFakeStore(recorder) });

  const result = await tool.execute("c", { markdown: "# Doc\n\nbody" }, undefined, undefined, {} as never);
  const ref = parseResult<RefineOutputRef>(result);

  // full re-leveled markdown (rebuilt locally, delta contract) + locally-built chunks in storage
  assert.equal(recorder.stored!.markdown, "# Doc\n\nbody");
  assert.equal(recorder.stored!.chunks.length, 1);
  assert.equal(recorder.stored!.chunks[0].text, "body");
  // the tool returns the SMALL metadata + refs, not the full document
  assert.equal(ref.md_ref, "storage/doc.md");
  assert.deepEqual(ref.frontmatter, { type: "event", topic: "internal/events" });
  assert.equal(ref.entities[0].name, "CALEO");
  assert.deepEqual(ref.relations[0], {
    source: "CALEO",
    target: "Sommerseminar",
    keywords: ["hosts"],
    description: "CALEO hosts the Sommerseminar.",
  });
  assert.ok(Array.isArray(ref.keywords));
  assert.equal(ref.quality.action, "auto_accept");
  assert.equal(ref.summary, "CALEO's annual Sommerseminar covers workshops and talks.", "summary emitted in the ref");
  assert.equal(ref.mode, "single");
});

test("single-pass refine calls the direct OpenRouter caller (reasoning is handled off internally by llm-direct)", async () => {
  const { caller, calls } = makeCaller();
  const tool = toolWith(caller, { storageDir: "storage", storeImpl: makeFakeStore() });

  await tool.execute("c", { markdown: "# Doc" }, undefined, undefined, {} as never);

  // G4.S8.T19: one MAIN pass + ONE mandatory audit session per document.
  assert.equal(calls.length, 2);
});

test("sends the delta schema to the caller for the single-pass refine", async () => {
  const { caller, calls } = makeCaller();
  const tool = toolWith(caller, { storageDir: "storage", storeImpl: makeFakeStore() });

  await tool.execute("c", { markdown: "# Doc" }, undefined, undefined, {} as never);

  assert.equal(JSON.stringify(calls[0]!.schema), JSON.stringify(REFINED_DOCUMENT_DELTA_SCHEMA));
});

test("topic_hint is folded into the refinement system prompt", async () => {
  const { caller, calls } = makeCaller();
  const tool = toolWith(caller, { storageDir: "storage", storeImpl: makeFakeStore() });

  await tool.execute("c", { markdown: "# Doc", topic_hint: "internal/events" }, undefined, undefined, {} as never);

  assert.match(calls[0]!.systemPrompt ?? "", /internal\/events/);
});

test("an injected httpCaller is used for the refine pass", async () => {
  let used = 0;
  const tool = createRefineDocumentTool({} as ModelRuntime, {
    httpCaller: async () => {
      used += 1;
      return { usage: zeroUsage, message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(sampleRefined) }] } };
    },
    storageDir: "storage",
    storeImpl: makeFakeStore(),
  });

  await tool.execute("c", { markdown: "# Doc" }, undefined, undefined, {} as never);
  // G4.S8.T19: main pass + mandatory audit session both ride the injected caller.
  assert.equal(used, 2);
});

test("parses plain-text JSON output when the model does not emit a tool call", async () => {
  const { caller } = makeCaller({ completeResult: JSON.stringify(sampleRefined) });
  const tool = toolWith(caller, { storageDir: "storage", storeImpl: makeFakeStore() });

  const result = await tool.execute("c", { markdown: "# Doc" }, undefined, undefined, {} as never);
  const ref = parseResult<RefineOutputRef>(result);

  assert.equal(ref.quality.confidence, 0.85);
  assert.equal(ref.frontmatter.type, "event");
});

test("falls back to raw docling markdown when the LLM pass fails (never worse than today)", async () => {
  const recorder: FakeStoreRecorder = {};
  const { caller } = makeCaller({ completeThrows: new Error("openrouter 429 rate limited") });
  const tool = createRefineDocumentTool({} as ModelRuntime, { httpCaller: caller, storageDir: "storage", storeImpl: makeFakeStore(recorder) });

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
  assert.ok(ref.quality.issues.length > 0, "issues records the failure");
  assert.ok(ref.summary.length > 0, "fallback still emits a derived summary");
});

test("falls back when the model output is not schema-parseable", async () => {
  const { caller } = makeCaller({ completeResult: "sorry, I could not produce the structure" });
  const tool = toolWith(caller, { storageDir: "storage", storeImpl: makeFakeStore() });

  const result = await tool.execute("c", { markdown: "# Raw" }, undefined, undefined, {} as never);
  const ref = parseResult<RefineOutputRef>(result);

  assert.equal(ref.frontmatter.type, "document");
  assert.equal(ref.quality.action, "review_required");
});

test("reports the resolved model in the ref details", async () => {
  const { caller } = makeCaller();
  const tool = toolWith(caller, { storageDir: "storage", storeImpl: makeFakeStore() });

  const result = await tool.execute("c", { markdown: "# Doc" }, undefined, undefined, {} as never);
  const details = result.details as { model?: string };
  assert.equal(details.model, ATHENA_MODEL);
});

test("G4.S8.T6: options.modelId is threaded to the caller and reflected in details.model", async () => {
  const { caller, calls } = makeCaller();
  const tool = createRefineDocumentTool({} as ModelRuntime, {
    httpCaller: caller,
    storageDir: "storage",
    storeImpl: makeFakeStore(),
    modelId: "qwen/qwen3.7-flash",
  } as never);

  const result = await tool.execute("c", { markdown: "# Doc" }, undefined, undefined, {} as never);
  const details = result.details as { model?: string };
  assert.equal(details.model, "qwen/qwen3.7-flash", "details.model reflects the configured modelId");
  assert.equal(calls[0].model, "qwen/qwen3.7-flash", "the model is passed to the OpenRouter caller");
});
