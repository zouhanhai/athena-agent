import { test } from "node:test";
import assert from "node:assert/strict";
import { LightRagClient } from "../../src/kb/lightrag.js";

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

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

test("LightRagClient.getHealth calls GET /health", async () => {
  const { fetchImpl, calls } = makeFetchMock((url) => ({
    status: 200,
    body: { status: "healthy", core_version: "1.5.5" },
  }));
  const client = new LightRagClient({ baseUrl: "http://kb:9621", fetchImpl });
  const health = await client.getHealth();
  assert.equal(health.status, "healthy");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://kb:9621/health");
  assert.equal(calls[0].method, "GET");
});

test("LightRagClient.ingestText POSTs JSON to /documents/text with file_source + paragraph_semantic chunking", async () => {
  const { fetchImpl, calls } = makeFetchMock((url) => ({
    status: 200,
    body: { status: "success", message: "ok", track_id: "insert_123" },
  }));
  const client = new LightRagClient({ baseUrl: "http://kb:9621", fetchImpl });
  const result = await client.ingestText("# Doc", { fileSource: "athena-overview.md" });
  assert.equal(result.track_id, "insert_123");
  assert.equal(calls[0].url, "http://kb:9621/documents/text");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, {
    text: "# Doc",
    file_source: "athena-overview.md",
    chunking: { strategy: "paragraph_semantic" },
  });
  assert.equal(calls[0].headers["content-type"], "application/json");
});

test("LightRagClient.ingestText omits file_source when not provided and defaults to paragraph_semantic chunking", async () => {
  const { fetchImpl, calls } = makeFetchMock(() => ({
    status: 200,
    body: { status: "success", message: "ok", track_id: "t" },
  }));
  const client = new LightRagClient({ baseUrl: "http://kb:9621", fetchImpl });
  await client.ingestText("text only");
  assert.deepEqual(calls[0].body, {
    text: "text only",
    chunking: { strategy: "paragraph_semantic" },
  });
});

test("LightRagClient.ingestText accepts a chunking override", async () => {
  const { fetchImpl, calls } = makeFetchMock(() => ({
    status: 200,
    body: { status: "success", message: "ok", track_id: "t" },
  }));
  const client = new LightRagClient({ baseUrl: "http://kb:9621", fetchImpl });
  await client.ingestText("text", {
    chunking: { strategy: "fixed_token", chunk_token_size: 1200 },
  });
  assert.deepEqual(calls[0].body, {
    text: "text",
    chunking: { strategy: "fixed_token", chunk_token_size: 1200 },
  });
});

test("LightRagClient.query POSTs /query and returns response with references", async () => {
  const { fetchImpl, calls } = makeFetchMock(() => ({
    status: 200,
    body: {
      response: "Answer text",
      references: [{ reference_id: "1", file_path: "doc.md", content: ["chunk"] }],
      response_time: 1.2,
    },
  }));
  const client = new LightRagClient({ baseUrl: "http://kb:9621", fetchImpl });
  const result = await client.query("What is athena?", { mode: "hybrid", topK: 5 });
  assert.equal(result.response, "Answer text");
  assert.equal(result.references?.[0].file_path, "doc.md");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "http://kb:9621/query");
  assert.deepEqual(calls[0].body, { query: "What is athena?", mode: "hybrid", top_k: 5 });
});

test("LightRagClient.getGraph GETs /graphs with label query params", async () => {
  const { fetchImpl, calls } = makeFetchMock(() => ({
    status: 200,
    body: { nodes: [{ id: "n1", label: "Pi SDK" }], edges: [{ source: "n1", target: "n2" }], is_truncated: false },
  }));
  const client = new LightRagClient({ baseUrl: "http://kb:9621", fetchImpl });
  const graph = await client.getGraph("default", { maxDepth: 2, maxNodes: 500 });
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].label, "Pi SDK");
  assert.equal(graph.edges.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url, "http://kb:9621/graphs?label=default&max_depth=2&max_nodes=500");
});

test("LightRagClient sends bearer token when configured", async () => {
  const { fetchImpl, calls } = makeFetchMock(() => ({
    status: 200,
    body: { status: "ok" },
  }));
  const client = new LightRagClient({ baseUrl: "http://kb:9621", token: "sekret", fetchImpl });
  await client.getHealth();
  assert.equal(calls[0].headers.authorization, undefined, "health is exempt from auth");
  await client.ingestText("hello");
  assert.equal(calls[1].headers.authorization, "Bearer sekret");
});

