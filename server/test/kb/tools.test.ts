import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createKnowledgeTools,
  KNOWLEDGE_SOURCES,
  routeRequirement,
  sourceSatisfiesRequirement,
  buildCapabilitiesSystemSection,
} from "../../src/kb/tools.js";

function makeServices(overrides: Record<string, unknown> = {}) {
  return {
    lightrag: {
      async query(query: string, opts: { mode?: string; topK?: number }) {
        return {
          response: `answer to ${query}`,
          references: [{ reference_id: "1", file_path: "doc.md", content: ["chunk-a"] }],
        };
      },
      async getGraph(label: string) {
        return {
          nodes: [{ id: "n1", label }],
          edges: [{ source: "n1", target: "n2", weight: 1 }],
        };
      },
      ...(overrides.lightrag ?? {}),
    },
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

test("createKnowledgeTools registers the 5 knowledge tools with capability requirements", () => {
  const tools = createKnowledgeTools(makeServices());
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "knowledge_search",
    "query_graph",
    "wiki_graph",
    "wiki_read_page",
    "wiki_search",
  ]);

  assert.deepEqual(byName.knowledge_search.requireCapability, { anyOf: ["vector", "keyword"] });
  assert.deepEqual(byName.query_graph.requireCapability, { anyOf: ["vector", "graph"] });
  assert.deepEqual(byName.wiki_search.requireCapability, { allOf: ["wiki"] });
  assert.deepEqual(byName.wiki_read_page.requireCapability, { allOf: ["wiki"] });
  assert.deepEqual(byName.wiki_graph.requireCapability, { allOf: ["wiki", "graph"] });
});

test("capability declarations: LightRAG = vector+graph, llm_wiki = wiki+keyword+graph", () => {
  const lightrag = KNOWLEDGE_SOURCES.find((s) => s.id === "lightrag");
  const llmwiki = KNOWLEDGE_SOURCES.find((s) => s.id === "llmwiki");
  assert.deepEqual(lightrag?.capabilities, ["vector", "graph"]);
  assert.deepEqual(llmwiki?.capabilities, ["wiki", "keyword", "graph"]);
});

test("sourceSatisfiesRequirement evaluates AnyOf and AllOf", () => {
  const lightrag = KNOWLEDGE_SOURCES[0];
  const llmwiki = KNOWLEDGE_SOURCES[1];

  assert.equal(sourceSatisfiesRequirement(lightrag, { anyOf: ["vector", "keyword"] }), true);
  assert.equal(sourceSatisfiesRequirement(llmwiki, { anyOf: ["vector", "keyword"] }), true);
  assert.equal(sourceSatisfiesRequirement(lightrag, { allOf: ["wiki"] }), false);
  assert.equal(sourceSatisfiesRequirement(llmwiki, { allOf: ["wiki"] }), true);
  assert.equal(sourceSatisfiesRequirement(lightrag, { allOf: ["wiki", "graph"] }), false);
  assert.equal(sourceSatisfiesRequirement(llmwiki, { allOf: ["wiki", "graph"] }), true);
  assert.equal(sourceSatisfiesRequirement(llmwiki, { anyOf: ["vector"], allOf: ["wiki"] }), false);
});

test("routeRequirement maps a requirement to the matching sources", () => {
  assert.deepEqual(routeRequirement({ anyOf: ["vector", "keyword"] }).map((s) => s.id), ["lightrag", "llmwiki"]);
  assert.deepEqual(routeRequirement({ allOf: ["wiki"] }).map((s) => s.id), ["llmwiki"]);
  assert.deepEqual(routeRequirement({ allOf: ["wiki", "graph"] }).map((s) => s.id), ["llmwiki"]);
  assert.deepEqual(routeRequirement({ allOf: ["vector"] }).map((s) => s.id), ["lightrag"]);
});

test("knowledge_search tool executes against LightRAG and returns answer + references", async () => {
  const services = makeServices();
  const tool = createKnowledgeTools(services).find((t) => t.name === "knowledge_search")!;
  const result = await tool.execute("call-1", { query: "facts about pi", topK: 3 }, undefined, undefined, {} as never);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /answer to facts about pi/);
  assert.match(text, /doc\.md/);
});

test("query_graph tool executes against LightRAG graph", async () => {
  const services = makeServices();
  const tool = createKnowledgeTools(services).find((t) => t.name === "query_graph")!;
  const result = await tool.execute("c", { label: "Pi SDK" }, undefined, undefined, {} as never);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /Graph around "Pi SDK"/);
  assert.match(text, /n1 -> n2/);
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
    lightrag: {
      async query() {
        throw new Error("LightRAG unavailable");
      },
    },
  });
  const tool = createKnowledgeTools(services).find((t) => t.name === "knowledge_search")!;
  await assert.rejects(
    () => tool.execute("c", { query: "x" }, undefined, undefined, {} as never),
    /LightRAG unavailable/,
  );
});

test("buildCapabilitiesSystemSection renders source capabilities + intent routing", () => {
  const section = buildCapabilitiesSystemSection();
  assert.match(section, /LightRAG \(lightrag\): capabilities = \[vector, graph\]/);
  assert.match(section, /llm_wiki \(llmwiki\): capabilities = \[wiki, keyword, graph\]/);
  assert.match(section, /Process \/ standards \/ concept definitions/);
  assert.match(section, /query_graph/);
});
