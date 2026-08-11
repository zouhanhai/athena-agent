/**
 * Neo4j retrieval service (G4.S2.T5) — a TypeScript mirror of the official
 * `neo4j-graphrag` retriever family, over the existing store driver seam.
 *
 * The npm registry has no `neo4j-graphrag` package (it is Python-only), so this
 * module re-implements its retrievers on top of `Neo4jDriverLike`:
 *
 *   - `VectorRetriever`   — Cypher SEARCH clause (HNSW cosine) over Chunk.embedding,
 *                           with optional in-index topic filter (SEARCH…WHERE).
 *   - `Bm25Retriever`     — `db.index.fulltext.queryNodes` over Chunk.text
 *                           (the FULLTEXT index = BM25), case-insensitive.
 *   - `Text2CypherRetriever` — graph traversal over Entity/Relation, case-insensitive
 *                           entity matching via the folded name/alias FULLTEXT index.
 *   - `ToolsRetriever`    — lets an LLM (injected picker) choose the best retriever
 *                           per query (mirrors neo4j-graphrag ToolsRetriever).
 *
 * `Neo4jRetrievalService.search` fuses vector + BM25 + graph with reciprocal rank
 * fusion and tolerates per-source failures (Promise.allSettled), mirroring the
 * existing `KnowledgeRetrievalService.search` resilience.
 */
import type { TextEmbedder } from "../embedding.js";
import {
  CHUNK_EMBEDDING_INDEX,
  CHUNK_TEXT_FTX,
  ENTITY_LABEL,
  ENTITY_NAME_ALIASES_FTX,
  ENTITY_RELATION_TYPE,
  type Neo4jDriverLike,
} from "./schema.js";

/** A single fused retrieval hit over the Neo4j store. */
export interface Neo4jSearchHit {
  /** Chunk id (`<documentId>:<chunkId>`) or Entity name for graph hits. */
  id: string;
  /** Chunk text or entity description. */
  text: string;
  /** Document topic (chunk.topic). Present on chunk hits. */
  topic?: string;
  /** Source document id (chunk.documentId). Present on chunk hits. */
  documentId?: string;
  /** Which retriever produced this hit. */
  source: "vector" | "bm25" | "graph";
  /** Rank-fusion score (hybrid) or the raw retriever score. */
  score: number;
  /** 1-2 hop neighbor entity names (graph hits). */
  related?: string[];
}

export interface Neo4jSearchResponse {
  query: string;
  hits: Neo4jSearchHit[];
}

export interface Neo4jSearchOptions {
  /** Converge to a document domain: exact chunk.topic filter (case-insensitive). */
  topic?: string;
  topK?: number;
}

/** Tool names a ToolsRetriever picker can select. */
export type RetrieverName = "vector" | "bm25" | "graph" | "hybrid";

/** LLM picker seam for ToolsRetriever — decides the best retriever per query. */
export type RetrieverPicker = (query: string, available: RetrieverName[]) => Promise<RetrieverName>;

/** A minimal parsed Neo4j record from a session.run result (real driver + doubles). */
export interface Neo4jRecordLike {
  get(key: string): unknown;
}

/** Session.run result shape shared by the real neo4j-driver and test doubles. */
export interface Neo4jRunResultLike {
  records: Neo4jRecordLike[];
}

export interface Neo4jRetrievalOptions {
  driver: Neo4jDriverLike;
  /** Embed the query text for the vector retriever. */
  embedder: TextEmbedder;
  /** Default top-K per retriever. Default: 5. */
  topK?: number;
  /** LLM picker for ToolsRetriever. Default: "hybrid". */
  picker?: RetrieverPicker;
}

/** Reciprocate a 1-based rank into an RRF contribution (k=60, neo4j-graphrag default). */
function rrf(rank: number, k = 60): number {
  return 1 / (k + rank + 1);
}

/** Fold a query to lowercase for case-insensitive fulltext matching. */
export function foldQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** Open a session and run a query, returning parsed records (unknown → records). */
async function runRecords(
  driver: Neo4jDriverLike,
  query: string,
  params: Record<string, unknown>,
): Promise<Neo4jRecordLike[]> {
  const session = driver.session();
  try {
    const result = (await session.run(query, params)) as Neo4jRunResultLike;
    return Array.isArray(result?.records) ? result.records : [];
  } finally {
    await session.close();
  }
}

