import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createKnowledgeTools,
  createSearchKnowledgeTool,
  createWebSearchTool,
  KNOWLEDGE_SOURCES,
  routeRequirement,
  sourceSatisfiesRequirement,
  buildCapabilitiesSystemSection,
} from "../../src/kb/tools.js";
import { AgenticRetrievalService } from "../../src/kb/agentic-rag.js";

function makeServices(overrides: Record<string, unknown> = {}) {
  return {
    llmwiki: {
      async listProjects() {
        return {
          currentProject: null,
          projects: [{ id: "athena-wiki", name: "athena-wiki", path: "/data/wiki", current: false }],
        };
      },
      async search(projectId: string, query: string) {
        return { results: [{ path: "wiki/a.md", title: "A", snippet: "s", score: 9 }], mode: "keyword" };
      },
      async readFile(projectId: string, path: string) {
        return { path, content: "# content of " + path };
      },
      async getGraph(projectId: string) {
        return {
          nodes: [{ id: "p1", label: "Page 1" }],
          edges: [{ source: "p1", target: "p2" }],
        };
      },
      ...(overrides.llmwiki ?? {}),
    },
    ...(overrides.services ?? {}),
  };
}

test("createKnowledgeTools registers the 3 wiki knowledge tools with capability requirements", () => {
  const tools = createKnowledgeTools(makeServices());
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "wiki_graph",
    "wiki_read_page",
    "wiki_search",
  ]);

  assert.deepEqual(byName.wiki_search.requireCapability, { allOf: ["wiki"] });
  assert.deepEqual(byName.wiki_read_page.requireCapability, { allOf: ["wiki"] });
  assert.deepEqual(byName.wiki_graph.requireCapability, { allOf: ["wiki", "graph"] });
});

test("capability declarations: llm_wiki = wiki+keyword+graph (only source)", () => {
  const llmwiki = KNOWLEDGE_SOURCES.find((s) => s.id === "llmwiki");
  assert.deepEqual(llmwiki?.capabilities, ["wiki", "keyword", "graph"]);
  assert.equal(KNOWLEDGE_SOURCES.length, 1);
});

test("sourceSatisfiesRequirement evaluates AnyOf and AllOf", () => {
  const llmwiki = KNOWLEDGE_SOURCES[0];

  assert.equal(sourceSatisfiesRequirement(llmwiki, { anyOf: ["vector", "keyword"] }), true);
  assert.equal(sourceSatisfiesRequirement(llmwiki, { allOf: ["wiki"] }), true);
  assert.equal(sourceSatisfiesRequirement(llmwiki, { allOf: ["wiki", "graph"] }), true);
  assert.equal(sourceSatisfiesRequirement(llmwiki, { anyOf: ["vector"], allOf: ["wiki"] }), false);
});

test("routeRequirement maps a requirement to the matching sources", () => {
  assert.deepEqual(routeRequirement({ allOf: ["wiki"] }).map((s) => s.id), ["llmwiki"]);
  assert.deepEqual(routeRequirement({ allOf: ["wiki", "graph"] }).map((s) => s.id), ["llmwiki"]);
  assert.deepEqual(routeRequirement({ allOf: ["vector"] }).map((s) => s.id), []);
});

test("wiki_search resolves project and executes against llm_wiki", async () => {
  const services = makeServices();
  const tool = createKnowledgeTools(services).find((t) => t.name === "wiki_search")!;
  const result = await tool.execute("c", { query: "process" }, undefined, undefined, {} as never);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /Wiki search results/);
  assert.match(text, /wiki\/a\.md/);
});

test("wiki_read_page tool executes against llm_wiki", async () => {
  const services = makeServices();
  const tool = createKnowledgeTools(services).find((t) => t.name === "wiki_read_page")!;
  const result = await tool.execute("c", { path: "wiki/a.md" }, undefined, undefined, {} as never);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /# wiki\/a\.md/);
  assert.match(text, /content of wiki\/a\.md/);
});

test("wiki_graph tool executes against llm_wiki graph", async () => {
  const services = makeServices();
  const tool = createKnowledgeTools(services).find((t) => t.name === "wiki_graph")!;
  const result = await tool.execute("c", { q: "topic" }, undefined, undefined, {} as never);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /Wiki graph around "topic"/);
  assert.match(text, /Page 1/);
});

test("tools propagate upstream errors", async () => {
  const services = makeServices({
    llmwiki: {
      async search() {
        throw new Error("llm_wiki unavailable");
      },
    },
  });
  const tool = createKnowledgeTools(services).find((t) => t.name === "wiki_search")!;
  await assert.rejects(
    () => tool.execute("c", { query: "x" }, undefined, undefined, {} as never),
    /llm_wiki unavailable/,
  );
});

