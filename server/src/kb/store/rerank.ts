/**
 * Cross-encoder reranking for the fused retrieval pipeline (G4.S2.T14).
 *
 * After RRF fuses vector + BM25 + graph chunk hits, an optional local cross-encoder
 * reranks the fused top-k against the query. The default model is BGE-Reranker-v2-M3
 * served by llama.cpp's `/rerank` endpoint (query-first pair ordering, `--pooling rank`).
 *
 * The reranker is a pure seam: `Reranker` is injectable so tests use a fetch double and
 * production uses the real llama-server. A failing reranker must never break a search —
 * callers fall back to the RRF-only ranking.
 */
import type { Neo4jSearchHit } from "./retrieval.js";

/** A cross-encoder reranker seam: reorder fused hits against the query. */
export interface Reranker {
  /** Rerank `hits` against `query`, returning a new ordering (descending relevance).
   *  Only ever called on a small fused top-k, never the whole corpus. */
  rerank(query: string, hits: Neo4jSearchHit[], topN?: number): Promise<Neo4jSearchHit[]>;
}

/** Request body of llama.cpp's POST /rerank (llama-server --rerank --pooling rank). */
export interface RerankerRequest {
  query: string;
  documents: string[];
  top_n?: number;
  return_documents?: boolean;
}

export interface LlamaCppRerankerOptions {
  /** llama-server base URL. Default: http://127.0.0.1:9632 */
  baseUrl?: string;
  /** Injectable fetch implementation for unit tests. */
  fetchImpl?: typeof fetch;
}

/** llama.cpp /rerank client. Query-first pair ordering; scores replace hit.score. */
export class LlamaCppReranker implements Reranker {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LlamaCppRerankerOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:9632").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async rerank(query: string, hits: Neo4jSearchHit[], topN?: number): Promise<Neo4jSearchHit[]> {
    const documents = hits.map((h) => h.text);
    const body: RerankerRequest = { query, documents, top_n: topN ?? documents.length };
    const response = await this.fetchImpl(`${this.baseUrl}/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`rerank API error ${response.status}: ${detail}`);
    }
    const parsed = (await response.json()) as { results?: Array<{ index: number; relevance_score: number }> };
    const scored = (parsed.results ?? [])
      .map((r) => ({ hit: hits[r.index], score: r.relevance_score }))
      .filter((x): x is { hit: Neo4jSearchHit; score: number } => Boolean(x.hit));
    scored.sort((a, b) => b.score - a.score);
    return scored.map(({ hit, score }) => ({ ...hit, score }));
  }
}
