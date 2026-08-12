import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createDefaultAgenticRetrieval } from "../../src/kb/agentic-defaults.js";
import type { AgenticJudge } from "../../src/kb/agentic-rag.js";
import { MemorySemanticMappingStore } from "../../src/kb/semantic-mappings.js";
import type { LlmWikiClient } from "../../src/kb/llmwiki.js";
import type { Neo4jRetrievalService } from "../../src/kb/store/retrieval.js";
import type { KnowledgeSearchResult } from "../../src/kb/retrieval.js";

/** A modelRuntime never exercised when `judge` is overridden (constructor only). */
const FAKE_RUNTIME = {} as ModelRuntime;

function stubLlmwiki(overrides: Partial<LlmWikiClient> = {}): LlmWikiClient {
  return {
    listProjects: async () => ({
      projects: [{ id: "proj1", name: "P1", path: "/p", current: false }],
      currentProject: null,
    }),
    getFileTree: async () => ({ files: [] }),
    listWikiPages: async () => [],
    readFile: async () => ({ path: "", content: "" }),
    search: async () => ({ results: [] }),
    ...overrides,
  } as unknown as LlmWikiClient;
}

function stubNeo4j(): Neo4jRetrievalService {
  return {
    search: async () => ({ query: "", hits: [] }),
    toolsSearch: async () => ({ query: "", hits: [] }),
    getGraph: async () => ({ nodes: [], edges: [] }),
  } as unknown as Neo4jRetrievalService;
}

function scriptedJudge(compress: AgenticJudge["compress"]): AgenticJudge {
  return {
    transformQuery: async () => ({ action: "direct" }),
    judgeRelevance: async () => ({ relevant: true }),
    compress,
    multiHop: async () => ({ followUps: [], trace: "" }),
    suggestKbUpdate: async () => "",
  };
}

test("default wiring builds an agentic service (LLM judge) + KB retrieval + web fallback", () => {
  const { service, retrieval } = createDefaultAgenticRetrieval(FAKE_RUNTIME, {
    llmwiki: stubLlmwiki(),
    neo4j: stubNeo4j(),
  });
  assert.ok(service.isAgentic, "the default judge is wired (createAgenticJudge)");
  assert.ok(retrieval, "KB retrieval service is wired");
});

test("default wiring sets up qa + mappings on the retrieval service (QA reuse + term expansion)", async () => {
  const mappings = new MemorySemanticMappingStore();
  await mappings.upsert({ term: "CDay", canonical: "CALEO Day" });
  const qa = {
    findReference: async (q: string) =>
      q.includes("caleo")
        ? { id: "qa-1", question: "what is caleo", answer: "CALEO is the SAP & finance consultancy.", score: 0.95 }
        : null,
  };
  const { retrieval } = createDefaultAgenticRetrieval(FAKE_RUNTIME, {
    llmwiki: stubLlmwiki(),
    neo4j: stubNeo4j(),
    mappings,
    qa,
  });

  const response = await retrieval.search("what is CDay caleo");
  assert.equal(response.expandedQuery, "what is CALEO Day caleo", "semantic-mapping term expansion applies");
  assert.equal(response.qaReference?.answer, "CALEO is the SAP & finance consultancy.", "stored Q&A pair is surfaced as reference");
});

test("default wiring: a stored Q&A question reuses the QA pair instead of falling back to web", async () => {
  const qa = {
    findReference: async (q: string) =>
      q.includes("caleo")
        ? { id: "qa-1", question: "what is caleo", answer: "CALEO is the SAP & finance consultancy.", score: 0.95 }
        : null,
  };
  const seenHits: KnowledgeSearchResult[] = [];
  const { service } = createDefaultAgenticRetrieval(FAKE_RUNTIME, {
    llmwiki: stubLlmwiki(),
    neo4j: stubNeo4j(),
    qa,
    judge: scriptedJudge(async (_q, hits) => {
      seenHits.push(...hits);
      const qaHit = hits.find((h) => h.title?.startsWith("QA:"));
      return qaHit?.snippet ?? "no stored answer";
    }),
  });

  const answer = await service.answer("what is caleo");
  assert.equal(answer.notFound, false, "no web fallback for a stored Q&A question");
  assert.equal(answer.webResults.length, 0, "web fallback not consulted when the QA pair answers");
  assert.equal(answer.answer, "CALEO is the SAP & finance consultancy.", "stored Q&A answer is reused");
  const qaHit = seenHits.find((h) => h.title?.startsWith("QA:"));
  assert.ok(qaHit, "QA pair is folded into the agentic hits");
});

test("default wiring: not-found questions still use the web fallback provider", async () => {
  const { service } = createDefaultAgenticRetrieval(FAKE_RUNTIME, {
    llmwiki: stubLlmwiki(),
    neo4j: stubNeo4j(),
    webSearch: {
      search: async () => [{ title: "DeepSeek-V4", url: "https://example.com", snippet: "DeepSeek V4 specs." }],
    },
    judge: {
      transformQuery: async () => ({ action: "direct" }),
      judgeRelevance: async () => ({ relevant: false }),
      compress: async () => "",
      multiHop: async () => ({ followUps: [], trace: "" }),
      suggestKbUpdate: async () => "",
    },
  });

  const answer = await service.answer("deepseek v4");
  assert.equal(answer.notFound, true);
  assert.equal(answer.webResults.length, 1, "web fallback wired into the default service");
});

test("default wiring: agentic search path runs the semantic-mapping expanded query against the backends", async () => {
  const mappings = new MemorySemanticMappingStore();
  await mappings.upsert({ term: "CDay", canonical: "CALEO Day" });
  const llmwikiQueries: string[] = [];
  const { service } = createDefaultAgenticRetrieval(FAKE_RUNTIME, {
    llmwiki: stubLlmwiki({
      search: async (_projectId, query) => {
        llmwikiQueries.push(query);
        return { results: [] };
      },
    }),
    neo4j: stubNeo4j(),
    mappings,
    judge: scriptedJudge(async () => "ok"),
  });

  await service.answer("when is CDay?");
  assert.ok(
    llmwikiQueries.some((q) => q.includes("CALEO Day")),
    `term expansion reaches the search backends (got ${JSON.stringify(llmwikiQueries)})`,
  );
});
