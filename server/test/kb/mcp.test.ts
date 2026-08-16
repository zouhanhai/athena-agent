/**
 * G4.S7.T3 — KB-as-MCP tool server tests.
 *
 * These tests exercise the McpServer directly over the SDK's in-memory
 * transport using a real MCP Client, i.e. the exact public seam an external
 * agent (OpenCode/Claude Code/Codex/Hermes) sees: listTools + callTool.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildKbMcpServer } from "../../src/kb/mcp.js";
import { KnowledgeRetrievalService } from "../../src/kb/retrieval.js";
import { MemorySemanticMappingStore } from "../../src/kb/semantic-mappings.js";
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
    readFile: async (_projectId, path) => ({ path, content: "" }),
    search: async () => ({ results: [] }),
    ...overrides,
  } as unknown as LlmWikiClient;
}

function stubNeo4j(
  hits: Array<{
    id?: string;
    text?: string;
    documentId?: string;
    wikiPath?: string;
    sectionPath?: string;
    siblings?: string[];
    source?: "vector" | "bm25" | "graph";
    score?: number;
    related?: string[];
  }> = [],
  options: { topics?: string[][] } = {},
): Neo4jRetrievalService {
  const seenTopics: string[][] = [];
  const search = async (_query: string, opts: { topics?: string[] } = {}) => {
    if (opts.topics) seenTopics.push(opts.topics);
    return {
      query: _query,
      hits: hits.map((h) => ({
        id: h.id ?? "c1",
        text: h.text ?? "",
        ...(h.documentId !== undefined ? { documentId: h.documentId } : {}),
        ...(h.wikiPath !== undefined ? { wikiPath: h.wikiPath } : {}),
        ...(h.sectionPath !== undefined ? { sectionPath: h.sectionPath } : {}),
        ...(h.siblings ? { siblings: h.siblings } : {}),
        source: h.source ?? "bm25",
        score: h.score ?? 0.9,
        ...(h.related ? { related: h.related } : {}),
      })),
    };
  };
  return {
    ...(options.topics ? { _seenTopics: seenTopics } : {}),
    search,
    toolsSearch: async () => ({ query: "", hits: [] }),
    getGraph: async () => ({
      nodes: [
        { id: "ZOB", label: "ZOB München", type: "entity" },
        { id: "CALEO", label: "CALEO", type: "org" },
      ],
      edges: [{ source: "ZOB", target: "CALEO" }],
    }),
  } as unknown as Neo4jRetrievalService;
}

/** Connect the MCP server to an in-memory client. */
async function connectClient(server: McpServer): Promise<Client> {
  const client = new Client({ name: "kb-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function call(
  client: Client,
  name: string,
  args?: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  return client.callTool({
    name,
    arguments: args ?? {},
  }) as unknown as Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function parseText(result: { content: Array<{ type: string; text: string }> }): unknown {
  const block = result.content[0];
  assert.ok(block, "tool returned a content block");
  assert.equal(block.type, "text");
  return JSON.parse(block.text);
}

test("the KB MCP server exposes exactly the 5 KB-retrieval tools", async () => {
  const server = buildKbMcpServer({ retrieval: new KnowledgeRetrievalService({ llmwiki: stubLlmwiki() }) });
  const client = await connectClient(server);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "get_graph",
      "get_kb_topics",
      "get_wiki_page",
      "get_wiki_tree",
      "search_knowledge",
    ]);
    const descriptions = new Map(tools.map((t) => [t.name, t.description]));
    assert.match(descriptions.get("search_knowledge") ?? "", /topic subtree/);
    assert.match(descriptions.get("search_knowledge") ?? "", /get_kb_topics/);
    assert.match(descriptions.get("search_knowledge") ?? "", /whole-corpus/);
    for (const name of names) {
      assert.ok(descriptions.get(name), `tool ${name} has a description`);
    }
  } finally {
    await server.close();
    await client.close();
  }
});

test("search_knowledge returns fused hits carrying wikiPath/sectionPath", async () => {
  const neo4j = stubNeo4j([
    {
      id: "doc1:c1",
      text: "bus station guide",
      documentId: "doc1",
      wikiPath: "wiki/transport/bus.md",
      sectionPath: "Transport / Bus Station",
      source: "bm25",
      score: 0.9,
    },
  ]);
  const retrieval = new KnowledgeRetrievalService({
    llmwiki: stubLlmwiki({ search: async () => ({ results: [] }) }),
    neo4j,
  });
  const server = buildKbMcpServer({ retrieval });
  const client = await connectClient(server);
  try {
    const result = await call(client, "search_knowledge", { query: "bus station" });
    assert.equal(result.isError, undefined);
    const body = parseText(result) as {
      query: string;
      results: Array<{
        wikiPath?: string;
        sectionPath?: string;
        source: string;
        snippet: string;
        title: string;
      }>;
    };
    assert.equal(body.query, "bus station");
    assert.equal(body.results.length, 1);
    const hit = body.results[0]!;
    assert.equal(hit.source, "neo4j");
    assert.equal(hit.wikiPath, "wiki/transport/bus.md");
    assert.equal(hit.sectionPath, "Transport / Bus Station");
  } finally {
    await server.close();
    await client.close();
  }
});

