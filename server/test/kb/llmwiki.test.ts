import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmWikiClient, isValidTopic, normalizeTopic, parseClassification } from "../../src/kb/llmwiki.js";

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

test("parseClassification accepts the 13-kind CALEO taxonomy types", () => {
  for (const type of ["report", "minute", "spec", "manual", "proposal", "contract", "policy", "presentation", "event", "source", "person", "entity", "concept"]) {
    const parsed = parseClassification(`{"category":"${type}","pagePath":"wiki/x.md"}`);
    assert.ok(parsed, `type ${type} is accepted`);
    assert.equal(parsed!.category, type);
  }
  // the removed research-oriented types are rejected
  for (const type of ["comparison", "query", "synthesis"]) {
    assert.equal(parseClassification(`{"category":"${type}","pagePath":"wiki/x.md"}`), null);
  }
});

test("LlmWikiClient.classify embeds the CALEO taxonomy in the agent prompt", async () => {
  const { fetchImpl, calls } = makeFetchMock(() => ({
    status: 200,
    body: {
      ok: true,
      message: { role: "assistant", content: '{"category":"source","topic":"sap/consolidation/group-reporting","pagePath":"wiki/sources/gr.md"}' },
    },
  }));
  const client = new LlmWikiClient({ baseUrl: "http://wiki:19828", fetchImpl });
  const result = await client.classify("athena-wiki", {
    title: "SAP Group Reporting",
    content: "# SAP Group Reporting\n\nExternal SAP documentation.",
  });
  const message = calls[0].body.message as string;
  assert.ok(message.includes("wiki librarian"), "prompt keeps the librarian framing");
  assert.ok(message.includes("internal/events"), "prompt embeds the topic tree (internal/events)");
  assert.ok(message.includes("sap/consolidation/group-reporting"), "prompt embeds the topic tree (sap/consolidation/group-reporting)");
  assert.ok(message.includes("source: external reference material"), "prompt embeds type criteria");
  assert.match(
    message,
    /category must be one of: report, minute, spec, manual, proposal, contract, policy, presentation, event, source, person, entity, concept/,
    "prompt lists exactly the 13 taxonomy types (no comparison/query/synthesis)",
  );
  assert.deepEqual(result, { category: "source", topic: "sap/consolidation/group-reporting", pagePath: "wiki/sources/gr.md" });
});

test("parseClassification parses an optional topic key", () => {
  assert.deepEqual(
    parseClassification('{"category":"concept","topic":"sommerseminar","pagePath":"wiki/concepts/sommerseminar.md"}'),
    { category: "concept", pagePath: "wiki/concepts/sommerseminar.md", topic: "sommerseminar" },
  );
  // path traversal is neutralized into a safe slug (never a valid key)
  const traversed = parseClassification('{"category":"concept","topic":"../evil","pagePath":"wiki/x.md"}');
  assert.ok(traversed);
  assert.equal(traversed!.topic, "evil");
});

test("isValidTopic accepts hierarchical slash paths and blocks traversal", () => {
  assert.equal(isValidTopic("sommerseminar"), true);
  assert.equal(isValidTopic("sap/fiori"), true);
  assert.equal(isValidTopic("sap/s4hana/abap"), true);
  assert.equal(isValidTopic("Sap/Fiori"), false);
  assert.equal(isValidTopic("sap//fiori"), false);
  assert.equal(isValidTopic("/sap"), false);
  assert.equal(isValidTopic("sap/"), false);
  assert.equal(isValidTopic("../evil"), false);
  assert.equal(isValidTopic("sap/../evil"), false);
});

test("normalizeTopic sanitizes a raw topic into a safe slash-path key", () => {
  assert.equal(normalizeTopic("  SAP / Fiori  "), "sap/fiori");
  assert.equal(normalizeTopic("Sommerseminar 2026"), "sommerseminar-2026");
  assert.equal(normalizeTopic("../evil"), "evil");
  assert.equal(normalizeTopic("sap/-fiori/"), "sap/fiori");
  assert.equal(normalizeTopic("!!!"), undefined);
});

test("parseClassification keeps a hierarchical topic path", () => {
  assert.deepEqual(
    parseClassification('{"category":"concept","topic":"sap/fiori","pagePath":"wiki/concepts/sap-fiori.md"}'),
    { category: "concept", pagePath: "wiki/concepts/sap-fiori.md", topic: "sap/fiori" },
  );
});

test("LlmWikiClient.deleteFile removes the page file on disk and rescans", async () => {
  const base = await mkdtemp(join(tmpdir(), "llmwiki-del-"));
  const projectPath = join(base, "proj");
  const target = join(projectPath, "wiki", "concepts", "foo.md");
  await mkdir(join(projectPath, "wiki", "concepts"), { recursive: true });
  await writeFile(target, "# Foo");
  try {
    const { fetchImpl, calls } = makeFetchMock((url) => {
      if (url.includes("/projects") && !url.includes("rescan")) {
        return {
          status: 200,
          body: {
            ok: true,
            currentProject: null,
            projects: [{ id: "athena-wiki", name: "athena-wiki", path: projectPath, current: false }],
          },
        };
      }
      return { status: 200, body: { ok: true, tasks: [] } };
    });
    const client = new LlmWikiClient({ baseUrl: "http://wiki:19828", fetchImpl });
    await client.deleteFile("athena-wiki", "wiki/concepts/foo.md");
    await assert.rejects(() => access(target), /ENOENT/);
    assert.ok(
      calls.some((c) => c.url.endsWith("/projects/athena-wiki/sources/rescan")),
      "rescan is triggered after the file is removed",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("LlmWikiClient.classify tells the agent to reuse existing topics", async () => {
  const { fetchImpl, calls } = makeFetchMock(() => ({
    status: 200,
    body: {
      ok: true,
      message: { role: "assistant", content: '{"category":"concept","topic":"sommerseminar","pagePath":"wiki/sommerseminar/sommerseminar-4.md"}' },
    },
  }));
  const client = new LlmWikiClient({ baseUrl: "http://wiki:19828", fetchImpl });
  const result = await client.classify(
    "athena-wiki",
    { title: "Sommerseminar 4", content: "another seminar" },
    ["sommerseminar", "sap/fiori"],
  );
  assert.ok(calls[0].body.message.includes("Existing topics already in this wiki"));
  assert.ok(calls[0].body.message.includes("sommerseminar, sap/fiori"));
  assert.ok(calls[0].body.message.includes("REUSE that exact topic path"));
  assert.deepEqual(result, { category: "concept", topic: "sommerseminar", pagePath: "wiki/sommerseminar/sommerseminar-4.md" });
});

