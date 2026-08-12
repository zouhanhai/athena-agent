import { test } from "node:test";
import assert from "node:assert/strict";
import { KnowledgeRetrievalService } from "../../src/kb/retrieval.js";
import { WikiFrontmatterSyncer } from "../../src/kb/wiki-frontmatter.js";
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
  hits: Array<Partial<{ id: string; text: string; topic?: string; documentId?: string; source: string; score: number; related: string[]; wikiPath?: string; sectionPath?: string; siblings?: string[] }>> = [],
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
        ...(h.wikiPath !== undefined ? { wikiPath: h.wikiPath } : {}),
        ...(h.sectionPath !== undefined ? { sectionPath: h.sectionPath } : {}),
        ...(h.siblings ? { siblings: h.siblings } : {}),
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
    { id: "doc1:c2", text: "central bus station", source: "graph", score: 0.8, related: ["ZOB München", "CALEO", "MVV"] },
  ]);
  const llmwiki = stubLlmwiki({
    search: async () => ({
      results: [{ path: "wiki/transport/bus.md", title: "Bus", snippet: "keyword hit", score: 0.7 }],
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

test("topic-scoped search expands the scope into the wiki frontmatter topic subtree and scopes the Neo4j store (G4.S3.T4)", async () => {
  const seenTopics: string[][] = [];
  const neo4j = {
    search: async (_query: string, options: { topics?: string[] }) => {
      seenTopics.push(options.topics ?? []);
      return { query: "", hits: [] };
    },
    toolsSearch: async () => ({ query: "", hits: [] }),
    getGraph: async () => ({ nodes: [], edges: [] }),
  } as unknown as Neo4jRetrievalService;
  const llmwiki = stubLlmwiki({
    listWikiPages: async () => [
      { path: "a.md", topic: "sap" },
      { path: "b.md", topic: "sap/fiori" },
      { path: "c.md", topic: "sap/s4hana/abap" },
      { path: "d.md", topic: "transport" },
    ],
    search: async () => ({ results: [] }),
  });
  const service = makeService({ llmwiki, neo4j });

  await service.search("fiori", { topic: "sap" });

  assert.deepEqual(
    seenTopics[0],
    ["sap", "sap/fiori", "sap/s4hana/abap"],
    "scope expanded to the full frontmatter subtree and handed to the Neo4j store",
  );
});

test("topic-scoped search filters out llm_wiki keyword hits outside the topic subtree (G4.S3.T4)", async () => {
  const neo4j = stubNeo4j([]);
  const llmwiki = stubLlmwiki({
    listWikiPages: async () => [
      { path: "a.md", topic: "sap/fiori" },
      { path: "b.md", topic: "transport" },
    ],
    search: async () => ({
      results: [
        { path: "a.md", title: "Fiori", snippet: "in-subtree", score: 0.7 },
        { path: "b.md", title: "Bus", snippet: "out-of-subtree", score: 0.9 },
      ],
    }),
  });
  const service = makeService({ llmwiki, neo4j });

  const result = await service.search("guide", { topic: "sap" });

  const paths = result.results.map((r) => r.path);
  assert.deepEqual(paths, ["a.md"], "only the in-subtree keyword hit survives the scope");
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

test("search maps Neo4j hits with wikiPath + sectionPath + same-section siblings onto KnowledgeSearchResult", async () => {
  const neo4j = stubNeo4j([
    {
      id: "doc1:c1",
      text: "bus station guide",
      topic: "transport",
      documentId: "doc1",
      source: "bm25",
      score: 0.9,
      wikiPath: "wiki/transport/bus.md",
      sectionPath: "Alpha / Beta",
      siblings: ["same-section neighbor"],
    },
  ]);
  const service = makeService({ llmwiki: stubLlmwiki({ search: async () => ({ results: [] }) }), neo4j });

  const result = await service.search("bus station");

  const neoHit = result.results.find((r) => r.source === "neo4j")!;
  assert.equal(neoHit.wikiPath, "wiki/transport/bus.md");
  assert.equal(neoHit.sectionPath, "Alpha / Beta");
  assert.deepEqual(neoHit.siblings, ["same-section neighbor"]);
});

test("readWikiPage increments read_count on the surfaced page via the canonical syncer (G4.S3.T1)", async () => {
  const files = new Map<string, string>([
    [
      "/data/wiki/concepts/runbook.md",
      [
        "---",
        "type: manual",
        "title: Runbook",
        "created: 2026-01-01",
        "updated: 2026-01-01",
        "read_count: 2",
        "confidence: 1",
        "---",
        "",
        "# Runbook",
        "body",
      ].join("\n"),
    ],
  ]);
  const syncer = new WikiFrontmatterSyncer({
    wikiDir: "/data/wiki",
    readFile: async (path) => files.get(path) ?? "",
    writeFile: async (path, content) => {
      files.set(path, content);
    },
  });
  const llmwiki = stubLlmwiki({
    readFile: async (_projectId, path) => ({
      path,
      content: files.get("/data/wiki/concepts/runbook.md")!,
    }),
  });
  const service = new KnowledgeRetrievalService({ llmwiki, frontmatter: syncer });

  const page = await service.readWikiPage("wiki/concepts/runbook.md");

  assert.equal(page.path, "wiki/concepts/runbook.md");
  assert.match(files.get("/data/wiki/concepts/runbook.md")!, /read_count: 3\n/, "wiki frontmatter read_count 2 → 3");
});

test("search increments read_count on each surfaced wiki page once (deduped), best-effort", async () => {
  const files = new Map<string, string>([
    [
      "/data/wiki/transport/bus.md",
      [
        "---",
        "type: concept",
        "title: Bus",
        "created: 2026-01-01",
        "updated: 2026-01-01",
        "read_count: 0",
        "confidence: 1",
        "---",
        "",
        "# Bus",
        "body",
      ].join("\n"),
    ],
  ]);
  const syncer = new WikiFrontmatterSyncer({
    wikiDir: "/data/wiki",
    readFile: async (path) => files.get(path) ?? "",
    writeFile: async (path, content) => {
      files.set(path, content);
    },
  });
  const neo4j = stubNeo4j([
    {
      id: "doc1:c1",
      text: "bus station guide",
      topic: "transport",
      documentId: "doc1",
      source: "bm25",
      score: 0.9,
      wikiPath: "wiki/transport/bus.md",
    },
    {
      id: "doc1:c2",
      text: "central bus station",
      documentId: "doc1",
      source: "graph",
      score: 0.8,
      wikiPath: "wiki/transport/bus.md",
    },
  ]);
  const llmwiki = stubLlmwiki({
    search: async () => ({
      results: [{ path: "wiki/transport/bus.md", title: "Bus", snippet: "kw", score: 0.7 }],
    }),
  });
  const service = new KnowledgeRetrievalService({ llmwiki, neo4j, frontmatter: syncer });

  const result = await service.search("bus station");
  assert.equal(result.results.length, 3);

  const written = files.get("/data/wiki/transport/bus.md")!;
  assert.match(written, /read_count: 1\n/, "read_count bumped exactly once despite multiple hits");
});

test("read_count tracking never fails the search when the wiki page is missing on disk", async () => {
  const syncer = new WikiFrontmatterSyncer({
    wikiDir: "/data/wiki",
    readFile: async () => {
      throw new Error("ENOENT");
    },
    writeFile: async () => {},
  });
  const neo4j = stubNeo4j([
    {
      id: "doc1:c1",
      text: "bus station guide",
      topic: "transport",
      documentId: "doc1",
      source: "bm25",
      score: 0.9,
      wikiPath: "wiki/transport/bus.md",
    },
  ]);
  const llmwiki = stubLlmwiki({ search: async () => ({ results: [] }) });
  const service = new KnowledgeRetrievalService({ llmwiki, neo4j, frontmatter: syncer });

  const result = await service.search("bus station");
  assert.equal(result.results.length, 1, "search still returns hits when read_count tracking fails");
});

// ---- G4.S3.T6: search integration (term query expansion + QA reference) ----

function stubMappings(
  rows: Array<{ term: string; canonicals: string[] }> = [
    { term: "C-Day", canonicals: ["CALEO Day"] },
    { term: "HW", canonicals: ["Haushaltswaren"] },
  ],
) {
  return {
    upsert: async () => {
      throw new Error("not used");
    },
    list: async () =>
      rows.map((r) => ({
        id: r.term,
        term: r.term,
        canonicals: r.canonicals,
        created_at: "",
        updated_at: "",
      })),
    remove: async () => false,
    findByTerm: async () => null,
    seed: async () => {},
    close: async () => {},
  };
}

function stubQaReference(overrides: Record<string, unknown> = {}) {
  return {
    findReference: async (question: string) => {
      if (question.toLowerCase().includes("c-day") || question.toLowerCase().includes("c day")) {
        return {
          id: "pair-1",
          question: "What is C-Day?",
          answer: "C-Day is the CALEO Day.",
          score: 0.95,
        };
      }
      return null;
    },
    ...overrides,
  };
}

test("search expands colloquial terms into the canonical form for BOTH the Neo4j and llm_wiki queries", async () => {
  let neo4jQuery = "";
  let wikiQuery = "";
  const neo4j = stubNeo4j([
    { id: "doc1:c1", text: "CALEO Day planning guide", documentId: "doc1", source: "bm25", score: 0.9 },
  ] as never);
  // re-wrap to capture the query text
  const neo4jWithCapture = {
    ...neo4j,
    search: async (query: string) => {
      neo4jQuery = query;
      return {
        query,
        hits: [
          { id: "doc1:c1", text: "CALEO Day planning guide", documentId: "doc1", source: "bm25", score: 0.9 },
        ],
      };
    },
  } as unknown as Neo4jRetrievalService;
  const llmwiki = stubLlmwiki({
    search: async (_projectId, query) => {
      wikiQuery = query;
      return {
        results: [{ path: "wiki/c-day.md", title: "CALEO Day", snippet: "kw", score: 0.7 }],
      };
    },
  });
  const service = new KnowledgeRetrievalService({
    llmwiki,
    neo4j: neo4jWithCapture,
    mappings: stubMappings(),
  });

  await service.search("when is C-Day?");

  assert.equal(neo4jQuery, "when is CALEO Day?", "Neo4j query gets the expanded canonical term");
  assert.equal(wikiQuery, "when is CALEO Day?", "llm_wiki query gets the expanded canonical term");
});

test("search expands a one-to-many term into an OR alternative for BOTH search paths (G4.S3.T6)", async () => {
  let neo4jQuery = "";
  let wikiQuery = "";
  const neo4j = stubNeo4j([] as never);
  const neo4jWithCapture = {
    ...neo4j,
    search: async (query: string) => {
      neo4jQuery = query;
      return { query, hits: [] };
    },
  } as unknown as Neo4jRetrievalService;
  const llmwiki = stubLlmwiki({
    search: async (_projectId, query) => {
      wikiQuery = query;
      return { results: [] };
    },
  });
  const service = new KnowledgeRetrievalService({
    llmwiki,
    neo4j: neo4jWithCapture,
    mappings: stubMappings([
      { term: "EDay", canonicals: ["Expert Day", "Principle Day"] },
    ]),
  });

  await service.search("what is EDay?");

  assert.equal(
    neo4jQuery,
    "what is (Expert Day OR Principle Day)?",
    "Neo4j query expands the one-to-many term to an OR alternative",
  );
  assert.equal(
    wikiQuery,
    "what is (Expert Day OR Principle Day)?",
    "llm_wiki query expands the one-to-many term to an OR alternative",
  );
});

test("search fuzzy-matches a term's spacing/hyphen variants for BOTH search paths (G4.S3.T6)", async () => {
  let neo4jQuery = "";
  let wikiQuery = "";
  const neo4j = stubNeo4j([] as never);
  const neo4jWithCapture = {
    ...neo4j,
    search: async (query: string) => {
      neo4jQuery = query;
      return { query, hits: [] };
    },
  } as unknown as Neo4jRetrievalService;
  const llmwiki = stubLlmwiki({
    search: async (_projectId, query) => {
      wikiQuery = query;
      return { results: [] };
    },
  });
  const service = new KnowledgeRetrievalService({
    llmwiki,
    neo4j: neo4jWithCapture,
    mappings: stubMappings([{ term: "CDay", canonicals: ["CALEO Day"] }]),
  });

  await service.search("when is C Day?");

  assert.equal(neo4jQuery, "when is CALEO Day?", "spaced variant matches the compact stored term");
  assert.equal(wikiQuery, "when is CALEO Day?", "llm_wiki query gets the same expansion");

  await service.search("when is c-day?");

  assert.equal(neo4jQuery, "when is CALEO Day?", "hyphenated variant also expands");
  assert.equal(wikiQuery, "when is CALEO Day?", "hyphenated variant also expands");
});

test("search attaches a matching QA reference but STILL runs the RAG search (not a short-circuit)", async () => {
  let neo4jCalled = 0;
  const neo4j = {
    search: async () => {
      neo4jCalled += 1;
      return {
        query: "",
        hits: [{ id: "doc1:c1", text: "fresh retrieval", documentId: "doc1", source: "bm25", score: 0.9 }],
      };
    },
  } as unknown as Neo4jRetrievalService;
  const llmwiki = stubLlmwiki({ search: async () => ({ results: [] }) });
  const service = new KnowledgeRetrievalService({
    llmwiki,
    neo4j,
    qa: stubQaReference(),
  });

  const result = await service.search("What is C-Day?");

  assert.ok(result.qaReference, "the QA pair is surfaced as reference context");
  assert.equal(result.qaReference!.answer, "C-Day is the CALEO Day.");
  assert.equal(result.results.length, 1, "RAG results still present — QA is NOT a short-circuit");
  assert.equal(neo4jCalled, 1, "the RAG search still ran");
});

test("search omits qaReference when no stored question is similar", async () => {
  const neo4j = stubNeo4j([
    { id: "doc1:c1", text: "bus guide", documentId: "doc1", source: "bm25", score: 0.9 },
  ] as never);
  const llmwiki = stubLlmwiki({ search: async () => ({ results: [] }) });
  const service = new KnowledgeRetrievalService({ llmwiki, neo4j, qa: stubQaReference() });

  const result = await service.search("public transport timetables");
  assert.equal(result.qaReference, undefined);
});