/** Read a string-ish record value (record.get may return null). */
function str(record: Neo4jRecordLike, key: string): string | undefined {
  const value = record.get(key);
  if (value === null || value === undefined) return undefined;
  return String(value);
}

/** Read a number-ish record value. */
function num(record: Neo4jRecordLike, key: string): number {
  const value = record.get(key);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Read a string list record value. */
function strList(record: Neo4jRecordLike, key: string): string[] {
  const value = record.get(key);
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string") return value.length > 0 ? [value] : [];
  return [];
}

/** Shared chunk-row mapping for vector + BM25 retrievers. */
function mapChunkRow(
  record: Neo4jRecordLike,
  source: "vector" | "bm25",
  score: number,
): Neo4jSearchHit {
  return {
    id: str(record, "id") ?? "",
    text: str(record, "text") ?? "",
    ...(str(record, "topic") !== undefined ? { topic: str(record, "topic") } : {}),
    ...(str(record, "documentId") !== undefined ? { documentId: str(record, "documentId") } : {}),
    source,
    score,
  };
}

/** Build the (optional) in-index topic predicate for a SEARCH…WHERE filter. */
function topicWhereParam(topic: string | undefined): { clause: string; topics?: string[] } {
  if (!topic) return { clause: "" };
  return { clause: "\n      WHERE c.topic IN $topics", topics: [topic] };
}

export class VectorRetriever {
  private readonly driver: Neo4jDriverLike;
  private readonly embedder: TextEmbedder;
  private readonly topK: number;

  constructor(options: { driver: Neo4jDriverLike; embedder: TextEmbedder; topK?: number }) {
    this.driver = options.driver;
    this.embedder = options.embedder;
    this.topK = options.topK ?? 5;
  }

  async search(query: string, options: Neo4jSearchOptions = {}): Promise<Neo4jSearchHit[]> {
    const topK = options.topK ?? this.topK;
    const [embedding] = await this.embedder.embed([query]);
    const { clause, topics } = topicWhereParam(options.topic);
    const params: Record<string, unknown> = {
      embedding,
      topK,
      ...(topics ? { topics } : {}),
    };
    const cypher =
      `CYPHER 25
` +
      `MATCH (c:Chunk)\n` +
      `  SEARCH c IN (\n` +
      `    VECTOR INDEX ${CHUNK_EMBEDDING_INDEX}\n` +
      `    FOR $embedding\n` +
      `${clause}\n` +
      `    LIMIT $topK\n` +
      `  ) SCORE AS score\n` +
      `RETURN c.id AS id, c.text AS text, c.topic AS topic, c.documentId AS documentId, score\n` +
      `ORDER BY score DESC`;
    const records = await runRecords(this.driver, cypher, params);
    return records.map((r) => mapChunkRow(r, "vector", num(r, "score")));
  }
}

export class Bm25Retriever {
  private readonly driver: Neo4jDriverLike;
  private readonly topK: number;

  constructor(options: { driver: Neo4jDriverLike; topK?: number }) {
    this.driver = options.driver;
    this.topK = options.topK ?? 5;
  }

  async search(query: string, options: Neo4jSearchOptions = {}): Promise<Neo4jSearchHit[]> {
    const topK = options.topK ?? this.topK;
    const params: Record<string, unknown> = {
      queryText: foldQuery(query),
      topK,
      ...(options.topic ? { topics: [options.topic] } : {}),
    };
    const topicFilter = options.topic ? "\n  WHERE c.topic IN $topics" : "";
    const cypher =
      `CALL db.index.fulltext.queryNodes('${CHUNK_TEXT_FTX}', $queryText) YIELD node AS c, score` +
      topicFilter +
      `\nRETURN c.id AS id, c.text AS text, c.topic AS topic, c.documentId AS documentId, score\n` +
      `ORDER BY score DESC\n` +
      `LIMIT $topK`;
    const records = await runRecords(this.driver, cypher, params);
    return records.map((r) => mapChunkRow(r, "bm25", num(r, "score")));
  }
}

/**
 * Graph traversal retriever (Text2Cypher mirror): matches entities case-insensitively
 * through the folded name+alias FULLTEXT index (bilingual DE+EN), then expands the
 * 1-2 hop RELATION neighborhood. The query text is the (lowercased) user query —
 * no LLM is needed because Athena already injected the graph.
 */
export class Text2CypherRetriever {
  private readonly driver: Neo4jDriverLike;
  private readonly topK: number;

  constructor(options: { driver: Neo4jDriverLike; topK?: number }) {
    this.driver = options.driver;
    this.topK = options.topK ?? 5;
  }

  async search(query: string, options: Neo4jSearchOptions = {}): Promise<Neo4jSearchHit[]> {
    const topK = options.topK ?? this.topK;
    const params: Record<string, unknown> = { queryText: foldQuery(query), topK };
    const cypher =
      `CALL db.index.fulltext.queryNodes('${ENTITY_NAME_ALIASES_FTX}', $queryText) YIELD node AS e, score\n` +
      `MATCH (e)-[r:${ENTITY_RELATION_TYPE}]-(n:Entity)\n` +
      `WITH e, score, collect(DISTINCT n.name) AS related\n` +
      `RETURN e.name AS id, e.description AS text, score, related\n` +
      `ORDER BY score DESC\n` +
      `LIMIT $topK`;
    const records = await runRecords(this.driver, cypher, params);
    return records.map((r) => ({
      id: str(r, "id") ?? "",
      text: str(r, "text") ?? "",
      source: "graph" as const,
      score: num(r, "score"),
      related: strList(r, "related"),
    }));
  }
}

/**
 * Hybrid retriever: fuse vector + BM25 ranked lists with reciprocal rank fusion
 * (k=60), producing a single deduplicated chunk ranking.
 */
export class HybridRetriever {
  private readonly vector: VectorRetriever;
  private readonly bm25: Bm25Retriever;

  constructor(options: { driver: Neo4jDriverLike; embedder: TextEmbedder; topK?: number }) {
    this.vector = new VectorRetriever(options);
    this.bm25 = new Bm25Retriever(options);
  }

  async search(query: string, options: Neo4jSearchOptions = {}): Promise<Neo4jSearchHit[]> {
    const [vector, bm25] = await Promise.allSettled([
      this.vector.search(query, options),
      this.bm25.search(query, options),
    ]);
    const lists = [
      vector.status === "fulfilled" ? vector.value : [],
      bm25.status === "fulfilled" ? bm25.value : [],
    ];
    return rrfFuse(lists, options.topK ?? 5);
  }
}

/** Reciprocal rank fusion over ranked hit lists, deduplicating by chunk id. */
export function rrfFuse(
  lists: Neo4jSearchHit[][],
  topK: number,
  k = 60,
): Neo4jSearchHit[] {
  const scores = new Map<string, number>();
  const byId = new Map<string, Neo4jSearchHit>();
  for (const list of lists) {
    for (const [rank, hit] of list.entries()) {
      if (byId.has(hit.id)) continue;
      byId.set(hit.id, hit);
    }
    list.forEach((hit, rank) => {
      const key = hit.id;
      if (!scores.has(key)) scores.set(key, 0);
      scores.set(key, scores.get(key)! + rrf(rank, k));
    });
  }
  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id]) => byId.get(id)!);
}

