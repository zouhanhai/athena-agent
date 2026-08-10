/**
 * Text embedding for the RAG ingest path (G4.S2.T4).
 *
 * Pure embed step — no LLM extraction. Chunks are embedded via OpenRouter's
 * OpenAI-compatible `/embeddings` endpoint with the qwen3-embedding model
 * (`EMBEDDING_OPENROUTER_KEY`, independent of the Athena refinement key).
 *
 * EMBEDDING_DIMENSIONS (1024) in store/schema.ts must match the chosen model's
 * output dimensionality (qwen3-embedding-8b @ 1024).
 */

export interface TextEmbedder {
  /** Embed a batch of texts into float vectors (one per input text). */
  embed(texts: string[]): Promise<number[][]>;
}

export const DEFAULT_EMBEDDING_MODEL = "qwen/qwen3-embedding-8b";
export const DEFAULT_EMBEDDING_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterEmbedderOptions {
  /** OpenRouter API key. Default: process.env.EMBEDDING_OPENROUTER_KEY. */
  apiKey?: string;
  /** OpenRouter model id. Default: DEFAULT_EMBEDDING_MODEL. */
  model?: string;
  /** OpenRouter base URL. Default: DEFAULT_EMBEDDING_BASE_URL. */
  baseUrl?: string;
  /** Max texts per request. Default: 64. */
  batchSize?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

/** Embed via OpenRouter POST /api/v1/embeddings (OpenAI-compatible). */
export class OpenRouterEmbedder implements TextEmbedder {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly batchSize: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenRouterEmbedderOptions = {}) {
    const key = options.apiKey ?? process.env.EMBEDDING_OPENROUTER_KEY;
    if (!key) {
      throw new Error(
        "EMBEDDING_OPENROUTER_KEY is not set (or pass apiKey) — the RAG embed step needs a key",
      );
    }
    this.apiKey = key;
    this.model = options.model ?? DEFAULT_EMBEDDING_MODEL;
    this.baseUrl = options.baseUrl ?? DEFAULT_EMBEDDING_BASE_URL;
    this.batchSize = options.batchSize ?? 64;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: batch }),
      });
      if (!res.ok) {
        throw new Error(`embedding failed (${res.status}): ${await res.text()}`);
      }
      const body = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
      const data = body.data ?? [];
      if (data.length !== batch.length) {
        throw new Error(`embedding returned ${data.length} vectors for ${batch.length} texts`);
      }
      for (const item of data) {
        const embedding = item.embedding;
        if (!embedding) throw new Error("embedding response missing vector");
        out.push(embedding);
      }
    }
    return out;
  }
}