test("search_knowledge forwards the topic subtree to scope the search", async () => {
  const seenTopics: string[][] = [];
  const neo4j = {
    search: async (_query: string, opts: { topics?: string[] }) => {
      if (opts.topics) seenTopics.push(opts.topics);
      return { query: _query, hits: [] };
    },
    toolsSearch: async () => ({ query: "", hits: [] }),
    getGraph: async () => ({ nodes: [], edges: [] }),
  } as unknown as Neo4jRetrievalService;
  const retrieval = new KnowledgeRetrievalService({
    llmwiki: stubLlmwiki({
      listWikiPages: async () => [
        { path: "a.md", topic: "sap" },
        { path: "b.md", topic: "sap/group_reporting" },
        { path: "c.md", topic: "sap/fiori" },
        { path: "d.md", topic: "transport" },
      ],
      search: async () => ({ results: [] }),
    }),
    neo4j,
  });
  const server = buildKbMcpServer({ retrieval });
  const client = await connectClient(server);
  try {
    await call(client, "search_knowledge", { query: "group reporting", topic: "sap" });
    assert.deepEqual(seenTopics[0], ["sap", "sap/fiori", "sap/group_reporting"]);
  } finally {
    await server.close();
    await client.close();
  }
});

test("search_knowledge without topic searches the whole corpus", async () => {
  const seenTopics: string[][] = [];
  const neo4j = {
    search: async (_query: string, opts: { topics?: string[] }) => {
      if (opts.topics) seenTopics.push(opts.topics);
      return { query: _query, hits: [] };
    },
    toolsSearch: async () => ({ query: "", hits: [] }),
    getGraph: async () => ({ nodes: [], edges: [] }),
  } as unknown as Neo4jRetrievalService;
  const retrieval = new KnowledgeRetrievalService({ llmwiki: stubLlmwiki(), neo4j });
  const server = buildKbMcpServer({ retrieval });
  const client = await connectClient(server);
  try {
    await call(client, "search_knowledge", { query: "revenue" });
    assert.equal(seenTopics.length, 0, "no topic scope handed to the store");
  } finally {
    await server.close();
    await client.close();
  }
});

test("search_knowledge applies the semantic mapping (alias) table at query time", async () => {
  const mappings = new MemorySemanticMappingStore();
  await mappings.upsert({ term: "C-Day", canonical: "CALEO Day" });
  const captured: string[] = [];
  const neo4j = {
    search: async (query: string) => {
      captured.push(query);
      return {
        query,
        hits: [
          { id: "c1", text: "CALEO Day planning", documentId: "doc1", source: "bm25", score: 0.9 },
        ],
      };
    },
    toolsSearch: async () => ({ query: "", hits: [] }),
    getGraph: async () => ({ nodes: [], edges: [] }),
  } as unknown as Neo4jRetrievalService;
  const retrieval = new KnowledgeRetrievalService({ llmwiki: stubLlmwiki(), neo4j, mappings });
  const server = buildKbMcpServer({ retrieval });
  const client = await connectClient(server);
  try {
    const result = await call(client, "search_knowledge", { query: "when is C-Day?" });
    const body = parseText(result) as { expandedQuery?: string; results: unknown[] };
    assert.equal(captured[0], "when is CALEO Day?");
    assert.equal(body.expandedQuery, "when is CALEO Day?");
    assert.equal(body.results.length, 1);
  } finally {
    await server.close();
    await client.close();
  }
});

test("search_knowledge is scoped to the topic AND still expands aliases within it", async () => {
  const mappings = new MemorySemanticMappingStore();
  await mappings.upsert({ term: "ZOB", canonical: "Zentraler Omnibusbahnhof" });
  const seen: Array<{ query: string; topics?: string[] }> = [];
  const neo4j = {
    search: async (query: string, opts: { topics?: string[] } = {}) => {
      seen.push({ query, topics: opts.topics });
      return { query, hits: [] };
    },
    toolsSearch: async () => ({ query: "", hits: [] }),
    getGraph: async () => ({ nodes: [], edges: [] }),
  } as unknown as Neo4jRetrievalService;
  const retrieval = new KnowledgeRetrievalService({
    llmwiki: stubLlmwiki({
      listWikiPages: async () => [{ path: "a.md", topic: "transport" }],
      search: async () => ({ results: [] }),
    }),
    neo4j,
    mappings,
  });
  const server = buildKbMcpServer({ retrieval });
  const client = await connectClient(server);
  try {
    await call(client, "search_knowledge", { query: "where is ZOB?", topic: "transport" });
    assert.deepEqual(seen[0], {
      query: "where is Zentraler Omnibusbahnhof?",
      topics: ["transport"],
    });
  } finally {
    await server.close();
    await client.close();
  }
});

