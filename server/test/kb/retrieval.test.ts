import { test } from "node:test";
import assert from "node:assert/strict";
import { KnowledgeRetrievalService } from "../../src/kb/retrieval.js";
import type { LlmWikiClient } from "../../src/kb/llmwiki.js";
import type { Neo4jRetrievalService } from "../../src/kb/store/retrieval.js";

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

function stubNeo4j(
  hits: Array<Partial<{ id: string; text: string; topic?: string; documentId?: string; source: string; score: number; related: string[] }>> = [],
  graph: { nodes: { id: string; label: string; type?: string }[]; edges: { source: string; target: string }[] } = { nodes: [], edges: [] },
): Neo4jRetrievalService {
  return {
    search: async () => ({
      query: "",
      hits: hits.map((h) => ({
        id: h.id ?? "c1",
        text: h.text ?? "",
        ...(h.topic !== undefined ? { topic: h.topic } : {}),
        ...(h.documentId !== undefined ? { documentId: h.documentId } : {}),
        source: (h.source ?? "bm25") as "vector" | "bm25" | "graph",
        score: h.score ?? 0.9,
        ...(h.related ? { related: h.related } : {}),
      })),
    }),
    toolsSearch: async () => ({ query: "", hits: [] }),
    getGraph: async () => graph,
  } as unknown as Neo4jRetrievalService;
}

function makeService(overrides: {
  llmwiki?: Partial<LlmWikiClient>;
  neo4j?: Neo4jRetrievalService;
  projectId?: string;
} = {}) {
  return new KnowledgeRetrievalService({
    llmwiki: stubLlmwiki(overrides.llmwiki),
    ...(overrides.neo4j ? { neo4j: overrides.neo4j } : {}),
    projectId: overrides.projectId,
  });
}

test("getGraph returns the Neo4j entity-relation graph", async () => {
  const neo4j = stubNeo4j([], {
    nodes: [
      { id: "Alpha", label: "Alpha", type: "concept" },
      { id: "Beta", label: "Beta", type: "org" },
    ],
    edges: [{ source: "Alpha", target: "Beta" }],
  });
  const service = makeService({ neo4j });

  const graph = await service.getGraph();
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.nodes[0]!.label, "Alpha");
  assert.equal(graph.nodes[0]!.type, "concept");
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0]!.source, "Alpha");
  assert.equal(graph.edges[0]!.target, "Beta");
});

test("getGraph returns an empty graph when no Neo4j store is wired", async () => {
  const service = makeService();
  const graph = await service.getGraph();
  assert.deepEqual(graph, { nodes: [], edges: [] });
});

