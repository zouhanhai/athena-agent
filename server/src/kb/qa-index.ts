/**
 * Q&A dedup vector index (G4.S3.T5).
 *
 * Before inserting a new Q&A pair, `FeedbackService` embeds the question with
 * the same embedder as the RAG store (`qwen/qwen3-embedding-8b`) and searches
 * the existing Q&A questions for a semantically similar one. When one exists at
 * or above the dedup threshold, the pair is updated instead of duplicated.
 *
 * Implementations:
 *   - `Neo4jQaEmbeddingIndex`  — a `QaPair` node mirror with an HNSW cosine
 *     vector index over `question_embedding` (production).
 *   - `MemoryQaEmbeddingIndex` — in-memory cosine search (tests / fallback).
 */
import type { TextEmbedder } from "./embedding.js";
import {
  EMBEDDING_DIMENSIONS,
  QA_PAIR_LABEL,
  QA_QUESTION_EMBEDDING_INDEX,
  type Neo4jDriverLike,
} from "./store/schema.js";

export { QA_PAIR_LABEL, QA_QUESTION_EMBEDDING_INDEX };

export interface QaSimilarMatch {
  id: string;
  question: string;
  /** Cosine similarity of the matched question (>= the requested threshold). */
  score: number;
}

/** A vector index over the stored Q&A questions, used for insert-vs-update dedup. */
export interface QaEmbeddingIndex {
  /** Store (or refresh) the question embedding for a pair. */
  upsert(id: string, question: string): Promise<void>;
  /** The stored pair whose question is most similar to `question`, when its
   *  similarity >= threshold. Null when the index is empty or below threshold. */
  findSimilar(question: string, threshold: number): Promise<QaSimilarMatch | null>;
  /** Drop a pair's embedding. */
  remove(id: string): Promise<void>;
}

/** Cosine similarity in [0, 1] between two vectors (0 for empty/zero vectors). */
export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** In-memory Q&A question index with exact cosine search (tests / fallback). */
export class MemoryQaEmbeddingIndex implements QaEmbeddingIndex {
  private readonly embedder: TextEmbedder;
  private readonly entries = new Map<string, { question: string; embedding: number[] }>();

  constructor(options: { embedder: TextEmbedder }) {
    this.embedder = options.embedder;
  }

  async upsert(id: string, question: string): Promise<void> {
    const [embedding] = await this.embedder.embed([question]);
    this.entries.set(id, { question, embedding });
  }

  async findSimilar(question: string, threshold: number): Promise<QaSimilarMatch | null> {
    const [embedding] = await this.embedder.embed([question]);
    let best: QaSimilarMatch | null = null;
    for (const [id, entry] of this.entries) {
      const score = cosineSimilarity(embedding, entry.embedding);
      if (score >= threshold && (!best || score > best.score)) {
        best = { id, question: entry.question, score: round4(score) };
      }
    }
    return best;
  }

  async remove(id: string): Promise<void> {
    this.entries.delete(id);
  }
}

/** Neo4j-backed Q&A question index: a `QaPair` node mirror + HNSW cosine index
 *  over `question_embedding`, searched with the Cypher SEARCH clause. */
export class Neo4jQaEmbeddingIndex implements QaEmbeddingIndex {
  private readonly driver: Neo4jDriverLike;
  private readonly embedder: TextEmbedder;
  private ready: Promise<void> | null = null;

  constructor(options: { driver: Neo4jDriverLike; embedder: TextEmbedder }) {
    this.driver = options.driver;
    this.embedder = options.embedder;
  }

  /** Lazily create the vector index + id constraint (idempotent). */
  private ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = this.init();
    }
    return this.ready;
  }

  private async init(): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `CREATE VECTOR INDEX ${QA_QUESTION_EMBEDDING_INDEX} IF NOT EXISTS FOR (n:${QA_PAIR_LABEL}) ON (n.question_embedding) OPTIONS { indexConfig: { \`vector.dimensions\`: ${EMBEDDING_DIMENSIONS}, \`vector.similarity_function\`: 'cosine' } }`,
      );
      await session.run(
        `CREATE CONSTRAINT qa_pair_id_unique IF NOT EXISTS FOR (n:${QA_PAIR_LABEL}) REQUIRE n.id IS UNIQUE`,
      );
    } finally {
      await session.close();
    }
  }

  async upsert(id: string, question: string): Promise<void> {
    await this.ensureReady();
    const [embedding] = await this.embedder.embed([question]);
    const session = this.driver.session();
    try {
      await session.run(
        `MERGE (n:${QA_PAIR_LABEL} {id: $id}) SET n.question = $question, n.question_embedding = $embedding`,
        { id, question, embedding },
      );
    } finally {
      await session.close();
    }
  }

  async findSimilar(question: string, threshold: number): Promise<QaSimilarMatch | null> {
    await this.ensureReady();
    const [embedding] = await this.embedder.embed([question]);
    const session = this.driver.session();
    try {
      const result = (await session.run(
        `CYPHER 25
         MATCH (n:${QA_PAIR_LABEL})
           SEARCH n IN (VECTOR INDEX ${QA_QUESTION_EMBEDDING_INDEX} FOR $embedding) SCORE AS score
         RETURN n.id AS id, n.question AS question, score
         ORDER BY score DESC
         LIMIT 1`,
        { embedding },
      )) as { records?: Array<{ get(key: string): unknown }> };
      const record = result?.records?.[0];
      if (!record) return null;
      const score = typeof record.get("score") === "number" ? (record.get("score") as number) : 0;
      if (score < threshold) return null;
      const id = record.get("id");
      const matched = record.get("question");
      return {
        id: id === null || id === undefined ? "" : String(id),
        question: matched === null || matched === undefined ? "" : String(matched),
        score: round4(score),
      };
    } finally {
      await session.close();
    }
  }

  async remove(id: string): Promise<void> {
    await this.ensureReady();
    const session = this.driver.session();
    try {
      await session.run(`MATCH (n:${QA_PAIR_LABEL} {id: $id}) DELETE n`, { id });
    } finally {
      await session.close();
    }
  }
}
