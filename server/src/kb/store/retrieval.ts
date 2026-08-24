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
  CHUNK_LABEL,
  CHUNK_TEXT_FTX,
  CO_OCCURS_TYPE,
  COMMUNITY_LABEL,
  COMMUNITY_SUMMARY_EMBEDDING_INDEX,
  COMMUNITY_SUMMARY_FTX,
  DOCUMENT_LABEL,
  ENTITY_LABEL,
  ENTITY_NAME_ALIASES_FTX,
  ENTITY_RELATION_TYPE,
  IS_DOCUMENT_TYPE,
  MEMBER_TYPE,
  MENTIONED_IN_TYPE,
  PART_OF_TYPE,
  SECTION_LABEL,
  WIKIPAGE_LABEL,
  type Neo4jDriverLike,
} from "./schema.js";
import type { Reranker } from "./rerank.js";

export type { Reranker, RerankerRequest } from "./rerank.js";
export { LlamaCppReranker } from "./rerank.js";

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
  /** Wiki page path of the hit's document, via Document -[:IS_DOCUMENT]-> WikiPage
   *  (RAG↔Wiki fusion, G4.S2.T11). Present on chunk hits with a bridged wiki page. */
  wikiPath?: string;
  /** Heading path of the chunk's deepest Section (e.g. "Sommerseminar / Workshops"). */
  sectionPath?: string;
  /** Same-section sibling chunk texts (context enrichment, G4.S2.T11). */
  siblings?: string[];
  /** G4.S9.T3: set when this hit is a COMMUNITY SUMMARY (global scope) —
   *  carries the community id so callers can tell summary hits from chunks. */
  communityId?: string;
}

export interface Neo4jSearchResponse {
  query: string;
  hits: Neo4jSearchHit[];
}

/** Retrieval scope (G4.S9.T3): "local" (default) = the per-chunk fused search;
 *  "global" = corpus-level QA over community summaries + member chunks. */
export type SearchScope = "local" | "global";

export interface Neo4jSearchOptions {
  /** Converge to a document domain: exact chunk.topic filter (case-insensitive). */
  topic?: string;
  /** Topic-subtree scope (G4.S3.T4): chunk.topic must be one of these. Preferred
   *  over `topic` — the caller expands the scope into the concrete subtree list
   *  from the wiki frontmatter so candidates are pre-filtered before scoring. */
  topics?: string[];
  topK?: number;
  /** Attach same-section sibling chunk texts to each chunk hit (context enrichment). Default false. */
  enrichContext?: boolean;
  /** Max sibling chunks per hit when enrichContext is on. Default: 4. */
  contextSize?: number;
  /** Cross-encoder reranker for this search (overrides the service-level one). Default: off. */
  reranker?: Reranker;
  /** Max fused hits the reranker sees for this search. Default: 20. */
  rerankTopN?: number;
  /** Agentic picker override (G4.S3.T7.3): run ONLY this retriever instead of the
   *  fused vector+BM25+graph search. Options flow through to the chosen retriever
   *  (topic/topics/topK/enrichContext still apply). */
  retriever?: RetrieverName;
  /** G4.S9.T3: "global" runs the community-summary path (embed query → top
   *  summaries → best 1-3 communities → MENTIONED_IN member chunks → fusion +
   *  rerank). Default "local" keeps the current per-chunk fused search. */
  scope?: SearchScope;
  /** Global scope: how many top communities to expand. Default 3. */
  communityTopK?: number;
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
  /** Optional cross-encoder reranker applied to the fused top-k after RRF (G4.S2.T14). Default: off. */
  reranker?: Reranker;
  /** Max fused hits the reranker sees. Default: 20. */
  rerankTopN?: number;
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
    ...(str(record, "sectionPath") !== undefined ? { sectionPath: str(record, "sectionPath") } : {}),
    ...(str(record, "wikiPath") !== undefined ? { wikiPath: str(record, "wikiPath") } : {}),
    source,
    score,
  };
}

/** Cypher suffix joining a matched chunk to its Section chain + Document → WikiPage
 *  so every chunk hit carries sectionPath + wikiPath (RAG↔Wiki fusion, G4.S2.T11). */
const CHUNK_WIKI_JOIN =
  `OPTIONAL MATCH (c)-[:${PART_OF_TYPE}]->(sec:${SECTION_LABEL})\n` +
  `OPTIONAL MATCH (d:${DOCUMENT_LABEL} {id: c.documentId})-[:${IS_DOCUMENT_TYPE}]->(wp:${WIKIPAGE_LABEL})\n`;