test("get_wiki_page returns a page's markdown content", async () => {
  const retrieval = new KnowledgeRetrievalService({
    llmwiki: stubLlmwiki({
      readFile: async (_projectId, path) => ({
        path,
        content: "---\ntitle: Group Reporting\ntopic: sap/group_reporting\n---\n\n# Body",
      }),
    }),
  });
  const server = buildKbMcpServer({ retrieval });
  const client = await connectClient(server);
  try {
    const result = await call(client, "get_wiki_page", {
      path: "wiki/sap/group_reporting.md",
    });
    const body = parseText(result) as { path: string; content: string };
    assert.equal(body.path, "wiki/sap/group_reporting.md");
    assert.match(body.content, /topic: sap\/group_reporting/);
  } finally {
    await server.close();
    await client.close();
  }
});

test("get_graph returns knowledge-graph nodes and edges", async () => {
  const retrieval = new KnowledgeRetrievalService({
    llmwiki: stubLlmwiki(),
    neo4j: stubNeo4j(),
  });
  const server = buildKbMcpServer({ retrieval });
  const client = await connectClient(server);
  try {
    const result = await call(client, "get_graph");
    const body = parseText(result) as {
      nodes: Array<{ id: string; label: string }>;
      edges: Array<{ source: string; target: string }>;
    };
    assert.ok(body.nodes.some((n) => n.id === "ZOB"));
    assert.equal(body.nodes[0]!.type, "entity");
    assert.equal(body.edges.length, 1);
    assert.equal(body.edges[0]!.target, "CALEO");
  } finally {
    await server.close();
    await client.close();
  }
});

test("get_kb_topics lists the wiki frontmatter topic subtrees", async () => {
  const retrieval = new KnowledgeRetrievalService({
    llmwiki: stubLlmwiki({
      listWikiPages: async () => [
        { path: "a.md", topic: "sap" },
        { path: "b.md", topic: "sap/group_reporting" },
        { path: "c.md", topic: "internal/events" },
        { path: "d.md" },
      ],
    }),
  });
  const server = buildKbMcpServer({ retrieval });
  const client = await connectClient(server);
  try {
    const result = await call(client, "get_kb_topics");
    const body = parseText(result) as { topics: string[] };
    assert.deepEqual(body.topics, ["internal/events", "sap", "sap/group_reporting"]);
  } finally {
    await server.close();
    await client.close();
  }
});

test("get_wiki_tree returns the wiki page tree", async () => {
  const retrieval = new KnowledgeRetrievalService({
    llmwiki: stubLlmwiki({
      getFileTree: async () => ({
        files: [
          {
            name: "group_reporting",
            path: "wiki/sap/group_reporting",
            isDir: true,
            children: [
              { name: "overview.md", path: "wiki/sap/group_reporting/overview.md", isDir: false },
            ],
          },
        ],
      }),
      listWikiPages: async () => [
        { path: "wiki/sap/group_reporting/overview.md", type: "concept", topic: "sap/group_reporting" },
      ],
    }),
  });
  const server = buildKbMcpServer({ retrieval });
  const client = await connectClient(server);
  try {
    const result = await call(client, "get_wiki_tree");
    const body = parseText(result) as Array<{
      name: string;
      children?: Array<{ name: string; topic?: string }>;
    }>;
    const page = body[0]!.children![0]!;
    assert.equal(page.name, "overview.md");
    assert.equal(page.topic, "sap/group_reporting");
  } finally {
    await server.close();
    await client.close();
  }
});

test("a missing required argument produces an isError tool result", async () => {
  const server = buildKbMcpServer({ retrieval: new KnowledgeRetrievalService({ llmwiki: stubLlmwiki() }) });
  const client = await connectClient(server);
  try {
    const result = await call(client, "search_knowledge", {});
    assert.ok(result.isError, "invalid args must surface as an error result");
  } finally {
    await server.close();
    await client.close();
  }
});

test("a retrieving failure surfaces as an isError tool result", async () => {
  const retrieval = new KnowledgeRetrievalService({
    llmwiki: stubLlmwiki({
      getFileTree: async () => {
        throw new Error("tree source down");
      },
    }),
  });
  const server = buildKbMcpServer({ retrieval });
  const client = await connectClient(server);
  try {
    const result = await call(client, "get_wiki_tree");
    assert.ok(result.isError);
  } finally {
    await server.close();
    await client.close();
  }
});