test("getGraphTopics returns distinct sorted topics from wiki pages", async () => {
  const llmwiki = stubLlmwiki({
    listWikiPages: async () => [
      { path: "a.md", topic: "sommerseminar" },
      { path: "b.md", topic: "ops" },
      { path: "c.md", topic: "sommerseminar" },
      { path: "d.md" },
    ],
  });
  const service = makeService({ llmwiki });

  const topics = await service.getGraphTopics();
  assert.deepEqual(topics, ["ops", "sommerseminar"]);
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

test("getWikiTree attaches frontmatter type + topic metadata to file nodes", async () => {
  const tree = [
    { name: "sommerseminar", path: "wiki/sommerseminar", isDir: true, children: [
      { name: "sommerseminar-l-sen.md", path: "wiki/sommerseminar/sommerseminar-l-sen.md", isDir: false },
    ] },
    { name: "concepts", path: "wiki/concepts", isDir: true, children: [
      { name: "example.md", path: "wiki/concepts/example.md", isDir: false },
    ] },
  ];
  const pages = [
    { path: "wiki/sommerseminar/sommerseminar-l-sen.md", type: "concept", topic: "sommerseminar" },
    { path: "wiki/concepts/example.md", type: "entity" },
  ];
  const llmwiki = stubLlmwiki({
    getFileTree: async () => ({ files: tree }),
    listWikiPages: async () => pages,
  });
  const service = makeService({ llmwiki });

  const result = await service.getWikiTree();
  const seminar = result[0]!.children![0]!;
  assert.equal(seminar.type, "concept");
  assert.equal(seminar.topic, "sommerseminar");
  const example = result[1]!.children![0]!;
  assert.equal(example.type, "entity");
  assert.equal(example.topic, undefined);
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

test("readWikiImage resolves the image against the on-disk wiki dir and returns bytes + content-type (G3.S5.T5)", async () => {
  const readPaths: string[] = [];
  const service = new KnowledgeRetrievalService({
    llmwiki: stubLlmwiki({
      listProjects: async () => ({
        projects: [{ id: "proj1", name: "P1", path: "/data/wiki", current: false }],
        currentProject: null,
      }),
    }),
    readFile: async (path) => {
      readPaths.push(path);
      return Buffer.from("PNG-BYTES");
    },
  });

  const { data, contentType } = await service.readWikiImage(
    "wiki/sommerseminar/images/report.pdf/image_000000_abc.png",
  );
  assert.equal(data.toString(), "PNG-BYTES");
  assert.equal(contentType, "image/png");
  assert.deepEqual(readPaths, [
    "/data/wiki/wiki/sommerseminar/images/report.pdf/image_000000_abc.png",
  ]);
});

test("readWikiImage uses the configured wikiDir and rejects traversal paths", async () => {
  const readPaths: string[] = [];
  const service = new KnowledgeRetrievalService({
    llmwiki: stubLlmwiki(),
    wikiDir: "/data/wiki",
    readFile: async (path) => {
      readPaths.push(path);
      return Buffer.from("x");
    },
  });

  const { contentType } = await service.readWikiImage("wiki/concepts/images/a.png");
  assert.equal(contentType, "image/png");
  assert.deepEqual(readPaths, ["/data/wiki/concepts/images/a.png"]);

  await assert.rejects(
    () => service.readWikiImage("wiki/../etc/passwd"),
    /invalid wiki image path/,
  );
  await assert.rejects(
    () => service.readWikiImage("wiki/concepts/images/..%2fsecret.png"),
    /invalid wiki image path/,
  );
});

test("search returns keyword hits from llm_wiki when no Neo4j store is wired", async () => {
  const llmwiki = stubLlmwiki({
    search: async () => ({
      results: [
        { path: "runbook.md", title: "Runbook", snippet: "Incident handling", score: 0.9 },
      ],
    }),
  });
  const service = makeService({ llmwiki });

  const result = await service.search("how to handle incidents");
  assert.equal(result.query, "how to handle incidents");
  assert.deepEqual(
    result.results.map((r) => r.source),
    ["llmwiki"],
  );
  assert.equal(result.results[0]!.path, "runbook.md");
  assert.equal(result.results[0]!.title, "Runbook");
});

test("search returns empty results when both systems have nothing", async () => {
  const service = makeService();
  const result = await service.search("nothing here");
  assert.deepEqual(result.results, []);
});

test("search with a Neo4j store fuses Neo4j + llm_wiki hits", async () => {
  const neo4j = stubNeo4j([
    { id: "doc1:c1", text: "bus station guide", topic: "transport", documentId: "doc1", source: "bm25", score: 0.9 },
    { id: "ZOB München", text: "central bus station", source: "graph", score: 0.8, related: ["CALEO", "MVV"] },
  ]);
  const llmwiki = stubLlmwiki({
    search: async () => ({
      results: [{ path: "bus.md", title: "Bus", snippet: "keyword hit", score: 0.7 }],
    }),
  });
  const service = makeService({ llmwiki, neo4j });

  const result = await service.search("bus station", { topic: "transport" });

  assert.equal(result.query, "bus station");
  const sources = result.results.map((r) => r.source).sort();
  assert.deepEqual(sources, ["llmwiki", "neo4j", "neo4j"], "Neo4j hits + llm_wiki keyword source fused");
  const neoHits = result.results.filter((r) => r.source === "neo4j");
  assert.equal(neoHits[0]!.snippet, "bus station guide");
  assert.equal(neoHits[1]!.title, "ZOB München → CALEO, MVV", "graph hit renders the relation neighborhood");
});

test("search with a failing Neo4j store still returns llm_wiki hits", async () => {
  const neo4j = {
    search: async () => {
      throw new Error("neo4j down");
    },
    toolsSearch: async () => ({ query: "", hits: [] }),
  } as unknown as Neo4jRetrievalService;
  const llmwiki = stubLlmwiki({
    search: async () => ({
      results: [{ path: "runbook.md", title: "Runbook", snippet: "Incident handling", score: 0.9 }],
    }),
  });
  const service = makeService({ llmwiki, neo4j });

  const result = await service.search("incident handling");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]!.source, "llmwiki");
  assert.equal(result.results[0]!.path, "runbook.md");
});