/** Build the (optional) topic predicate for a SEARCH…WHERE / WHERE filter.
 *  `topics` (subtree list) wins over `topic`; when both absent no filter is built. */
function topicWhereParam(topic: string | undefined, topics?: string[]): { clause: string; topics?: string[] } {
  const list = topics ?? (topic ? [topic] : undefined);
  if (!list || list.length === 0) return { clause: "" };
  return { clause: "\n      WHERE c.topic IN $topics", topics: list };
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
    const { clause, topics } = topicWhereParam(options.topic, options.topics);
    const params: Record<string, unknown> = {
      embedding,
      topK,
      ...(topics ? { topics } : {}),
    };
    const cypher =
      `CYPHER 25
` +
      `MATCH (c:${CHUNK_LABEL})\n` +
      `  SEARCH c IN (\n` +
      `    VECTOR INDEX ${CHUNK_EMBEDDING_INDEX}\n` +
      `    FOR $embedding\n` +
      `${clause}\n` +
      `    LIMIT $topK\n` +
      `  ) SCORE AS score\n` +
      CHUNK_WIKI_JOIN +
      `RETURN c.id AS id, c.text AS text, c.topic AS topic, c.documentId AS documentId,\n` +
      `       sec.path AS sectionPath, wp.path AS wikiPath, score\n` +
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
    const { clause, topics } = topicWhereParam(options.topic, options.topics);
    const params: Record<string, unknown> = {
      queryText: foldQuery(query),
      topK,
      ...(topics ? { topics } : {}),
    };
    const topicFilter = clause ? clause.replace(/^[ \t]+/, "\n  ") : "";
    const cypher =
      `CALL db.index.fulltext.queryNodes('${CHUNK_TEXT_FTX}', $queryText) YIELD node AS c, score` +
      topicFilter +
      `\n` +
      CHUNK_WIKI_JOIN +
      `RETURN c.id AS id, c.text AS text, c.topic AS topic, c.documentId AS documentId,\n` +
      `       sec.path AS sectionPath, wp.path AS wikiPath, score\n` +
      `ORDER BY score DESC\n` +
      `LIMIT $topK`;
    const records = await runRecords(this.driver, cypher, params);
    return records.map((r) => mapChunkRow(r, "bm25", num(r, "score")));
  }
}

/**
 * Graph traversal retriever (Text2Cypher mirror, G4.S2.T14): matches entities
 * case-insensitively through the folded name+alias FULLTEXT index (bilingual DE+EN),
 * then returns the chunks the entity is MENTIONED_IN — with the entity + its RELATION
 * neighbors kept as context. Chunk hits carry the same T11 shape as vector/BM25
 * (id/topic/documentId/sectionPath/wikiPath) so all three sources RRF-fuse by chunk id.
 * The query text is the (lowercased) user query — no LLM is needed because Athena
 * already injected the graph.
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
    const { clause, topics } = topicWhereParam(options.topic, options.topics);
    const params: Record<string, unknown> = {
      queryText: foldQuery(query),
      topK,
      ...(topics ? { topics } : {}),
    };
    const topicFilter = clause ? `${clause}\n` : "";
    const cypher =
      `CALL db.index.fulltext.queryNodes('${ENTITY_NAME_ALIASES_FTX}', $queryText) YIELD node AS e, score\n` +
      `MATCH (e)-[:${MENTIONED_IN_TYPE}]->(c:${CHUNK_LABEL})\n` +
      topicFilter +
      // G4.S9.T3 graph expansion: neighbor context traverses real RELATION edges
      // AND the weak CO_OCCURS edges (graphs without CO_OCCURS degrade to the
      // previous RELATION-only behavior).
      `OPTIONAL MATCH (e)-[r:${ENTITY_RELATION_TYPE}|${CO_OCCURS_TYPE}]-(n:${ENTITY_LABEL})\n` +
      `WITH e, c, score, collect(DISTINCT n.name) AS neighbors\n` +
      CHUNK_WIKI_JOIN +
      `RETURN c.id AS id, c.text AS text, c.topic AS topic, c.documentId AS documentId,\n` +
      `       sec.path AS sectionPath, wp.path AS wikiPath, score,\n` +
      `       e.name AS entity, neighbors\n` +
      `ORDER BY score DESC\n` +
      `LIMIT $topK`;
    const records = await runRecords(this.driver, cypher, params);
    return records.map((r) => ({
      id: str(r, "id") ?? "",
      text: str(r, "text") ?? "",
      ...(str(r, "topic") !== undefined ? { topic: str(r, "topic") } : {}),
      ...(str(r, "documentId") !== undefined ? { documentId: str(r, "documentId") } : {}),
      ...(str(r, "sectionPath") !== undefined ? { sectionPath: str(r, "sectionPath") } : {}),
      ...(str(r, "wikiPath") !== undefined ? { wikiPath: str(r, "wikiPath") } : {}),
      source: "graph" as const,
      score: num(r, "score"),
      related: [str(r, "entity"), ...strList(r, "neighbors")].filter((v): v is string => Boolean(v)),
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

// ---------------------------------------------------------------------------
// G4.S9.T3 — global (community-level) retrieval
// ---------------------------------------------------------------------------

/** Map a Community-summary row to a tagged search hit. */
function mapCommunityRow(record: Neo4jRecordLike, source: "vector" | "bm25", score: number): Neo4jSearchHit {
  const id = str(record, "id") ?? "";
  return {
    id,
    text: str(record, "text") ?? "",
    ...(str(record, "theme") !== undefined ? { topic: str(record, "theme") } : {}),
    source,
    score,
    communityId: id,
  };
}

