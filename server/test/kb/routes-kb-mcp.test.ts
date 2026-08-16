/**
 * G4.S7.T3 — KB-as-MCP over Streamable HTTP (Fastify route) tests.
 *
 * Exercises the real HTTP seam external agents use: initialize a session,
 * list tools, call tools, delete the session — with per-request Bearer-token
 * auth and topic-scoped search + alias expansion in the responses.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../src/app.js";
import type { FastifyInstance } from "fastify";
import {
  MagicLinkAuthService,
  MemoryAuthTokenStore,
  type MagicLinkMailer,
} from "../../src/employees/auth.js";
import { MemoryEmployeeRegistry } from "../../src/employees/employees.js";
import { createSecretCipher } from "../../src/employees/crypto.js";
import { KnowledgeRetrievalService } from "../../src/kb/retrieval.js";
import { MemorySemanticMappingStore } from "../../src/kb/semantic-mappings.js";
import type { IngestTaskQueue } from "../../src/kb/tasks.js";
import type { LlmWikiClient } from "../../src/kb/llmwiki.js";
import type { Neo4jRetrievalService } from "../../src/kb/store/retrieval.js";

const MCP = "/api/kb/mcp";
const ACCEPT = "application/json, text/event-stream";
const TEST_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

interface SentMail {
  to: string;
  magicLinkUrl: string;
}

function tokenFromUrl(url: string): string {
  const match = /[?&]token=([^&]+)/.exec(url);
  assert.ok(match, `magic link should carry a token: ${url}`);
  return decodeURIComponent(match[1]);
}

function stubLlmwiki(overrides: Partial<LlmWikiClient> = {}): LlmWikiClient {
  return {
    listProjects: async () => ({
      projects: [{ id: "proj1", name: "P1", path: "/p", current: false }],
      currentProject: null,
    }),
    getFileTree: async () => ({ files: [] }),
    listWikiPages: async () => [],
    readFile: async (_projectId, path) => ({ path, content: "# Docs" }),
    search: async () => ({ results: [] }),
    ...overrides,
  } as unknown as LlmWikiClient;
}

function stubRetrieval(overrides: Partial<KnowledgeRetrievalService> = {}): KnowledgeRetrievalService {
  return {
    getGraph: async () => ({
      nodes: [{ id: "n1", label: "Alpha", type: "concept" }],
      edges: [{ source: "n1", target: "n2" }],
    }),
    getWikiTree: async () => [{ name: "runbook.md", path: "wiki/ops/runbook.md", isDir: false }],
    readWikiPage: async (path: string) => ({ path, content: "---\ntopic: ops\n---\n\n# Runbook\nbody" }),
    getGraphTopics: async () => ["internal/events", "ops", "sap/group_reporting"],
    search: async (query: string) => ({
      query,
      results: [
        {
          source: "neo4j" as const,
          title: "Runbook",
          snippet: "Incident handling guide",
          wikiPath: "wiki/ops/runbook.md",
          sectionPath: "Ops / Runbook",
        },
      ],
    }),
    ...overrides,
  } as unknown as KnowledgeRetrievalService;
}

let app: FastifyInstance;
let sent: SentMail[];
let registry: MemoryEmployeeRegistry;
let auth: MagicLinkAuthService;

beforeEach(async () => {
  sent = [];
  registry = new MemoryEmployeeRegistry(
    [
      { email: "admin@caleo.com", display_name: "Admin", role: "admin" },
      { email: "member@caleo.com", display_name: "Member", role: "member" },
    ],
    { cipher: createSecretCipher(TEST_KEY) },
  );
  const mailer: MagicLinkMailer = {
    async sendLoginLink(input) {
      sent.push({ to: input.to, magicLinkUrl: input.magicLinkUrl });
    },
  };
  auth = new MagicLinkAuthService({
    registry,
    mailer,
    tokens: new MemoryAuthTokenStore(),
    appBaseUrl: "http://localhost:5173",
  });
});

after(async () => {
  if (app) {
    await app.close();
  }
});

function build(extra: { retrieval?: KnowledgeRetrievalService } = {}) {
  app = buildApp({
    employees: registry,
    auth,
    retrieval: extra.retrieval ?? stubRetrieval(),
    // The MCP tests never touch the ingest pipeline; a task-queue stub keeps
    // buildApp from constructing the env-dependent default queue (embedder key).
    taskQueue: {
      getTask: () => undefined,
      submitFile: () => ({ taskId: "stub" }),
      submitUrl: () => ({ taskId: "stub" }),
      submitWikiSave: () => ({ taskId: "stub" }),
      retry: async () => {
        throw new Error("not used");
      },
    } as unknown as IngestTaskQueue,
  });
}

async function login(email: string): Promise<string> {
  await app.inject({ method: "POST", url: "/api/auth/login", payload: { email } });
  const token = tokenFromUrl(sent[sent.length - 1]!.magicLinkUrl);
  const res = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { token } });
  assert.equal(res.statusCode, 200);
  return (res.json() as { session_token: string }).session_token;
}

async function initialize(token?: string): Promise<{ statusCode: number; headers: Record<string, unknown>; body: unknown }> {
  const res = await app.inject({
    method: "POST",
    url: MCP,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      accept: ACCEPT,
      "content-type": "application/json",
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "kb-mcp-route-test", version: "1.0.0" },
      },
    },
  });
  return { statusCode: res.statusCode, headers: res.headers as Record<string, unknown>, body: res.json() };
}

async function mcpPost(
  token: string | undefined,
  sessionId: string | undefined,
  method: string,
  params?: unknown,
): Promise<{ statusCode: number; headers: Record<string, unknown>; body: unknown }> {
  const res = await app.inject({
    method: "POST",
    url: MCP,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(sessionId ? { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-03-26" } : {}),
      accept: ACCEPT,
      "content-type": "application/json",
    },
    payload: {
      jsonrpc: "2.0",
      id: 2,
      method,
      ...(params !== undefined ? { params } : {}),
    },
  });
  return { statusCode: res.statusCode, headers: res.headers as Record<string, unknown>, body: res.json() };
}

async function openSession(token: string): Promise<string> {
  const init = await initialize(token);
  assert.equal(init.statusCode, 200);
  const sessionId = init.headers["mcp-session-id"];
  assert.ok(typeof sessionId === "string" && sessionId.length > 0, "initialize returns a session id");
  return sessionId;
}

async function callTool(
  token: string,
  sessionId: string,
  name: string,
  args?: Record<string, unknown>,
): Promise<{ statusCode: number; body: { isError?: boolean; content?: Array<{ type: string; text: string }> } }> {
  const res = await mcpPost(token, sessionId, "tools/call", { name, arguments: args ?? {} });
  // JSON-RPC wraps the CallToolResult under `result`.
  const result = (res.body as { result?: { isError?: boolean; content?: Array<{ type: string; text: string }> } })
    .result;
  return { statusCode: res.statusCode, body: result ?? (res.body as { isError?: boolean; content?: never }) };
}

test("MCP requests without a valid employee token are rejected (401)", async () => {
  build();
  try {
    const noToken = await initialize();
    assert.equal(noToken.statusCode, 401);
    const badToken = await initialize("garbage-token");
    assert.equal(badToken.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("a client can initialize a session and list the 5 KB tools", async () => {
  build();
  try {
    const token = await login("member@caleo.com");
    const sessionId = await openSession(token);

    await mcpPost(token, sessionId, "notifications/initialized");

    const list = await mcpPost(token, sessionId, "tools/list");
    assert.equal(list.statusCode, 200);
    const tools = (list.body as { result: { tools: Array<{ name: string }> } }).result.tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "get_graph",
      "get_kb_topics",
      "get_wiki_page",
      "get_wiki_tree",
      "search_knowledge",
    ]);
  } finally {
    await app.close();
  }
});

test("search_knowledge returns hits with wikiPath/sectionPath over HTTP", async () => {
  build();
  try {
    const token = await login("admin@caleo.com");
    const sessionId = await openSession(token);

    const res = await callTool(token, sessionId, "search_knowledge", { query: "incidents" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.isError, undefined);
    const payload = JSON.parse(res.body.content![0]!.text) as {
      query: string;
      results: Array<{ wikiPath: string; sectionPath: string }>;
    };
    assert.equal(payload.query, "incidents");
    assert.equal(payload.results[0]!.wikiPath, "wiki/ops/runbook.md");
    assert.equal(payload.results[0]!.sectionPath, "Ops / Runbook");
  } finally {
    await app.close();
  }
});

test("search_knowledge applies topic scoping + alias expansion through the transport", async () => {
  const mappings = new MemorySemanticMappingStore();
  await mappings.upsert({ term: "C-Day", canonical: "CALEO Day" });
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
      listWikiPages: async () => [
        { path: "a.md", topic: "sap" },
        { path: "b.md", topic: "sap/group_reporting" },
      ],
      search: async () => ({ results: [] }),
    }),
    neo4j,
    mappings,
  });
  build({ retrieval });
  try {
    const token = await login("member@caleo.com");
    const sessionId = await openSession(token);

    const res = await callTool(token, sessionId, "search_knowledge", {
      query: "when is C-Day?",
      topic: "sap",
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.isError, undefined);
    const payload = JSON.parse(res.body.content![0]!.text) as { expandedQuery: string };
    assert.equal(payload.expandedQuery, "when is CALEO Day?");
    assert.deepEqual(seen[0], { query: "when is CALEO Day?", topics: ["sap", "sap/group_reporting"] });
  } finally {
    await app.close();
  }
});

test("get_wiki_page / get_graph / get_kb_topics / get_wiki_tree return their payloads", async () => {
  build();
  try {
    const token = await login("admin@caleo.com");
    const sessionId = await openSession(token);

    const page = await callTool(token, sessionId, "get_wiki_page", { path: "wiki/ops/runbook.md" });
    const pageBody = JSON.parse(page.body.content![0]!.text) as { path: string; content: string };
    assert.equal(pageBody.path, "wiki/ops/runbook.md");
    assert.match(pageBody.content, /topic: ops/);

    const graph = await callTool(token, sessionId, "get_graph");
    const graphBody = JSON.parse(graph.body.content![0]!.text) as {
      nodes: Array<{ label: string }>;
      edges: unknown[];
    };
    assert.equal(graphBody.nodes[0]!.label, "Alpha");
    assert.equal(graphBody.edges.length, 1);

    const topics = await callTool(token, sessionId, "get_kb_topics");
    const topicsBody = JSON.parse(topics.body.content![0]!.text) as { topics: string[] };
    assert.deepEqual(topicsBody.topics, ["internal/events", "ops", "sap/group_reporting"]);

    const tree = await callTool(token, sessionId, "get_wiki_tree");
    const treeBody = JSON.parse(tree.body.content![0]!.text) as Array<{ name: string }>;
    assert.equal(treeBody[0]!.name, "runbook.md");
  } finally {
    await app.close();
  }
});

test("requests for an unknown session id are rejected with 404", async () => {
  build();
  try {
    const token = await login("member@caleo.com");
    const res = await mcpPost(token, "no-such-session", "tools/list");
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("DELETE closes and removes the session", async () => {
  build();
  try {
    const token = await login("admin@caleo.com");
    const sessionId = await openSession(token);

    const del = await app.inject({
      method: "DELETE",
      url: MCP,
      headers: {
        authorization: `Bearer ${token}`,
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-03-26",
        accept: ACCEPT,
      },
    });
    assert.equal(del.statusCode, 200);

    const after = await app.inject({
      method: "POST",
      url: MCP,
      headers: {
        authorization: `Bearer ${token}`,
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-03-26",
        accept: ACCEPT,
        "content-type": "application/json",
      },
      payload: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    });
    assert.equal(after.statusCode, 404, "session is gone after DELETE");
  } finally {
    await app.close();
  }
});

test("GET requires auth and a valid session", async () => {
  build();
  try {
    const anon = await app.inject({ method: "GET", url: MCP, headers: { accept: "text/event-stream" } });
    assert.equal(anon.statusCode, 401);
  } finally {
    await app.close();
  }
});