/** Default picker: hybrid fusion beats any single retriever. */
const DEFAULT_PICKER: RetrieverPicker = async () => "hybrid";

/**
 * ToolsRetriever: runs the retriever the LLM picker chooses for the query
 * (mirrors neo4j-graphrag ToolsRetriever). Defaults to the hybrid fusion.
 */
export class ToolsRetriever {
  private readonly options: Neo4jRetrievalOptions;
  private readonly picker: RetrieverPicker;
  private readonly hybrid: HybridRetriever;

  constructor(options: Neo4jRetrievalOptions) {
    this.options = options;
    this.picker = options.picker ?? DEFAULT_PICKER;
    this.hybrid = new HybridRetriever(options);
  }

  /** Pick + run the best retriever for this query. */
  async search(query: string, options: Neo4jSearchOptions = {}): Promise<Neo4jSearchHit[]> {
    const choice = await this.picker(query, ["vector", "bm25", "graph", "hybrid"]);
    switch (choice) {
      case "vector":
        return new VectorRetriever(this.options).search(query, options);
      case "bm25":
        return new Bm25Retriever(this.options).search(query, options);
      case "graph":
        return new Text2CypherRetriever(this.options).search(query, options);
      default:
        return this.hybrid.search(query, options);
    }
  }
}

/** A single node exported from the entity-relation graph (G4.S2.T10, Neo4j-backed). */
export interface Neo4jGraphNode {
  id: string;
  label: string;
  type?: string;
}