/**
 * Vector half of the global query path (G4.S9.T3): embeds the query and searches
 * the HNSW index over Community.summary embeddings (written by the T2 summarizer).
 */
export class CommunitySummaryVectorRetriever {
  private readonly driver: Neo4jDriverLike;
  private readonly embedder: TextEmbedder;
  private readonly topK: number;

  constructor(options: { driver: Neo4jDriverLike; embedder: TextEmbedder; topK?: number }) {
    this.driver = options.driver;
    this.embedder = options.embedder;
    this.topK = options.topK ?? 3;
  }

  async search(query: string, options: Neo4jSearchOptions = {}): Promise<Neo4jSearchHit[]> {
    const topK = options.topK ?? this.topK;
    const [embedding] = await this.embedder.embed([query]);
    const cypher =
      `CYPHER 25\n` +
      `MATCH (c:${COMMUNITY_LABEL})\n` +
      `  SEARCH c IN (\n` +
      `    VECTOR INDEX ${COMMUNITY_SUMMARY_EMBEDDING_INDEX}\n` +
      `    FOR $embedding\n` +
      `    LIMIT $topK\n` +
      `  ) SCORE AS score\n` +
      `RETURN c.id AS id, c.summary AS text, c.theme AS theme, score\n` +
      `ORDER BY score DESC`;
    const records = await runRecords(this.driver, cypher, { embedding, topK });
    return records.map((r) => mapCommunityRow(r, "vector", num(r, "score")));
  }
}

/** BM25 half of the global query path: fulltext over Community.summary + theme. */
export class CommunitySummaryBm25Retriever {
  private readonly driver: Neo4jDriverLike;
  private readonly topK: number;

  constructor(options: { driver: Neo4jDriverLike; topK?: number }) {
    this.driver = options.driver;
    this.topK = options.topK ?? 3;
  }

  async search(query: string, options: Neo4jSearchOptions = {}): Promise<Neo4jSearchHit[]> {
    const topK = options.topK ?? this.topK;
    const cypher =
      `CALL db.index.fulltext.queryNodes('${COMMUNITY_SUMMARY_FTX}', $queryText) YIELD node AS c, score\n` +
      `RETURN c.id AS id, c.summary AS text, c.theme AS theme, score\n` +
      `ORDER BY score DESC\n` +
      `LIMIT $topK`;
    const records = await runRecords(this.driver, cypher, { queryText: foldQuery(query), topK });
    return records.map((r) => mapCommunityRow(r, "bm25", num(r, "score")));
  }
}

/**
 * Member-chunk walk of the global query path: for the best communities, gather
 * every member entity's MENTIONED_IN chunks — the grounded evidence pool that
 * fuses with (and reranks against) the community summaries themselves.
 */
export class CommunityMemberChunksRetriever {
  private readonly driver: Neo4jDriverLike;
  private readonly topK: number;

  constructor(options: { driver: Neo4jDriverLike; topK?: number }) {
    this.driver = options.driver;
    this.topK = options.topK ?? 5;
  }

