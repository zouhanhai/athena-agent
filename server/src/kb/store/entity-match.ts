/**
 * G4.S10.T1 — the `ExistingGraphApi` port over the Neo4j entity graph.
 *
 * Lane strategy per candidate (best-first, deduped by identity):
 *   1. exact    — folded nameUpper identity hit (similarity 1).
 *   2. alias    — candidate folds INTO an existing aliases[] entry (0.98).
 *   3. substring— containment either direction, both ≥4 chars (0.9) — a noise
 *                 guard so tiny tokens never substring-match.
 *   4. vector   — BM25 fulltext pool (`entity_name_aliases_ftx`) → on-the-fly
 *                 embedding of each pool entry's identity text → real cosine
 *                 against the candidate; sub-floor scores are dropped.
 *
 * Entities carry no stored embeddings today, so lane 4 embeds only the small
 * pooled set — bounded work per candidate, real ≥0.92 gating for the LINK
 * deterministic tier.
 */
import {
  ENTITY_NAME_ALIASES_FTX,
  ENTITY_LABEL,
  type Neo4jDriverLike,
} from "./schema.js";
import type {
  ExistingEntityMatch,
  ExistingGraphApi,
  LinkCandidate,
} from "../link/link-engine.js";
import type { TextEmbedder } from "../embedding.js";

export interface EntityIdentity {
  name: string;
  nameUpper: string;
  type?: string;
  description?: string;
  aliases?: string[];
}

interface EntityRowReader {
  get(key: string): unknown;
}

export interface Neo4jExistingGraphApiOptions {
  driver: Neo4jDriverLike;
  /** Optional: enables the vector tier. Absent = deterministic lanes only. */
  embedder?: TextEmbedder;
  /** BM25 pool size feeding the vector tier. Default 20. */
  poolLimit?: number;
}

const EXACT_SIMILARITY = 1;
const ALIAS_SIMILARITY = 0.98;
const SUBSTRING_SIMILARITY = 0.9;
/** Vector hits below the LLM-adjudication floor carry no signal → dropped. */
const VECTOR_FLOOR = 0.6;
const MIN_SUBSTRING_CHARS = 4;
/** Identity text cap before embedding. */
const IDENTITY_TEXT_MAX_CHARS = 320;

/** Fold name/type/description into ONE bounded embedding input. */
export function entityIdentityText(entity: {
  name: string;
  type?: string;
  description?: string;
}): string {
  const base = `${entity.name}${entity.type ? ` (${entity.type})` : ""}${
    entity.description ? `: ${entity.description}` : ""
  }`;
  return base.slice(0, IDENTITY_TEXT_MAX_CHARS);
}