/** A single edge exported from the entity-relation graph. */
export interface Neo4jGraphEdge {
  source: string;
  target: string;
}

/** The entity-relation graph export shape. */
export interface Neo4jGraphExport {
  nodes: Neo4jGraphNode[];
  edges: Neo4jGraphEdge[];
}

/**
 * Neo4jRetrievalService — the fused retrieval entry point: runs vector + BM25 +
 * graph via Promise.allSettled (a failing source never kills the search), fuses
 * the chunk ranking with RRF, and appends graph hits. Case-insensitive BM25 +
 * graph, topic-scoped chunk retrieval.
 */
export class Neo4jRetrievalService {
  private readonly options: Neo4jRetrievalOptions;
  private readonly topK: number;
  private readonly picker: RetrieverPicker;

  constructor(options: Neo4jRetrievalOptions) {
    this.options = options;
    this.topK = options.topK ?? 5;
    this.picker = options.picker ?? DEFAULT_PICKER;
  }

  /** Fused search: vector + BM25 (RRF) + graph, topic-scoped, tolerant of failures. */
  async search(query: string, options: Neo4jSearchOptions = {}): Promise<Neo4jSearchResponse> {
    const topK = options.topK ?? this.topK;
    const [vector, bm25, graph] = await Promise.allSettled([
      new VectorRetriever(this.options).search(query, options),
      new Bm25Retriever(this.options).search(query, options),
      new Text2CypherRetriever(this.options).search(query, options),
    ]);
    const vectorHits = vector.status === "fulfilled" ? vector.value : [];
    const bm25Hits = bm25.status === "fulfilled" ? bm25.value : [];
    const graphHits = graph.status === "fulfilled" ? graph.value : [];
    const fused = rrfFuse([vectorHits, bm25Hits], topK);
    const hits = [...fused, ...graphHits];
    return { query, hits };
  }

  /** Agentic retrieval: the LLM picker chooses the best retriever per query. */
  async toolsSearch(query: string, options: Neo4jSearchOptions = {}): Promise<Neo4jSearchResponse> {
    const hits = await new ToolsRetriever(this.options).search(query, options);
    return { query, hits };
  }

  /** GET /api/kb/graph → the full entity-relation graph stored in Neo4j
   *  (Entity nodes + RELATION edges). Case-insensitive: node names are returned
   *  canonical. */
  async getGraph(): Promise<Neo4jGraphExport> {
    const session = this.options.driver.session();
    try {
      const nodesResult = (await session.run(
        `MATCH (n:${ENTITY_LABEL}) RETURN n.name AS name, n.type AS type`,
      )) as Neo4jRunResultLike;
      const nodes: Neo4jGraphNode[] = [];
      for (const record of nodesResult?.records ?? []) {
        const name = record.get("name");
        if (name === null || name === undefined) continue;
        const type = record.get("type");
        nodes.push({
          id: String(name),
          label: String(name),
          ...(type !== null && type !== undefined ? { type: String(type) } : {}),
        });
      }

      const edgesResult = (await session.run(
        `MATCH (a:${ENTITY_LABEL})-[r:${ENTITY_RELATION_TYPE}]->(b:${ENTITY_LABEL})
         RETURN a.name AS source, b.name AS target`,
      )) as Neo4jRunResultLike;
      const edges: Neo4jGraphEdge[] = [];
      for (const record of edgesResult?.records ?? []) {
        const source = record.get("source");
        const target = record.get("target");
        if (source === null || source === undefined || target === null || target === undefined) continue;
        edges.push({ source: String(source), target: String(target) });
      }

      return { nodes, edges };
    } finally {
      await session.close();
    }
  }
}
