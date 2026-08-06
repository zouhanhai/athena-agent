import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmWikiClient, parseClassification } from "../../src/kb/llmwiki.js";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Headers({ "content-type": "application/json" }),
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  } as Response;
}

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeFetchMock(
  handler: (url: string, init: RequestInit) => { status: number; body: unknown },
): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) {
      headers[k.toLowerCase()] = String(v);
    }
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method, headers, body });
    const { status, body: responseBody } = handler(url, init ?? {});
    return jsonResponse(responseBody, status);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test("LlmWikiClient.getHealth calls GET /health", async () => {
  const { fetchImpl, calls } = makeFetchMock(() => ({
    status: 200,
    body: { ok: true, status: "running", version: "0.6.7" },
  }));
  const client = new LlmWikiClient({ baseUrl: "http://wiki:19828", fetchImpl });
  const health = await client.getHealth();
  assert.equal(health.status, "running");
  assert.equal(calls[0].url, "http://wiki:19828/api/v1/health");
});

test("LlmWikiClient.listProjects returns parsed projects", async () => {
  const { fetchImpl } = makeFetchMock(() => ({
    status: 200,
    body: {
      currentProject: null,
      ok: true,
      projects: [{ current: false, id: "athena-wiki", name: "athena-wiki", path: "/data/wiki" }],
    },
  }));
  const client = new LlmWikiClient({ baseUrl: "http://wiki:19828", fetchImpl });
  const { projects } = await client.listProjects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, "athena-wiki");
  assert.equal(projects[0].path, "/data/wiki");
});

test("LlmWikiClient.getFileTree GETs /projects/{id}/files with root param", async () => {
  const { fetchImpl, calls } = makeFetchMock(() => ({
    status: 200,
    body: {
      ok: true,
      files: [{ isDir: false, name: "a.md", path: "wiki/a.md", size: 10 }],
      root: "wiki",
      truncated: false,
    },
  }));
  const client = new LlmWikiClient({ baseUrl: "http://wiki:19828", fetchImpl });
  const { files } = await client.getFileTree("athena-wiki", { root: "wiki" });
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "a.md");
  assert.equal(files[0].isDir, false);
  assert.equal(calls[0].url, "http://wiki:19828/api/v1/projects/athena-wiki/files?root=wiki");
});

test("LlmWikiClient.readFile GETs /projects/{id}/files/content with path", async () => {
  const { fetchImpl, calls } = makeFetchMock(() => ({
    status: 200,
    body: { ok: true, path: "wiki/a.md", content: "# content" },
  }));
  const client = new LlmWikiClient({ baseUrl: "http://wiki:19828", fetchImpl });
  const page = await client.readFile("athena-wiki", "wiki/a.md");
  assert.equal(page.content, "# content");
  assert.equal(calls[0].url, "http://wiki:19828/api/v1/projects/athena-wiki/files/content?path=wiki%2Fa.md");
});

test("LlmWikiClient.search POSTs /projects/{id}/search", async () => {
  const { fetchImpl, calls } = makeFetchMock(() => ({
    status: 200,
    body: {
      ok: true,
      results: [{ path: "wiki/a.md", title: "A", snippet: "...", score: 0.9, titleMatch: true, vectorScore: null }],
      mode: "hybrid",
      tokenHits: 1,
      vectorHits: 1,
    },
  }));
  const client = new LlmWikiClient({ baseUrl: "http://wiki:19828", fetchImpl });
  const { results, mode } = await client.search("athena-wiki", "athena", { topK: 5 });
  assert.equal(mode, "hybrid");
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "A");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "http://wiki:19828/api/v1/projects/athena-wiki/search");
  assert.deepEqual(calls[0].body, { query: "athena", topK: 5 });
});