test("buildCapabilitiesSystemSection renders source capabilities + intent routing", () => {
  const section = buildCapabilitiesSystemSection();
  assert.match(section, /llm_wiki \(llmwiki\): capabilities = \[wiki, keyword, graph\]/);
  assert.match(section, /Process \/ standards \/ concept definitions/);
});

test("web_search tool wraps the provider and formats {title, url, snippet} rows", async () => {
  const tool = createWebSearchTool({
    search: async () => [
      { title: "DeepSeek-V4", url: "https://example.com", snippet: "Latest model specs." },
    ],
  });
  const result = await tool.execute("c", { query: "deepseek v4" }, undefined, undefined, {} as never);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /Web search results:/);
  assert.match(text, /DeepSeek-V4 \(https:\/\/example\.com\)/);
  assert.match(text, /Latest model specs\./);
});

test("web_search tool reports empty results", async () => {
  const tool = createWebSearchTool({ search: async () => [] });
  const result = await tool.execute("c", { query: "nothing" }, undefined, undefined, {} as never);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /no web results/);
});

test("search_knowledge tool runs the agentic pipeline and formats the answer + sources", async () => {
  const service = new AgenticRetrievalService({
    search: async (query: string) => ({ query, results: [] }),
    judge: {
      transformQuery: async () => ({ action: "direct", retriever: "hybrid" }),
      judgeRelevance: async () => ({ relevant: true }),
      compress: async () => "CALEO hosts the Sommerseminar annually.",
      multiHop: async () => ({ followUps: [], trace: "" }),
      suggestKbUpdate: async () => "",
    },
    webSearch: { search: async () => [] },
  });
  const tool = createSearchKnowledgeTool(service);
  const result = await tool.execute("c", { query: "sommerseminar" }, undefined, undefined, {} as never);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /Answer: CALEO hosts the Sommerseminar annually\./);
});

test("search_knowledge tool surfaces a clarification (needsClarification) as a structured follow-up, not a final answer", async () => {
  const service = new AgenticRetrievalService({
    search: async (query: string) => ({ query, results: [] }),
    judge: {
      transformQuery: async () => ({
        action: "clarify",
        clarification: "Which do you mean?",
        options: ["the company", "a person", "the Latin word"],
      }),
      judgeRelevance: async () => ({ relevant: true }),
      compress: async () => "",
      multiHop: async () => ({ followUps: [], trace: "" }),
      suggestKbUpdate: async () => "",
    },
    webSearch: { search: async () => [] },
  });
  const tool = createSearchKnowledgeTool(service);
  const result = await tool.execute("c", { query: "help me with something" }, undefined, undefined, {} as never);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /CLARIFICATION_REQUESTED/);
  assert.match(text, /Which do you mean\?/);
  assert.match(text, /the company/);
  const details = (result.details ?? {}) as { clarification?: { question: string; options: string[]; query: string } };
  assert.deepEqual(details.clarification, {
    question: "Which do you mean?",
    options: ["the company", "a person", "the Latin word"],
    query: "help me with something",
  });
});

test("search_knowledge tool reports not-found + KB update suggestion + web sources", async () => {
  const service = new AgenticRetrievalService({
    search: async (query: string) => ({ query, results: [] }),
    judge: {
      transformQuery: async () => ({ action: "direct" }),
      judgeRelevance: async () => ({ relevant: false, reason: "no hits" }),
      compress: async () => "",
      multiHop: async () => ({ followUps: [], trace: "" }),
      suggestKbUpdate: async () => "upload a deepseek-v4 doc under ai/models",
    },
    webSearch: {
      search: async () => [{ title: "DeepSeek-V4", url: "https://example.com", snippet: "specs" }],
    },
  });
  const tool = createSearchKnowledgeTool(service);
  const result = await tool.execute("c", { query: "deepseek v4" }, undefined, undefined, {} as never);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /not found in the knowledge base/i);
  assert.match(text, /upload a deepseek-v4 doc under ai\/models/);
  assert.match(text, /https:\/\/example\.com/);
});

test("search_knowledge tool threads scope=global through the agentic pipeline", async () => {
  const seen: Array<{ query: string; options?: { scope?: string } }> = [];
  const service = new AgenticRetrievalService({
    search: async (query: string, options?: { scope?: string }) => {
      seen.push({ query, options });
      return { query, results: [] };
    },
    judge: {
      transformQuery: async () => ({ action: "direct" }),
      judgeRelevance: async () => ({ relevant: true }),
      compress: async () => "Global answer.",
      multiHop: async () => ({ followUps: [], trace: "" }),
      suggestKbUpdate: async () => "",
    },
    webSearch: { search: async () => [] },
  });
  const tool = createSearchKnowledgeTool(service);

  await tool.execute("c", { query: "what themes span the corpus?", scope: "global" }, undefined, undefined, {} as never);

  assert.equal(seen[0]?.options?.scope, "global", "scope forwarded into answer()'s search options");
});
