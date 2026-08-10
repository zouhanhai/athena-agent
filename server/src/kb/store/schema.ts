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
 * Case-insensitive-friendly indexing (LightRAG's `caleo`/`CALEO` bug must not recur, per ADR-0008):
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

/** Relationship type linking Entity nodes (source -> target). */
export const ENTITY_RELATION_TYPE = "RELATION";

/** Neo4j HNSW cosine vector index over Chunk.embedding (dimensions match qwen3-embedding-8b @ 1024). */
export const EMBEDDING_DIMENSIONS = 1024;

/**
 * Fold a name to a case-insensitive canonical form (`toUpper`, Unicode-aware so German umlauts
 * case-fold correctly: "lüsen" -> "LÜSEN"). Stored as Entity.nameUpper and range-indexed for exact
 * case-insensitive lookup (ADR-0008 — the normalized-property pattern that fixes LightRAG's bug).
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
    // HNSW cosine vector index over Athena-chunk embeddings, with topic as an additional property so
    // retrieval can filter in-index via SEARCH…WHERE (ADR-0008, Neo4j 2026 Community).
    `CREATE VECTOR INDEX chunk_embedding_idx IF NOT EXISTS FOR (n:${CHUNK_LABEL}) ON (n.embedding) WITH [n.topic] OPTIONS { indexConfig: { \`vector.dimensions\`: ${EMBEDDING_DIMENSIONS}, \`vector.similarity_function\`: 'cosine' } }`,
    // Folded canonical name -> exact case-insensitive lookup (nameUpper = toUpper(name)).
    `CREATE RANGE INDEX entity_name_upper_idx IF NOT EXISTS FOR (n:${ENTITY_LABEL}) ON (n.nameUpper)`,
    // Bilingual alias search: FULLTEXT over name + aliases folds case AND diacritics ("zentraler
    // omnibusbahnhof" matches the EN node ZOB München).
    `CREATE FULLTEXT INDEX entity_name_aliases_ftx IF NOT EXISTS FOR (n:${ENTITY_LABEL}) ON EACH [n.name, n.aliases]`,
    // BM25 retrieval over chunk text (neo4j-graphrag HybridRetriever full-text half, G4.S2.T5).
    `CREATE FULLTEXT INDEX chunk_text_ftx IF NOT EXISTS FOR (n:${CHUNK_LABEL}) ON EACH [n.text]`,
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

/**
 * Apply the full store schema (constraints + indexes) to a Neo4j instance. Each statement runs in the
 * same session, in order; every statement is `IF NOT EXISTS` so calling again is a no-op.
 */
export async function applyNeo4jSchema(driver: Neo4jDriverLike): Promise<void> {
  const session = driver.session();
  try {
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
