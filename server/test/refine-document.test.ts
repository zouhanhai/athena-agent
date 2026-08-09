import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  ATHENA_MODEL,
  ATHENA_PROVIDER,
  createRefineDocumentTool,
  type RefinedDocument,
} from "../src/agents/refine-document.js";

const sampleRefined: RefinedDocument = {
  markdown: "# Sommerseminar\n\n## Workshops\n\nDetails about the workshops.",
  frontmatter: { type: "event", topic: "internal/events" },
  chunks: [
    { id: "c1", text: "Details about the workshops.", start: 0, end: 400, topic: "internal/events" },
  ],
  entities: [{ name: "CALEO", type: "org", description: "An organization" }],
  relations: [{ from: "CALEO", to: "Sommerseminar", type: "hosts" }],
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

interface FakeRuntimeCalls {
  providerId?: string;
  modelId?: string;
  options?: unknown;
  context?: { systemPrompt?: string; messages: unknown[]; tools: unknown[] };
}

function makeFakeRuntime(opts: {
  missingModel?: boolean;
  completeResult?: unknown;
  completeThrows?: Error;
  toolCallArgs?: Record<string, unknown>;
  echoInputMarkdown?: boolean;
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
      if (opts.completeThrows) throw opts.completeThrows;
      if (opts.completeResult) return opts.completeResult;
      const userMsg = context.messages[0] as { content: string };
      const args = opts.toolCallArgs ?? sampleRefined;
      return {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t1",
            name: "emit_refined_document",
            arguments: opts.echoInputMarkdown ? { ...args, markdown: userMsg.content } : args,
          },
        ],
        usage: zeroUsage,
        stopReason: "stop",
        timestamp: 1,
      };
    },
  } as unknown as ModelRuntime;
  return { runtime, calls };
}

function parseResult<T>(result: { content: { type: string; text?: string }[] }): T {
  const text = (result.content[0] as { text: string }).text;
  return JSON.parse(text) as T;
}

test("refine_document registers markdown/topic_hint params + sequential execution", () => {
  const { runtime } = makeFakeRuntime();
  const tool = createRefineDocumentTool(runtime);

  assert.equal(tool.name, "refine_document");
  assert.equal(tool.executionMode, "sequential");

  const schema = tool.parameters as { properties?: Record<string, unknown>; required?: string[] };
  assert.ok(schema.properties?.markdown, "markdown is a required param");
  assert.ok(schema.properties?.topic_hint, "topic_hint is an optional param");
  assert.ok(schema.required?.includes("markdown"), "markdown listed as required");
});

test("execute returns the structured output contract from the constrained emit tool", async () => {
  const { runtime } = makeFakeRuntime({ echoInputMarkdown: true });
  const tool = createRefineDocumentTool(runtime);

  const result = await tool.execute("c", { markdown: "# Doc" }, undefined, undefined, {} as never);
  const parsed = parseResult<RefinedDocument>(result);

  assert.equal(parsed.markdown, "# Doc");
  assert.deepEqual(parsed.frontmatter, { type: "event", topic: "internal/events" });
  assert.equal(parsed.chunks.length, 1);
  assert.equal(parsed.entities[0].name, "CALEO");
  assert.deepEqual(parsed.relations[0], { from: "CALEO", to: "Sommerseminar", type: "hosts" });
  assert.ok(Array.isArray(parsed.keywords));
  assert.equal(parsed.quality.action, "auto_accept");
});

test("uses the athena provider + deepseek-v4-flash-latest with thinkingLevel high", async () => {
  const { runtime, calls } = makeFakeRuntime();
  const tool = createRefineDocumentTool(runtime);

  await tool.execute("c", { markdown: "# Doc" }, undefined, undefined, {} as never);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].providerId, "athena");
  assert.equal(calls[0].modelId, "~deepseek/deepseek-v4-flash-latest");
  assert.deepEqual(calls[0].options, { reasoning: "high" });
});

test("sets constrainedSampling JSON schema on the emit tool inside the LLM context", async () => {
  const { runtime, calls } = makeFakeRuntime();
  const tool = createRefineDocumentTool(runtime);

  await tool.execute("c", { markdown: "# Doc" }, undefined, undefined, {} as never);

  const ctx = calls[0].context!;
  const emit = (ctx.tools as Array<{ name: string; constrainedSampling?: unknown }>).find(
    (t) => t.name === "emit_refined_document",
  );
  assert.ok(emit, "emit_refined_document tool present in context");
  assert.deepEqual(emit.constrainedSampling, { type: "json_schema", strict: "require" });
});

test("topic_hint is folded into the refinement system prompt", async () => {
  const { runtime, calls } = makeFakeRuntime();
  const tool = createRefineDocumentTool(runtime);

  await tool.execute("c", { markdown: "# Doc", topic_hint: "internal/events" }, undefined, undefined, {} as never);

  assert.match(calls[0].context!.systemPrompt ?? "", /internal\/events/);
});

test("rejects when the athena model is not registered (models.json/auth.json missing)", async () => {
  const { runtime } = makeFakeRuntime({ missingModel: true });
  const tool = createRefineDocumentTool(runtime);

  await assert.rejects(
    () => tool.execute("c", { markdown: "# Doc" }, undefined, undefined, {} as never),
    /athena\/~deepseek\/deepseek-v4-flash-latest not found/,
  );
});

test("parses plain-text JSON output when the model does not emit a tool call", async () => {
  const { runtime } = makeFakeRuntime({
    completeResult: {
      role: "assistant",
      content: [{ type: "text", text: JSON.stringify(sampleRefined) }],
      usage: zeroUsage,
      stopReason: "stop",
    },
  });
  const tool = createRefineDocumentTool(runtime);

  const result = await tool.execute("c", { markdown: "# Doc" }, undefined, undefined, {} as never);
  const parsed = parseResult<RefinedDocument>(result);

  assert.equal(parsed.quality.confidence, 0.85);
  assert.equal(parsed.frontmatter.type, "event");
});

test("falls back to raw docling markdown when the LLM pass fails (never worse than today)", async () => {
  const { runtime } = makeFakeRuntime({ completeThrows: new Error("openrouter 429 rate limited") });
  const tool = createRefineDocumentTool(runtime);

  const result = await tool.execute(
    "c",
    { markdown: "# Raw\n\nbody", topic_hint: "internal/events" },
    undefined,
    undefined,
    {} as never,
  );
  const parsed = parseResult<RefinedDocument>(result);

  assert.equal(parsed.markdown, "# Raw\n\nbody");
  assert.deepEqual(parsed.frontmatter, { type: "document", topic: "internal/events" });
  assert.equal(parsed.quality.complete, false);
  assert.equal(parsed.quality.action, "review_required");
  assert.ok(parsed.quality.issues.length > 0, "issues records the failure");
});

test("falls back when the model output is not schema-parseable", async () => {
  const { runtime } = makeFakeRuntime({
    completeResult: {
      role: "assistant",
      content: [{ type: "text", text: "sorry, I could not produce the structure" }],
      usage: zeroUsage,
      stopReason: "stop",
    },
  });
  const tool = createRefineDocumentTool(runtime);

  const result = await tool.execute("c", { markdown: "# Raw" }, undefined, undefined, {} as never);
  const parsed = parseResult<RefinedDocument>(result);

  assert.equal(parsed.markdown, "# Raw");
  assert.equal(parsed.quality.action, "review_required");
});
