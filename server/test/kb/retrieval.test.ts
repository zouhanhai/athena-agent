import { test } from "node:test";
import assert from "node:assert/strict";
import { KnowledgeRetrievalService } from "../../src/kb/retrieval.js";
import type { LightRagClient } from "../../src/kb/lightrag.js";
import type { LlmWikiClient } from "../../src/kb/llmwiki.js";

function stubLightrag(overrides: Partial<LightRagClient> = {}): LightRagClient {
  return {
    getGraph: async (label: string) => ({ nodes: [], edges: [], label }),
    query: async () => ({ response: "" }),
    ...overrides,
  } as unknown as LightRagClient;
}

function stubLlmwiki(overrides: Partial<LlmWikiClient> = {}): LlmWikiClient {
  return {
    listProjects: async () => ({
      projects: [{ id: "proj1", name: "P1", path: "/p", current: false }],
      currentProject: null,
    }),
    getFileTree: async () => ({ files: [] }),
    readFile: async () => ({ path: "", content: "" }),
    search: async () => ({ results: [] }),
    ...overrides,
  } as unknown as LlmWikiClient;
}

function makeService(overrides: {
  lightrag?: Partial<LightRagClient>;
  llmwiki?: Partial<LlmWikiClient>;
  projectId?: string;
} = {}) {
  return new KnowledgeRetrievalService({
    lightrag: stubLightrag(overrides.lightrag),
    llmwiki: stubLlmwiki(overrides.llmwiki),
    projectId: overrides.projectId,
  });
}

test("getGraph normalizes LightRAG nodes/edges and uses default label when omitted", async () => {
  const lightrag = stubLightrag({
    getGraph: async (label) => ({
      nodes: [
        { id: "n1", label: "Alpha", type: "concept" },
        { label: "Beta", type: "org" },
        {},
      ],
      edges: [
        { source: "n1", target: "n2", weight: 2 },
        {},
      ],
    }),
  });
  const service = makeService({ lightrag });

  const graph = await service.getGraph();
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.nodes[0]!.label, "Alpha");
  assert.equal(graph.nodes[1]!.label, "Beta");
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0]!.weight, 2);
});

test("getGraph forwards the requested label to LightRAG", async () => {
  let calledWith: string | undefined;
  const lightrag = stubLightrag({
    getGraph: async (label) => {
      calledWith = label;
      return { nodes: [], edges: [] };
    },
  });
  const service = makeService({ lightrag });

  await service.getGraph("finance");
  assert.equal(calledWith, "finance");
});

test("getWikiTree resolves project id and returns the wiki file tree", async () => {
  const llmwiki = stubLlmwiki({
    listProjects: async () => ({
      projects: [{ id: "proj1", name: "P1", path: "/p", current: false }],
      currentProject: null,
    }),
    getFileTree: async (projectId) => {
      assert.equal(projectId, "proj1");
      return {
        files: [{ name: "a.md", path: "a.md", isDir: false }],
      };
    },
  });
  const service = makeService({ llmwiki });

  const tree = await service.getWikiTree();
  assert.equal(tree.length, 1);
  assert.equal(tree[0]!.name, "a.md");
});

test("getWikiTree uses the configured projectId", async () => {
  let requestedProject: string | undefined;
  const llmwiki = stubLlmwiki({
    getFileTree: async (projectId) => {
      requestedProject = projectId;
      return { files: [] };
    },
  });
  const service = makeService({ llmwiki, projectId: "custom" });

  await service.getWikiTree();
  assert.equal(requestedProject, "custom");
});

test("readWikiPage returns the markdown content for a path", async () => {
  const llmwiki = stubLlmwiki({
    readFile: async (_projectId, path) => ({ path, content: "# Title\nbody" }),
  });
  const service = makeService({ llmwiki });

  const page = await service.readWikiPage("docs/runbook.md");
  assert.equal(page.path, "docs/runbook.md");
  assert.equal(page.content, "# Title\nbody");
});

test("search fuses LightRAG answer and llm_wiki hits with source tags", async () => {
  const lightrag = stubLightrag({
    query: async () => ({
      response: "The on-call runbook describes incident handling.",
      references: [{ reference_id: "r1", file_path: "runbook.md" }],
    }),
  });
  const llmwiki = stubLlmwiki({
    search: async () => ({
      results: [
        { path: "runbook.md", title: "Runbook", snippet: "Incident handling", score: 0.9 },
      ],
    }),
  });
  const service = makeService({ lightrag, llmwiki });

  const result = await service.search("how to handle incidents");
  assert.equal(result.query, "how to handle incidents");
  const lightragHit = result.results.find((r) => r.source === "lightrag");
  const wikiHit = result.results.find((r) => r.source === "llmwiki");
  assert.ok(lightragHit);
  assert.match(lightragHit!.snippet ?? "", /incident handling/);
  assert.ok(wikiHit);
  assert.equal(wikiHit!.path, "runbook.md");
  assert.equal(wikiHit!.title, "Runbook");
});

test("search returns empty results when both systems have nothing", async () => {
  const service = makeService();
  const result = await service.search("nothing here");
  assert.deepEqual(result.results, []);
});
