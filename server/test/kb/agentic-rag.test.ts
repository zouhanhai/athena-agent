import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AgenticRetrievalService,
  type AgenticJudge,
  type WebSearchProvider,
} from "../../src/kb/agentic-rag.js";
import type { KnowledgeSearchResponse, KnowledgeSearchResult } from "../../src/kb/retrieval.js";
import type { KnowledgeGraph } from "../../src/kb/retrieval.js";

/** A canned search backend recording every call + returning scripted hits. */
function makeSearch(calls: Array<{ query: string; topic?: string; retriever?: string }> | Record<string, never>, script: Record<string, KnowledgeSearchResult[]>) {
  return async (query: string, opts: { topic?: string; retriever?: string } = {}) => {
    if (Array.isArray(calls)) calls.push({ query, ...opts });
    return { query, results: script[query] ?? [] } satisfies KnowledgeSearchResponse;
  };
}

function hit(id: string, title?: string): KnowledgeSearchResult {
  return { source: "neo4j", title: title ?? id, snippet: `snippet of ${id}`, score: 0.9 };
}

/** A recording judge implementing the full seam surface. */
function makeJudge(overrides: Partial<AgenticJudge> = {}): { judge: AgenticJudge; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    judge: {
      transformQuery: overrides.transformQuery ?? (async () => ({ action: "direct" as const })),
      judgeRelevance: overrides.judgeRelevance ?? (async () => ({ relevant: true })),
      compress: overrides.compress ?? (async (_q, hits) => `compressed(${hits.length})`),
      multiHop: overrides.multiHop ?? (async () => ({ followUps: [], trace: "" })),
      suggestKbUpdate:
        overrides.suggestKbUpdate ??
        (async (_q, _kb, _web) => "upload the missing document under the topic domain"),
      ...overrides,
    },
  };
}

test("falls back to non-agentic retrieval when no LLM judge is injected", async () => {
  const calls: Array<{ query: string; topic?: string }> = [];
  const service = new AgenticRetrievalService({
    search: makeSearch(calls, { "what is RAG": [hit("c1")] }),
  });
  const answer = await service.answer("what is RAG");
  assert.equal(answer.notFound, false);
  assert.equal(answer.hits.length, 1);
  assert.ok(answer.answer.length > 0, "plain search fallback still returns usable text");
  assert.deepEqual(calls, [{ query: "what is RAG" }]);
});

test("clarify: a too-broad query asks back for detail instead of searching", async () => {
  const calls: Array<{ query: string }> = [];
  const service = new AgenticRetrievalService({
    search: makeSearch(calls, {}),
    judge: makeJudge({
      transformQuery: async () => ({ action: "clarify", clarification: "Which topic?" }),
    }).judge,
  });
  const answer = await service.answer("tell me about everything");
  assert.equal(answer.notFound, false);
  assert.equal(answer.hits.length, 0, "no retrieval runs when clarifying");
  assert.equal(calls.length, 0, "search must not run on clarify");
  assert.match(answer.answer, /Which topic\?/);
});

test("decompose: sub-queries run in parallel and their hits are fused", async () => {
  const calls: Array<{ query: string }> = [];
  const service = new AgenticRetrievalService({
    search: makeSearch(calls, {
      "budget 2025": [hit("b1", "Budget 2025")],
      "headcount 2025": [hit("h1", "Headcount")],
    }),
    judge: makeJudge({
      transformQuery: async () => ({
        action: "decompose",
        subQueries: ["budget 2025", "headcount 2025"],
      }),
    }).judge,
  });
  const answer = await service.answer("what is our 2025 budget and headcount?");
  assert.equal(calls.length, 2, "both sub-queries run");
  assert.deepEqual(
    calls.map((c) => c.query).sort(),
    ["budget 2025", "headcount 2025"],
  );
  assert.equal(answer.hits.length, 2, "hits from both sub-queries are fused");
  assert.ok(answer.answer.includes("compressed(2)"));
});