test("LightRagClient throws with status + detail on non-2xx", async () => {
  const { fetchImpl } = makeFetchMock(() => ({
    status: 500,
    body: { detail: "boom" },
  }));
  const client = new LightRagClient({ baseUrl: "http://kb:9621", fetchImpl });
  await assert.rejects(
    () => client.query("short"),
    /500.*boom/,
  );
});

test("LightRagClient strips trailing slash from baseUrl", async () => {
  const { fetchImpl, calls } = makeFetchMock(() => ({
    status: 200,
    body: { status: "healthy" },
  }));
  const client = new LightRagClient({ baseUrl: "http://kb:9621/", fetchImpl });
  await client.getHealth();
  assert.equal(calls[0].url, "http://kb:9621/health");
});

test("LightRagClient.getTrackStatus GETs /documents/track_status/{track_id}", async () => {
  const { fetchImpl, calls } = makeFetchMock(() => ({
    status: 200,
    body: {
      track_id: "insert_123",
      total_count: 1,
      status_summary: { processed: 1 },
      documents: [
        {
          id: "doc-1",
          file_path: "athena-overview.md",
          status: "processed",
          chunks_count: 182,
          error_msg: null,
        },
      ],
    },
  }));
  const client = new LightRagClient({ baseUrl: "http://kb:9621", fetchImpl });
  const status = await client.getTrackStatus("insert_123");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url, "http://kb:9621/documents/track_status/insert_123");
  assert.equal(status.documents.length, 1);
  assert.equal(status.documents[0].status, "processed");
  assert.equal(status.documents[0].chunks_count, 182);
  assert.equal(status.documents[0].file_path, "athena-overview.md");
});

test("LightRagClient.getTrackStatus URL-encodes the track id", async () => {
  const { fetchImpl, calls } = makeFetchMock(() => ({
    status: 200,
    body: { track_id: "a b", documents: [], total_count: 0 },
  }));
  const client = new LightRagClient({ baseUrl: "http://kb:9621", fetchImpl });
  await client.getTrackStatus("a b");
  assert.equal(calls[0].url, "http://kb:9621/documents/track_status/a%20b");
});

test("LightRagClient.getPipelineStatus GETs /documents/pipeline_status", async () => {
  const { fetchImpl, calls } = makeFetchMock(() => ({
    status: 200,
    body: {
      busy: true,
      latest_message: "Chunk 12 of 182 extracted 3 Ent + 2 Rel",
      history_messages: ["Indexing files", "Chunk 8 of 182 ..."],
    },
  }));
  const client = new LightRagClient({ baseUrl: "http://kb:9621", fetchImpl });
  const status = await client.getPipelineStatus();
  assert.equal(calls[0].url, "http://kb:9621/documents/pipeline_status");
  assert.equal(calls[0].method, "GET");
  assert.equal(status.latest_message, "Chunk 12 of 182 extracted 3 Ent + 2 Rel");
  assert.deepEqual(status.history_messages, ["Indexing files", "Chunk 8 of 182 ..."]);
});

test("LightRagClient.listDocuments flattens all statuses into doc records", async () => {
  const { fetchImpl } = makeFetchMock(() => ({
    status: 200,
    body: {
      statuses: {
        processed: [
          { id: "doc-1", file_path: "foo.md", status: "processed" },
          { id: "doc-2", file_path: "bar.md", status: "processed" },
        ],
        pending: [{ id: "doc-3", file_path: "baz.md", status: "pending" }],
        failed: [{ id: "doc-4", status: "failed" }],
      },
    },
  }));
  const client = new LightRagClient({ baseUrl: "http://kb:9621", fetchImpl });
  const docs = await client.listDocuments();
  assert.deepEqual(docs, [
    { id: "doc-1", file_path: "foo.md", status: "processed" },
    { id: "doc-2", file_path: "bar.md", status: "processed" },
    { id: "doc-3", file_path: "baz.md", status: "pending" },
    { id: "doc-4", status: "failed" },
  ]);
});

test("LightRagClient.deleteDocument DELETEs delete_document with doc_ids + llm cache purge", async () => {
  const { fetchImpl, calls } = makeFetchMock(() => ({
    status: 200,
    body: { status: "deletion_started" },
  }));
  const client = new LightRagClient({ baseUrl: "http://kb:9621", fetchImpl });
  const result = await client.deleteDocument("doc-1");
  assert.equal(result.status, "deletion_started");
  assert.equal(calls[0].method, "DELETE");
  assert.equal(calls[0].url, "http://kb:9621/documents/delete_document");
  assert.deepEqual(calls[0].body, { doc_ids: ["doc-1"], delete_file: false, delete_llm_cache: true });
});
