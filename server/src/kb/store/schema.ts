/**
 * Neo4j store schema for the single lean RAG store (G4.S2.T3, ADR-0008).
 *
 * One Neo4j store holds vector + graph + topic:
 *   - `Chunk` nodes   — Athena-provided paragraph-semantic chunks {id, text, embedding, topic, heading_path}.
 *   - `Entity` nodes  — Athena-provided knowledge-graph nodes {name (canonical), aliases[], type, description},
 *                       plus a folded `nameUpper` property for case-insensitive exact lookup.
 *   - `Document`/`WikiPage` nodes — {id, topic, type, md_ref, title}.
 *   - `Entity` relations — directed `(:Entity)-[RELATION]->(:Entity)` edges {source, target, keywords[],
 *     description}.
 *
 * Case-insensitive-friendly indexing (the case-sensitive lookup bug must not recur, per ADR-0008):
 *   - `nameUpper = toUpper(name)` stored on Entity + RANGE index → exact case-insensitive lookup.
 *   - FULLTEXT index over `name` + `aliases` folds case AND diacritics → bilingual (DE+EN) alias search.
 *
 * The module is pure Cypher (no driver dependency): `storeSchemaStatements()` returns the ordered
 * DDL to run, and `applyNeo4jSchema(driver)` executes them via a minimal driver-like session seam so
 * any Neo4j driver (or a test double) can apply the schema.
 */
import type { RefinementEntity, RefinementRelation } from "../../agents/refine-document.js";

/** Node labels of the single lean store (one store for vector + graph + topic). */
export const CHUNK_LABEL = "Chunk";
export const ENTITY_LABEL = "Entity";
export const DOCUMENT_LABEL = "Document";
export const WIKIPAGE_LABEL = "WikiPage";
export const SECTION_LABEL = "Section";

/** Relationship type linking Entity nodes (source -> target). */
export const ENTITY_RELATION_TYPE = "RELATION";

/** RAG↔Wiki fusion relationship types (G4.S2.T11): the Document/Section/Chunk/WikiPage spine. */
export const HAS_SECTION_TYPE = "HAS_SECTION";
export const HAS_SUBSECTION_TYPE = "HAS_SUBSECTION";
export const PART_OF_TYPE = "PART_OF";
export const IS_DOCUMENT_TYPE = "IS_DOCUMENT";

/** Neo4j HNSW cosine vector index over Chunk.embedding (qwen3-embedding-8b emits 4096-dim vectors). */
export const EMBEDDING_DIMENSIONS = 4096;

/** Index names used by retrieval (G4.S2.T5) — shared with the schema DDL so
 *  retrievers reference the exact indexes created at ingest time. */
export const CHUNK_EMBEDDING_INDEX = "chunk_embedding_idx";
export const ENTITY_NAME_UPPER_INDEX = "entity_name_upper_idx";
export const ENTITY_NAME_ALIASES_FTX = "entity_name_aliases_ftx";
export const CHUNK_TEXT_FTX = "chunk_text_ftx";

/**
 * Fold a name to a case-insensitive canonical form (`toUpper`, Unicode-aware so German umlauts
 * case-fold correctly: "lüsen" -> "LÜSEN"). Stored as Entity.nameUpper and range-indexed for exact
 * case-insensitive lookup (ADR-0008 — the normalized-property pattern).
 */
export function foldName(name: string): string {
  return name.toUpperCase();
}

/** Fold a list of aliases the same way (bilingual DE+EN variants, ADR-0008). */
export function foldAliases(aliases: string[]): string[] {
  return aliases.map(foldName);
}

/**
 * The ordered list of Neo4j DDL statements that define the store schema: uniqueness constraints,
 * the HNSW vector index (cosine, with `topic` as an in-index filter property), case-insensitive
 * (folded) name/alias indexes, and BM25 fulltext over chunk text. All statements use `IF NOT EXISTS`
 * so re-application is idempotent.
 */
