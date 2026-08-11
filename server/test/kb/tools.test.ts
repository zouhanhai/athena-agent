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