/** Cosine similarity over equal-length float vectors (0 for degenerate input). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

export class Neo4jExistingGraphApi implements ExistingGraphApi {
  private readonly driver: Neo4jDriverLike;
  private readonly embedder?: TextEmbedder;
  private readonly poolLimit: number;

  constructor(options: Neo4jExistingGraphApiOptions) {
    this.driver = options.driver;
    this.embedder = options.embedder;
    this.poolLimit = options.poolLimit ?? 20;
  }

  async findMatches(candidate: LinkCandidate, limit: number): Promise<ExistingEntityMatch[]> {
    const folded = candidate.name.toUpperCase().trim();
    if (!folded) return [];

    const session = this.driver.session();
    const run = async (query: string, params: Record<string, unknown>): Promise<EntityRowReader[]> => {
      try {
        const result = (await session.run(query, params)) as { records?: EntityRowReader[] };
        return result?.records ?? [];
      } catch {
        // A lane failure degrades that lane only — linking must never block.
        return [];
      }
    };
    try {
      const bestByName = new Map<string, ExistingEntityMatch>();
      const remember = (match: ExistingEntityMatch): void => {
        const key = match.name.toUpperCase();
        const existing = bestByName.get(key);
        if (!existing || match.similarity > existing.similarity) bestByName.set(key, match);
      };

      // 1. exact identity
      const exactRows = await run(
        `MATCH (e:${ENTITY_LABEL} {nameUpper: $nameUpper})
         RETURN e.name AS name, e.type AS type, e.description AS description
         LIMIT 1`,
        { nameUpper: folded },
      );
      for (const row of exactRows) {
        remember({
          name: strOf(row, "name") ?? candidate.name,
          ...(strOf(row, "type") ? { type: strOf(row, "type") } : {}),
          similarity: EXACT_SIMILARITY,
          evidence_quote: evidenceOf(row),
          source: "exact",
        });
      }

      // 2. folded aliases
      if (bestByName.size < limit) {
        const aliasRows = await run(
          `MATCH (e:${ENTITY_LABEL})
           WHERE $nameUpper IN e.aliases
           RETURN e.name AS name, e.type AS type, e.description AS description
           LIMIT $limit`,
          { nameUpper: folded, limit },
        );
        for (const row of aliasRows) {
          remember({
            name: strOf(row, "name") ?? candidate.name,
            ...(strOf(row, "type") ? { type: strOf(row, "type") } : {}),
            similarity: ALIAS_SIMILARITY,
            evidence_quote: evidenceOf(row),
            source: "alias",
          });
        }
      }

      // 3. containment either direction (≥4 chars)
      if (bestByName.size < limit && folded.length >= MIN_SUBSTRING_CHARS) {
        const substringRows = await run(
          `MATCH (e:${ENTITY_LABEL})
           WHERE (e.nameUpper CONTAINS $nameUpper AND size(e.nameUpper) >= $minChars)
              OR ($nameUpper CONTAINS e.nameUpper AND size(e.nameUpper) >= $minChars AND e.nameUpper <> $nameUpper)
           RETURN e.name AS name, e.type AS type, e.description AS description
           LIMIT $limit`,
          { nameUpper: folded, minChars: MIN_SUBSTRING_CHARS, limit },
        );
        for (const row of substringRows) {
          remember({
            name: strOf(row, "name") ?? candidate.name,
            ...(strOf(row, "type") ? { type: strOf(row, "type") } : {}),
            similarity: SUBSTRING_SIMILARITY,
            evidence_quote: evidenceOf(row),
            source: "substring",
          });
        }
      }

      // 4. BM25 pool + on-the-fly vector scoring
      if (this.embedder) {
        const poolRows = await run(
          `CALL db.index.fulltext.queryNodes('${ENTITY_NAME_ALIASES_FTX}', $queryText)
           YIELD node AS e, score
           RETURN e.name AS name, e.type AS type, e.description AS description
           ORDER BY score DESC
           LIMIT $poolLimit`,
          { queryText: folded.toLowerCase(), poolLimit: this.poolLimit },
        );
        const pool = poolRows
          .map((row) => ({
            name: strOf(row, "name") ?? "",
            type: strOf(row, "type"),
            description: strOf(row, "description"),
          }))
          .filter((row) => row.name.length > 0 && !bestByName.has(row.name.toUpperCase()));
        if (pool.length > 0) {
          const [candidateVector] = await this.embedder.embed([entityIdentityText(candidate)]);
          if (candidateVector) {
            const vectors = await this.embedder.embed(pool.map(entityIdentityText));
            pool.forEach((entry, index) => {
              const vector = vectors[index];
              if (!vector) return;
              const similarity = Number(cosineSimilarity(candidateVector, vector).toFixed(4));
              if (similarity < VECTOR_FLOOR) return;
              remember({
                name: entry.name,
                ...(entry.type ? { type: entry.type } : {}),
                similarity,
                evidence_quote: (entry.description ?? entry.name)
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 80),
                source: "vector",
              });
            });
          }
        }
      }

      return [...bestByName.values()]
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
    } finally {
      await session.close();
    }
  }
}

function strOf(row: EntityRowReader, key: string): string | undefined {
  const value = row.get(key);
  return value === null || value === undefined ? undefined : String(value);
}

function evidenceOf(row: EntityRowReader): string {
  const description = strOf(row, "description");
  const name = strOf(row, "name") ?? "";
  return (description ?? name).replace(/\s+/g, " ").trim().slice(0, 80);
}
