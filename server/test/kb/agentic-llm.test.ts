import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createAgenticJudge,
  EMIT_AGENTIC_PLAN_TOOL,
  AGENTIC_PLAN_SYSTEM_PROMPT,
  extractPlan,
  extractJudgement,
  extractMultiHop,
  extractUpdate,
  extractCompression,
} from "../../src/kb/agentic-llm.js";
import type { QueryPlan, RelevanceJudgement, MultiHopPlan } from "../../src/kb/agentic-rag.js";
import type { KnowledgeSearchResult, KnowledgeGraph } from "../../src/kb/retrieval.js";

const zeroUsage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface FakeRuntimeCalls {
  context?: { systemPrompt?: string; messages: unknown[]; tools: unknown[] };
}

function makeFakeRuntime(result: unknown): { runtime: ModelRuntime; calls: FakeRuntimeCalls[] } {
  const calls: FakeRuntimeCalls[] = [];
  const runtime = {
    calls,
    getModel(providerId: string, modelId: string) {
      return { id: modelId, provider: providerId };
    },
    async completeSimple(
      _model: { provider: string; id: string },
      context: { systemPrompt?: string; messages: unknown[]; tools: unknown[] },
      _options: unknown,
    ) {
      calls.push({ context });
      const emit = (toolName: string, args: unknown) => ({
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: toolName, arguments: args }],
        usage: zeroUsage,
        stopReason: "stop",
        timestamp: 1,
      });
      const tool = context.tools?.[0] as { name: string } | undefined;
      return emit(tool?.name ?? EMIT_AGENTIC_PLAN_TOOL, result);
    },
  };
  return { runtime: runtime as unknown as ModelRuntime, calls };
}

const sampleHits: KnowledgeSearchResult[] = [
  { source: "neo4j", title: "Chunk", snippet: "ZOB is a bus station.", score: 0.9 },
];
const sampleGraph: KnowledgeGraph = {
  nodes: [{ id: "ZOB", label: "ZOB" }, { id: "MVV", label: "MVV" }],
  edges: [{ source: "ZOB", target: "MVV" }],
};

test("extractPlan parses a constrained emit tool call", () => {
  const plan: QueryPlan = { action: "decompose", subQueries: ["a", "b"], retriever: "bm25", topic: "sap" };
  const parsed = extractPlan({
    content: [{ type: "toolCall", id: "t1", name: EMIT_AGENTIC_PLAN_TOOL, arguments: plan }],
  });
  assert.deepEqual(parsed, plan);
});

test("extractPlan parses clarify options for the user follow-up", () => {
  const plan: QueryPlan = {
    action: "clarify",
    clarification: "Which do you mean?",
    options: ["the company", "a person", "the Latin word"],
  };
  const parsed = extractPlan({
    content: [{ type: "toolCall", id: "t1", name: EMIT_AGENTIC_PLAN_TOOL, arguments: plan }],
  });
  assert.deepEqual(parsed, plan);
});

test("extractPlan ignores malformed / absent options", () => {
  const parsed = extractPlan({
    content: [{ type: "toolCall", id: "t1", name: EMIT_AGENTIC_PLAN_TOOL, arguments: { action: "direct", options: "nope" } }],
  });
  assert.equal(parsed.action, "direct");
  assert.equal(parsed.options, undefined);
});

test("AGENTIC_PLAN_SYSTEM_PROMPT: clarify ONLY for no-subject queries; definitional queries go direct", () => {
  // G4.S3.T13 — the plan prompt must steer the judge away from clarifying
  // "what is X" (a user unfamiliar with X cannot answer a clarifying question).
  assert.match(AGENTIC_PLAN_SYSTEM_PROMPT, /clarify/);
  assert.match(AGENTIC_PLAN_SYSTEM_PROMPT, /NO extractable subject/i);
  assert.match(AGENTIC_PLAN_SYSTEM_PROMPT, /what is caleo/);
  assert.match(AGENTIC_PLAN_SYSTEM_PROMPT, /definitional/i);
  assert.match(AGENTIC_PLAN_SYSTEM_PROMPT, /never ask the user to disambiguate/);
  assert.match(AGENTIC_PLAN_SYSTEM_PROMPT, /2-4 concrete options/i);
});

test("transformQuery sends the plan prompt so definitional questions are steered to direct", async () => {
  const { runtime, calls } = makeFakeRuntime({ action: "direct", retriever: "hybrid" });
  const judge = createAgenticJudge(runtime, { providerId: "athena", modelId: "~deepseek/x" });
  const got = await judge.transformQuery("what is caleo", ["sap"]);
  assert.equal(got.action, "direct");
  assert.match(calls[0]!.context!.systemPrompt as string, /what is caleo/);
  assert.match(calls[0]!.context!.systemPrompt as string, /definitional/i);
});

test("transformQuery calls the LLM with the emit tool + returns the plan", async () => {
  const plan: QueryPlan = { action: "direct", retriever: "graph" };
  const { runtime, calls } = makeFakeRuntime(plan);
  const judge = createAgenticJudge(runtime, { providerId: "athena", modelId: "~deepseek/x" });

  const got = await judge.transformQuery("what serves the ZOB?", ["transport", "sap"]);
  assert.deepEqual(got, plan);
  assert.equal(calls[0]!.context!.tools?.[0]?.name, EMIT_AGENTIC_PLAN_TOOL, "constrained emit tool used");
  assert.match(calls[0]!.context!.messages[0]!.content as string, /what serves the ZOB\?/);
  assert.match(calls[0]!.context!.messages[0]!.content as string, /transport/);
});

test("judgeRelevance parses relevant:false + reason", async () => {
  const { runtime } = makeFakeRuntime({ relevant: false, reason: "no relevant hits" });
  const judge = createAgenticJudge(runtime);
  const judgement: RelevanceJudgement = await judge.judgeRelevance("q", sampleHits);
  assert.equal(judgement.relevant, false);
  assert.equal(judgement.reason, "no relevant hits");
});

test("extractJudgement tolerates missing reason", () => {
  const parsed = extractJudgement({ content: [{ type: "text", text: '{"relevant": true}' }] });
  assert.equal(parsed.relevant, true);
  assert.equal(parsed.reason, undefined);
});

test("multiHop parses follow-up queries + trace", async () => {
  const { runtime } = makeFakeRuntime({ followUps: ["MVV"], trace: "ZOB → MVV" });
  const judge = createAgenticJudge(runtime);
  const plan: MultiHopPlan = await judge.multiHop("q", sampleHits, sampleGraph);
  assert.deepEqual(plan.followUps, ["MVV"]);
  assert.equal(plan.trace, "ZOB → MVV");
});

test("compress returns the distilled summary text", async () => {
  const { runtime } = makeFakeRuntime({ answer: "CALEO grew 12% in 2025." });
  const judge = createAgenticJudge(runtime);
  const answer = await judge.compress("report", sampleHits);
  assert.equal(answer, "CALEO grew 12% in 2025.");
});

test("suggestKbUpdate returns what to add/update in the KB", async () => {
  const { runtime } = makeFakeRuntime({ suggestion: "add a doc about deepseek-v4 under ai/models" });
  const judge = createAgenticJudge(runtime);
  const suggestion = await judge.suggestKbUpdate(
    "deepseek v4",
    [],
    [{ title: "t", url: "u", snippet: "s" }],
  );
  assert.equal(suggestion, "add a doc about deepseek-v4 under ai/models");
});

test("extractUpdate tolerates malformed LLM output (falls back to a safe string)", () => {
  assert.equal(extractUpdate({ content: [] }), "");
  assert.equal(extractCompression({ content: [] }), "");
});