test("retriever picker: the LLM's retriever + topic choice is passed to the search", async () => {
  const calls: Array<{ query: string; topic?: string; retriever?: string }> = [];
  const service = new AgenticRetrievalService({
    search: makeSearch(calls, { "fiori setup": [hit("c1")] }),
    judge: makeJudge({
      transformQuery: async () => ({
        action: "direct",
        retriever: "bm25",
        topic: "sap/fiori",
      }),
    }).judge,
  });
  await service.answer("how do I set up fiori");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.retriever, "bm25", "picked retriever is honored");
  assert.equal(calls[0]!.topic, "sap/fiori", "topic convergence scopes the search");
});

test("topic convergence: cross-domain questions omit the topic (whole corpus)", async () => {
  const calls: Array<{ query: string; topic?: string }> = [];
  const service = new AgenticRetrievalService({
    search: makeSearch(calls, { "mixed topic": [hit("c1")] }),
    judge: makeJudge({
      transformQuery: async () => ({ action: "direct", retriever: "hybrid" }),
    }).judge,
  });
  await service.answer("something across sap and transport");
  assert.equal(calls[0]!.topic, undefined, "cross-domain → no topic scope");
});

test("multi-hop: judge follow-up queries run as graph searches and fuse into hits", async () => {
  const calls: Array<{ query: string; retriever?: string }> = [];
  const service = new AgenticRetrievalService({
    search: makeSearch(calls, {
      "what serves the ZOB?": [hit("c1", "ZOB hub")],
      "related to MVV": [hit("c2", "MVV lines")],
    }),
    graph: async (): Promise<KnowledgeGraph> => ({
      nodes: [{ id: "ZOB", label: "ZOB" }, { id: "MVV", label: "MVV" }],
      edges: [{ source: "ZOB", target: "MVV" }],
    }),
    judge: makeJudge({
      transformQuery: async () => ({ action: "direct", retriever: "graph" }),
      multiHop: async () => ({ followUps: ["related to MVV"], trace: "ZOB → MVV" }),
    }).judge,
  });
  const answer = await service.answer("what serves the ZOB?");
  assert.equal(answer.hits.length, 2, "seed + follow-up hits fused");
  assert.equal(calls[1]!.retriever, "graph", "follow-up runs as a graph retriever");
});

test("compression: the judge's distilled summary is the final answer", async () => {
  const service = new AgenticRetrievalService({
    search: makeSearch({}, { "report": [hit("c1")] }),
    judge: makeJudge({ compress: async () => "CALEO grew 12% in 2025." }).judge,
  });
  const answer = await service.answer("report");
  assert.equal(answer.answer, "CALEO grew 12% in 2025.");
});

test("not-found: KB hits judged irrelevant → explicit not-found + web fallback + KB update suggestion", async () => {
  const service = new AgenticRetrievalService({
    search: makeSearch({}, { "deepseek v4": [] }),
    judge: makeJudge({
      judgeRelevance: async () => ({ relevant: false, reason: "no relevant hits" }),
      suggestKbUpdate: async () => "add a doc about deepseek-v4 under topic ai/models",
    }).judge,
    webSearch: {
      search: async () => [{ title: "DeepSeek-V4", url: "https://example.com", snippet: "DeepSeek V4 specs." }],
    } satisfies WebSearchProvider,
  });
  const answer = await service.answer("deepseek v4");
  assert.equal(answer.notFound, true);
  assert.match(answer.answer, /not found in the knowledge base/i);
  assert.equal(answer.webResults.length, 1);
  assert.equal(answer.kbUpdateSuggestion, "add a doc about deepseek-v4 under topic ai/models");
});

test("not-found: without a web search provider still says not found (no hallucination)", async () => {
  const service = new AgenticRetrievalService({
    search: makeSearch({}, { "space laser": [] }),
    judge: makeJudge({ judgeRelevance: async () => ({ relevant: false }) }).judge,
  });
  const answer = await service.answer("space laser");
  assert.equal(answer.notFound, true);
  assert.match(answer.answer, /not found in the knowledge base/i);
  assert.equal(answer.webResults.length, 0);
  assert.equal(answer.kbUpdateSuggestion, undefined);
});