  async search(communityIds: string[], options: Neo4jSearchOptions = {}): Promise<Neo4jSearchHit[]> {
    const topK = options.topK ?? this.topK;
    const ids = communityIds.filter((id) => id.trim().length > 0);
    if (ids.length === 0) return [];
    const cypher =
      `UNWIND $communityIds AS cid\n` +
      `MATCH (:${COMMUNITY_LABEL} {id: cid})-[:${MEMBER_TYPE}]->(e:${ENTITY_LABEL})\n` +
      `MATCH (e)-[:${MENTIONED_IN_TYPE}]->(c:${CHUNK_LABEL})\n` +
      CHUNK_WIKI_JOIN +
      `RETURN DISTINCT c.id AS id, c.text AS text, c.topic AS topic, c.documentId AS documentId,\n` +
      `       sec.path AS sectionPath, wp.path AS wikiPath\n` +
      `ORDER BY c.id\n` +
      `LIMIT $topK`;
    const records = await runRecords(this.driver, cypher, { communityIds: ids, topK });
    return records.map((r) => ({
      id: str(r, "id") ?? "",
      text: str(r, "text") ?? "",
      ...(str(r, "topic") !== undefined ? { topic: str(r, "topic") } : {}),
      ...(str(r, "documentId") !== undefined ? { documentId: str(r, "documentId") } : {}),
      ...(str(r, "sectionPath") !== undefined ? { sectionPath: str(r, "sectionPath") } : {}),
      ...(str(r, "wikiPath") !== undefined ? { wikiPath: str(r, "wikiPath") } : {}),
      source: "graph" as const,
      score: 1,
    }));
  }
}