export function storeSchemaStatements(): string[] {
  return [
    `CREATE CONSTRAINT chunk_id_unique IF NOT EXISTS FOR (n:${CHUNK_LABEL}) REQUIRE n.id IS UNIQUE`,
    `CREATE CONSTRAINT entity_name_unique IF NOT EXISTS FOR (n:${ENTITY_LABEL}) REQUIRE n.name IS UNIQUE`,
    `CREATE CONSTRAINT document_id_unique IF NOT EXISTS FOR (n:${DOCUMENT_LABEL}) REQUIRE n.id IS UNIQUE`,
    `CREATE CONSTRAINT wikipage_id_unique IF NOT EXISTS FOR (n:${WIKIPAGE_LABEL}) REQUIRE n.id IS UNIQUE`,
    `CREATE CONSTRAINT section_id_unique IF NOT EXISTS FOR (n:${SECTION_LABEL}) REQUIRE n.id IS UNIQUE`,
    // HNSW cosine vector index over Athena-chunk embeddings, with topic as an additional property so
    // retrieval can filter in-index via SEARCH…WHERE (ADR-0008, Neo4j 2026 Community).
    `CREATE VECTOR INDEX ${CHUNK_EMBEDDING_INDEX} IF NOT EXISTS FOR (n:${CHUNK_LABEL}) ON (n.embedding) WITH [n.topic] OPTIONS { indexConfig: { \`vector.dimensions\`: ${EMBEDDING_DIMENSIONS}, \`vector.similarity_function\`: 'cosine' } }`,
    // Folded canonical name -> exact case-insensitive lookup (nameUpper = toUpper(name)).
    `CREATE RANGE INDEX ${ENTITY_NAME_UPPER_INDEX} IF NOT EXISTS FOR (n:${ENTITY_LABEL}) ON (n.nameUpper)`,
    // Bilingual alias search: FULLTEXT over name + aliases folds case AND diacritics ("zentraler
    // omnibusbahnhof" matches the EN node ZOB München).
    `CREATE FULLTEXT INDEX ${ENTITY_NAME_ALIASES_FTX} IF NOT EXISTS FOR (n:${ENTITY_LABEL}) ON EACH [n.name, n.aliases]`,
    // BM25 retrieval over chunk text (neo4j-graphrag HybridRetriever full-text half, G4.S2.T5).
    `CREATE FULLTEXT INDEX ${CHUNK_TEXT_FTX} IF NOT EXISTS FOR (n:${CHUNK_LABEL}) ON EACH [n.text]`,
  ];
}

