import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenRouterEmbedder } from "../../src/kb/embedding.js";
import { neo4jConfigFromEnv } from "../../src/kb/store/driver.js";

test("OpenRouterEmbedder posts texts to /embeddings and returns vectors in order", async () => {
  let capturedUrl = "";
  let capturedBody: { model?: string; input?: string[] } = {};
  let capturedAuth = "";
  const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    capturedUrl = url;
    capturedAuth = init.headers.Authorization ?? "";
    capturedBody = JSON.parse(init.body) as { model?: string; input?: string[] };
    return {
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({
        data: capturedBody.input!.map((_, i) => ({ embedding: [i, i + 1, i + 2] })),
      }),
    } as Response;
  };

  const embedder = new OpenRouterEmbedder({ apiKey: "sk-test", fetchImpl });
  const vectors = await embedder.embed(["alpha", "beta"]);

  assert.equal(capturedUrl, "https://openrouter.ai/api/v1/embeddings");
  assert.equal(capturedAuth, "Bearer sk-test");
  assert.equal(capturedBody.model, "qwen/qwen3-embedding-8b");
  assert.deepEqual(capturedBody.input, ["alpha", "beta"]);
  assert.deepEqual(vectors, [
    [0, 1, 2],
    [1, 2, 3],
  ]);
});

test("OpenRouterEmbedder throws without an API key", () => {
  const saved = process.env.EMBEDDING_OPENROUTER_KEY;
  delete process.env.EMBEDDING_OPENROUTER_KEY;
  try {
    assert.throws(() => new OpenRouterEmbedder(), /EMBEDDING_OPENROUTER_KEY/);
  } finally {
    if (saved !== undefined) process.env.EMBEDDING_OPENROUTER_KEY = saved;
  }
});

test("OpenRouterEmbedder fires onBatch(done, total) after each internal batch (G4.S3.T8)", async () => {
  const fetchImpl = async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { input: string[] };
    return {
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({ data: body.input!.map((_, i) => ({ embedding: [i] })) }),
    } as Response;
  };
  const embedder = new OpenRouterEmbedder({ apiKey: "sk-test", fetchImpl, batchSize: 2 });
  const calls: Array<{ done: number; total: number }> = [];
  const vectors = await embedder.embed(["a", "b", "c", "d", "e"], (done, total) => calls.push({ done, total }));

  assert.deepEqual(
    calls,
    [
      { done: 2, total: 5 },
      { done: 4, total: 5 },
      { done: 5, total: 5 },
    ],
    "one callback per internal batch with cumulative done against the full total",
  );
  assert.equal(vectors.length, 5, "all vectors still returned in order");
});

test("OpenRouterEmbedder surfaces a non-ok response", async () => {
  const fetchImpl = async () =>
    ({ ok: false, status: 401, text: async () => "unauthorized" }) as Response;
  const embedder = new OpenRouterEmbedder({ apiKey: "sk-bad", fetchImpl });
  await assert.rejects(() => embedder.embed(["x"]), /embedding failed \(401\)/);
});

test("neo4jConfigFromEnv returns undefined without NEO4J_PASSWORD", () => {
  assert.equal(neo4jConfigFromEnv({} as NodeJS.ProcessEnv), undefined);
});

test("neo4jConfigFromEnv resolves defaults + overrides from env", () => {
  const config = neo4jConfigFromEnv({
    NEO4J_URI: "bolt://localhost:7687",
    NEO4J_USER: "neo4j",
    NEO4J_PASSWORD: "secret",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(config, { uri: "bolt://localhost:7687", user: "neo4j", password: "secret" });
});