test("LlmWikiClient.getGraph GETs /projects/{id}/graph", async () => {
  const { fetchImpl, calls } = makeFetchMock(() => ({
    status: 200,
    body: {
      ok: true,
      nodes: [{ id: "wiki/a.md", label: "A", type: "wiki" }],
      edges: [{ source: "wiki/a.md", target: "wiki/b.md", weight: 1 }],
    },
  }));
  const client = new LlmWikiClient({ baseUrl: "http://wiki:19828", fetchImpl });
  const { nodes, edges } = await client.getGraph("athena-wiki", { limit: 50 });
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].label, "A");
  assert.equal(edges.length, 1);
  assert.equal(calls[0].url, "http://wiki:19828/api/v1/projects/athena-wiki/graph?limit=50");
});

test("LlmWikiClient.rescan POSTs /projects/{id}/sources/rescan", async () => {
  const { fetchImpl, calls } = makeFetchMock(() => ({
    status: 200,
    body: { ok: true, tasks: [{ kind: "created" }] },
  }));
  const client = new LlmWikiClient({ baseUrl: "http://wiki:19828", fetchImpl });
  const result = await client.rescan("athena-wiki");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "http://wiki:19828/api/v1/projects/athena-wiki/sources/rescan");
  assert.ok(Array.isArray(result.tasks));
});

test("LlmWikiClient sends bearer token when configured", async () => {
  const { fetchImpl, calls } = makeFetchMock(() => ({
    status: 200,
    body: { ok: true, projects: [], currentProject: null },
  }));
  const client = new LlmWikiClient({ baseUrl: "http://wiki:19828", token: "tok", fetchImpl });
  await client.listProjects();
  assert.equal(calls[0].headers.authorization, "Bearer tok");
});

test("LlmWikiClient throws with status + message on error json", async () => {
  const { fetchImpl } = makeFetchMock(() => ({
    status: 404,
    body: { ok: false, error: "project not found" },
  }));
  const client = new LlmWikiClient({ baseUrl: "http://wiki:19828", fetchImpl });
  await assert.rejects(
    () => client.getFileTree("missing"),
    /404.*project not found/,
  );
});

test("LlmWikiClient.classify asks the agent and parses its JSON reply", async () => {
  const { fetchImpl, calls } = makeFetchMock(() => ({
    status: 200,
    body: {
      ok: true,
      message: { role: "assistant", content: '{"category":"concept","pagePath":"wiki/concepts/chain-of-thought.md"}' },
    },
  }));
  const client = new LlmWikiClient({ baseUrl: "http://wiki:19828", fetchImpl });
  const result = await client.classify("athena-wiki", {
    title: "Chain of Thought",
    content: "# Chain of Thought\n\nSome text about reasoning.",
  });
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "http://wiki:19828/api/v1/projects/athena-wiki/chat");
  assert.equal(calls[0].body.message.includes("wiki librarian"), true);
  assert.equal(calls[0].body.mode, "fast");
  assert.deepEqual(result, { category: "concept", pagePath: "wiki/concepts/chain-of-thought.md" });
});

test("LlmWikiClient.classify rejects an invalid/unparseable agent reply", async () => {
  const { fetchImpl } = makeFetchMock(() => ({
    status: 200,
    body: { ok: true, message: { role: "assistant", content: "I would put it somewhere." } },
  }));
  const client = new LlmWikiClient({ baseUrl: "http://wiki:19828", fetchImpl });
  await assert.rejects(
    () => client.classify("athena-wiki", { title: "x", content: "y" }),
    /no valid classification/,
  );
});

test("parseClassification validates category and pagePath", () => {
  assert.deepEqual(
    parseClassification('{"category":"entity","pagePath":"wiki/entities/acme.md"}'),
    { category: "entity", pagePath: "wiki/entities/acme.md" },
  );
  assert.equal(parseClassification('{"category":"bogus","pagePath":"wiki/x.md"}'), null);
  assert.equal(parseClassification('{"category":"concept","pagePath":"/etc/passwd"}'), null);
  assert.equal(parseClassification("no json here"), null);
});