/** Minimal driver-like session seam used by `applyNeo4jSchema` (test doubles + real drivers alike). */
export interface Neo4jSessionLike {
  run(query: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** Minimal driver-like seam: one session to run schema DDL against. */
export interface Neo4jDriverLike {
  session(): Neo4jSessionLike;
}

/** A parsed `SHOW INDEXES` row, normalized for conflict detection. */
export interface ExistingIndexInfo {
  name: string;
  type: string;
  labels: string[];
  properties: string[];
  /** `options.indexConfig` from the index (e.g. `vector.dimensions`). */
  indexConfig?: Record<string, unknown>;
}

/** The label+property sets the app schema wants indexed under fixed names. */
interface IntendedIndex {
  name: string;
  labels: string[];
  properties: string[];
  type: "VECTOR" | "RANGE" | "FULLTEXT";
}

const INTENDED_INDEXES: IntendedIndex[] = [
  { name: CHUNK_EMBEDDING_INDEX, labels: [CHUNK_LABEL], properties: ["embedding", "topic"], type: "VECTOR" },
  { name: ENTITY_NAME_UPPER_INDEX, labels: [ENTITY_LABEL], properties: ["nameUpper"], type: "RANGE" },
  { name: ENTITY_NAME_ALIASES_FTX, labels: [ENTITY_LABEL], properties: ["name", "aliases"], type: "FULLTEXT" },
  { name: CHUNK_TEXT_FTX, labels: [CHUNK_LABEL], properties: ["text"], type: "FULLTEXT" },
];

function sameSet(a: string[], b: string[]): boolean {
  const as = new Set(a);
  const bs = new Set(b);
  if (as.size !== bs.size) return false;
  for (const v of as) if (!bs.has(v)) return false;
  return true;
}

/**
 * Compare existing indexes against the app's intended index set and return
 * `DROP INDEX … IF EXISTS` statements for conflicts:
 *  - any existing index over the same label+property set under a *different* name
 *    (Neo4j 2026 silently dedups same-properties index creates, so the app-named
 *    index would never materialize — e.g. the spike's `entity_ft_idx` shadowing
 *    `entity_name_aliases_ftx`), and
 *  - the vector index when its configured `vector.dimensions` differs from
 *    `EMBEDDING_DIMENSIONS` (a stale spike index stuck at 1024 while the real
 *    qwen3-embedding-8b emits 4096-dim vectors → vector search fails).
 */
export function reconcileIndexStatements(existing: ExistingIndexInfo[]): string[] {
  const drops = new Set<string>();
  for (const index of existing) {
    const intended = INTENDED_INDEXES.find(
      (i) => i.type === index.type && sameSet(i.labels, index.labels) && sameSet(i.properties, index.properties),
    );
    if (!intended) continue;
    if (intended.name !== index.name) {
      drops.add(index.name);
      continue;
    }
    if (intended.type === "VECTOR") {
      const configured = index.indexConfig?.["vector.dimensions"];
      if (configured !== undefined && String(configured) !== String(EMBEDDING_DIMENSIONS)) {
        drops.add(index.name);
      }
    }
  }
  return Array.from(drops).map((name) => `DROP INDEX ${name} IF EXISTS`);
}

/** Run `SHOW INDEXES` and normalize the rows into `ExistingIndexInfo[]`. */
async function listExistingIndexes(session: Neo4jSessionLike): Promise<ExistingIndexInfo[]> {
  const result = (await session.run(
    "SHOW INDEXES YIELD name, type, labelsOrTypes, properties, options RETURN name, type, labelsOrTypes, properties, options",
  )) as { records?: Array<{ get(key: string): unknown }> };
  const records = result?.records ?? [];
  return records.map((record) => {
    const labels = record.get("labelsOrTypes");
    const props = record.get("properties");
    const options = record.get("options") as { indexConfig?: Record<string, unknown> } | undefined;
    return {
      name: String(record.get("name")),
      type: String(record.get("type")),
      labels: Array.isArray(labels) ? labels.map(String) : [],
      properties: Array.isArray(props) ? props.map(String) : [],
      ...(options?.indexConfig ? { indexConfig: options.indexConfig } : {}),
    };
  });
}

/**
 * Apply the full store schema (constraints + indexes) to a Neo4j instance. First
 * reconciles conflicting existing indexes (drop → the app-named creates
 * materialize), then runs each statement in the same session; every statement is
 * `IF NOT EXISTS` so calling again is a no-op.
 */
export async function applyNeo4jSchema(driver: Neo4jDriverLike): Promise<void> {
  const session = driver.session();
  try {
    const existing = await listExistingIndexes(session);
    for (const statement of reconcileIndexStatements(existing)) {
      await session.run(statement);
    }
    for (const statement of storeSchemaStatements()) {
      await session.run(statement);
    }
  } finally {
    await session.close();
  }
}

/**
 * Build the property map stored on an Entity node from Athena's refinement output (G4.S1/T1 contract):
 * canonical `name` + bilingual `aliases[]`, plus the folded `nameUpper` for case-insensitive lookup.
 */
export function entityNodeProps(entity: RefinementEntity): Record<string, unknown> {
  const aliases = entity.aliases ?? [];
  return {
    name: entity.name,
    aliases,
    type: entity.type,
    description: entity.description,
    nameUpper: foldName(entity.name),
  };
}

/**
 * Build the property map stored on a RELATION edge from Athena's refinement output: source/target
 * entity names (folded for case-insensitive graph lookup), relationship keywords and description.
 */
export function relationEdgeProps(relation: RefinementRelation): Record<string, unknown> {
  return {
    source: relation.source,
    target: relation.target,
    sourceUpper: foldName(relation.source),
    targetUpper: foldName(relation.target),
    keywords: relation.keywords,
    description: relation.description,
  };
}