/** Reciprocal rank fusion over ranked hit lists, deduplicating by chunk id. */export function rrfFuse(
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

  /** Pick + run the best retriever for this query. An explicit `options.retriever`
   *  (agentic picker override, G4.S3.T7.3) wins over the injected picker. */
  async search(query: string, options: Neo4jSearchOptions = {}): Promise<Neo4jSearchHit[]> {
    const choice = options.retriever ?? (await this.picker(query, ["vector", "bm25", "graph", "hybrid"]));
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
 * graph via Promise.allSettled (a failing source never kills the search), fuses all
 * three chunk rankings with RRF, then optionally reranks the fused top-k with a
 * cross-encoder. Case-insensitive BM25 + graph, topic-scoped chunk retrieval.
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

  /** Fused search: vector + BM25 + graph (RRF over all three, all chunk hits) + optional
   *  cross-encoder rerank of the fused top-k, topic-scoped, tolerant of failures. With
   *  `enrichContext`, each chunk hit is enriched with its same-section sibling chunk texts
   *  (G4.S2.T11) — best-effort, a failing enrichment never kills the search. When
   *  `options.retriever` is set (agentic picker, G4.S3.T7.3) ONLY that retriever runs. */
  async search(query: string, options: Neo4jSearchOptions = {}): Promise<Neo4jSearchResponse> {
    // G4.S9.T3: the global scope answers corpus-level questions over community
    // summaries instead of the per-chunk fused search.
    if (options.scope === "global") {
      return this.globalSearch(query, options);
    }
    if (options.retriever) {
      const picked = await new ToolsRetriever(this.options).search(query, {
        ...options,
        retriever: options.retriever,
      });
      return { query, hits: picked };
    }
    const topK = options.topK ?? this.topK;
    const [vector, bm25, graph] = await Promise.allSettled([
      new VectorRetriever(this.options).search(query, options),
      new Bm25Retriever(this.options).search(query, options),
      new Text2CypherRetriever(this.options).search(query, options),
    ]);
    const vectorHits = vector.status === "fulfilled" ? vector.value : [];
    const bm25Hits = bm25.status === "fulfilled" ? bm25.value : [];
    const graphHits = graph.status === "fulfilled" ? graph.value : [];
    let hits = rrfFuse([vectorHits, bm25Hits, graphHits], topK);

    // Optional cross-encoder rerank of the fused top-k (G4.S2.T14). Never the whole
    // corpus; a failing reranker falls back to the RRF-only ranking (no regression).
    const reranker = options.reranker ?? this.options.reranker;
    if (reranker) {
      const rerankTopN = options.rerankTopN ?? this.options.rerankTopN ?? 20;
      hits = await reranker.rerank(query, hits, rerankTopN).catch(() => hits);
    }

    if (options.enrichContext) {
      const contextSize = options.contextSize ?? 4;
      for (const hit of hits) {
        if (!hit.documentId) continue;
        const siblings = await this.sameSectionTexts(hit, contextSize).catch(() => []);
        if (siblings.length > 0) hit.siblings = siblings;
      }
    }

    return { query, hits };
  }

  /**
   * Global query path (G4.S9.T3): embed query → top community summaries (vector
   * + BM25 over the summary indexes, RRF-fused) → pick the best 1-3 communities →
   * gather member entities' chunks via the existing MENTIONED_IN walk → fuse
   * summaries + chunks into ONE pool (summaries are first-class hits, so answers
   * stay community-grounded) → optional cross-encoder rerank, as in local mode.
   * Every stage is failure-tolerant; no communities/summaries yet → empty hits.
   */
  private async globalSearch(query: string, options: Neo4jSearchOptions): Promise<Neo4jSearchResponse> {
    const topK = options.topK ?? this.topK;
    const communityTopK = options.communityTopK ?? 3;

    const [vector, bm25] = await Promise.allSettled([
      new CommunitySummaryVectorRetriever(this.options).search(query, { topK: communityTopK }),
      new CommunitySummaryBm25Retriever(this.options).search(query, { topK: communityTopK }),
    ]);
    const vectorSummaries = vector.status === "fulfilled" ? vector.value : [];
    const bm25Summaries = bm25.status === "fulfilled" ? bm25.value : [];
    let hits = rrfFuse([vectorSummaries, bm25Summaries], communityTopK);

    const communityIds = [...new Set(hits.map((h) => h.communityId).filter((id): id is string => Boolean(id)))]
      .slice(0, communityTopK);
    if (communityIds.length > 0) {
      const chunks = await new CommunityMemberChunksRetriever(this.options)
        .search(communityIds, { topK })
        .catch(() => []);
      hits = rrfFuse([chunks, hits], topK);
    }

    // Same rerank contract as the fused local search: failing reranker falls back.
    const reranker = options.reranker ?? this.options.reranker;
    if (reranker && hits.length > 0) {
      const rerankTopN = options.rerankTopN ?? this.options.rerankTopN ?? 20;
      hits = await reranker.rerank(query, hits, rerankTopN).catch(() => hits);
    }

    return { query, hits };
  }

  /**
   * Context enrichment (G4.S2.T11): return the texts of the sibling chunks that
   * share the hit's deepest Section. Best-effort — callers should .catch(() => []).
   */
  async sameSectionTexts(hit: { id: string }, limit = 4): Promise<string[]> {
    const cypher =
      `MATCH (c:${CHUNK_LABEL} {id: $id})-[:${PART_OF_TYPE}]->(sec:${SECTION_LABEL})\n` +
      `MATCH (sib:${CHUNK_LABEL})-[:${PART_OF_TYPE}]->(sec)\n` +
      `WHERE sib.id <> c.id\n` +
      `RETURN sib.text AS text\n` +
      `ORDER BY sib.id\n` +
      `LIMIT $limit`;
    const records = await runRecords(this.options.driver, cypher, { id: hit.id, limit });
    return records.map((r) => str(r, "text") ?? "");
  }

  /** Agentic retrieval: the LLM picker chooses the best retriever per query. */
  async toolsSearch(query: string, options: Neo4jSearchOptions = {}): Promise<Neo4jSearchResponse> {
    const hits = await new ToolsRetriever(this.options).search(query, options);
    return { query, hits };
  }

  /** GET /api/kb/graph → the full entity-relation graph stored in Neo4j
   *  (Entity nodes + RELATION edges). Case-insensitive: node names are returned
   *  canonical. */
  async getGraph(topic?: string): Promise<Neo4jGraphExport> {
    const session = this.options.driver.session();
    try {
      // G4.S10 topic filter: when a topic is selected, only entities that are
      // MENTIONED_IN a chunk of that topic participate; edges are kept only
      // between surviving nodes.
      const match = topic
        ? `MATCH (n:${ENTITY_LABEL}) WHERE EXISTS { MATCH (n)-[:MENTIONED_IN]->(:Chunk {topic: $topic}) }`
        : `MATCH (n:${ENTITY_LABEL})`;
      const params = topic ? { topic } : {};
      const nodesResult = (await session.run(
        `${match} RETURN n.name AS name, n.type AS type`,
        params,
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

      const edgeMatch = topic
        ? `MATCH (a:${ENTITY_LABEL})-[r:${ENTITY_RELATION_TYPE}]->(b:${ENTITY_LABEL})
           WHERE (a)-[:MENTIONED_IN]->(:Chunk {topic: $topic})
             AND (b)-[:MENTIONED_IN]->(:Chunk {topic: $topic})`
        : `MATCH (a:${ENTITY_LABEL})-[r:${ENTITY_RELATION_TYPE}]->(b:${ENTITY_LABEL})`;
      const edgesResult = (await session.run(
        `${edgeMatch}
         RETURN a.name AS source, b.name AS target`,
        params,
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
