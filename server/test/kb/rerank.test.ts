import { test } from "node:test";
import assert from "node:assert/strict";
import { LlamaCppReranker, type RerankerRequest } from "../../src/kb/store/rerank.js";
import type { Neo4jSearchHit } from "../../src/kb/store/retrieval.js";

const HIT = (id: string, text: string): Neo4jSearchHit => ({ id, text, source: "vector", score: 1 });

test("LlamaCppReranker POSTs query + documents to /rerank and reorders by relevance_score", async () => {
  let captured: { url: string; body: RerankerRequest } | undefined;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as RerankerRequest;
    captured = { url, body };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { index: 1, relevance_score: 0.92 },
          { index: 0, relevance_score: 0.41 },
        ],
      }),
    } as unknown as Response;
  };
  const reranker = new LlamaCppReranker({ baseUrl: "http://127.0.0.1:9632", fetchImpl });

  const hits = [HIT("c1", "first chunk"), HIT("c2", "second chunk")];
  const reranked = await reranker.rerank("bus station", hits);

  assert.deepEqual(
    reranked.map((h) => h.id),
    ["c2", "c1"],
    "reordered by descending relevance_score",
  );
  assert.deepEqual(reranked.map((h) => h.score), [0.92, 0.41], "score replaced by the reranker relevance");
  assert.equal(captured!.url, "http://127.0.0.1:9632/rerank");
  assert.equal(captured!.body.query, "bus station", "query-first: the query is the rerank anchor");
  assert.deepEqual(captured!.body.documents, ["first chunk", "second chunk"]);
  assert.equal(captured!.body.top_n, 2, "only the supplied fused top-k is reranked");
});

test("LlamaCppReranker reranks only the top-n fused hits (never the whole corpus)", async () => {
  let topN: number | undefined;
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    topN = (JSON.parse(String(init?.body)) as RerankerRequest).top_n;
    return {
      ok: true,
      status: 200,
      json: async () => ({ results: [] }),
    } as unknown as Response;
  };
  const reranker = new LlamaCppReranker({ baseUrl: "http://127.0.0.1:9632", fetchImpl });

  const hits = Array.from({ length: 50 }, (_, i) => HIT(`c${i}`, `chunk ${i}`));
  await reranker.rerank("query", hits, 20);

  assert.equal(topN, 20, "top_n caps at the configured rerank window");
});

test("LlamaCppReranker throws on a non-2xx rerank response", async () => {
  const fetchImpl = async () =>
    ({ ok: false, status: 500, text: async () => "boom" }) as unknown as Response;
  const reranker = new LlamaCppReranker({ baseUrl: "http://127.0.0.1:9632", fetchImpl });

  await assert.rejects(
    () => reranker.rerank("query", [HIT("c1", "x")]),
    /rerank/i,
    "failure propagates so the caller can fall back to RRF-only",
  );
});
