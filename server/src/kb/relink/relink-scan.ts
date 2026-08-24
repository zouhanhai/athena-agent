/**
 * G4.S10.T3 — the deterministic FULL-GRAPH re-link pre-scan (NO LLM).
 *
 * Over every entity in the graph it produces near-duplicate CANDIDATE PAIRS
 * (hundreds-thousands even at 10k-100k node scale — never millions):
 *
 *   1. vector    — identity-text embeddings (same `entityIdentityText` the
 *                  ingest-time LINK lane uses, same TextEmbedder infra) scored
 *                  with cosine ≥ 0.85, top-k neighbours per node.
 *   2. name-variant — alias overlap: one entity's folded name appears in the
 *                  other's aliases[] (bilingual/renamed variants).
 *   3. same-name-different-type — identical `nameUpper` under different
 *                  normalized types ("CALEO" org vs "caleo" location) — never
 *                  auto-merged downstream, but must be adjudicated.
 *
 * Lanes dedupe into ONE pair per unordered key; the queue is capped
 * (`maxPairs`, best similarity first). Pure and deterministic: no LLM, no
 * graph writes.
 */
import type { TextEmbedder } from "../embedding.js";
import { cosineSimilarity, entityIdentityText } from "../store/entity-match.js";
import { normalizeLinkType } from "../link/link-engine.js";
import { foldName } from "../store/schema.js";

/** Vector cosine at/above which a pair becomes a re-link candidate. */
export const RELINK_SIMILARITY_THRESHOLD = 0.85;
/** Top-k nearest neighbours kept per node by the vector lane. */
export const RELINK_TOP_K = 5;
/** Hard cap on the candidate-pair queue fed to adjudication. */
export const RELINK_MAX_PAIRS = 2000;
/** Embedding request batch size for the pre-scan. */
const EMBED_BATCH_SIZE = 32;
/** Alias-lane similarity (aligns with the LINK engine's ALIAS_SIMILARITY). */
const ALIAS_SIMILARITY = 0.98;

/** Structural snapshot of one graph entity as read by the weekly pass. */
export interface RelinkEntitySnapshot {
  name: string;
  nameUpper: string;
  type?: string;
  description?: string;
  aliases?: string[];
  /** Document ids mentioning the entity (provenance, G4.S10.T2). */
  sourceDocs?: string[];
  /** Number of RELATION edges touching the node (low-degree sweep input). */
  degree?: number;
}

export type RelinkPairReason = "vector" | "name-variant" | "same-name-different-type";

export interface RelinkCandidatePair {
  /** Canonical graph names (pair.a/pair.b unordered, sorted by nameUpper). */
  a: string;
  b: string;
  similarity: number;
  reasons: RelinkPairReason[];
}

export interface RelinkScanOptions {
  /** Cosine threshold for the vector lane. Default RELINK_SIMILARITY_THRESHOLD. */
  threshold?: number;
  /** Nearest neighbours per node. Default RELINK_TOP_K. */
  topK?: number;
  /** Candidate queue cap. Default RELINK_MAX_PAIRS. */
  maxPairs?: number;
  /** Optional embedder — absent = name/alias/fold lanes only. */
  embedder?: TextEmbedder;
}

/**
 * Full-graph candidate scan. Deterministic, LLM-free, bounded output.
 */
export async function scanRelinkCandidates(
  entities: RelinkEntitySnapshot[],
  options: RelinkScanOptions = {},
): Promise<RelinkCandidatePair[]> {
  const threshold = options.threshold ?? RELINK_SIMILARITY_THRESHOLD;
  const topK = options.topK ?? RELINK_TOP_K;
  const maxPairs = options.maxPairs ?? RELINK_MAX_PAIRS;

  const nodes = entities
    .map((entity) => ({
      ...entity,
      nameUpper: foldName(entity.nameUpper || entity.name),
    }))
    .filter((node) => node.name.trim().length > 0);

  const pairs = new Map<string, RelinkCandidatePair>();
  const remember = (
    a: (typeof nodes)[number],
    b: (typeof nodes)[number],
    similarity: number,
    reason: RelinkPairReason,
  ): void => {
    if (a === b) return; // the SAME node, never a pair
    // Unordered key + canonical orientation: sort by nameUpper, then name.
    const [first, second] =
      a.nameUpper < b.nameUpper || (a.nameUpper === b.nameUpper && a.name <= b.name)
        ? [a, b]
        : [b, a];
    const key = `${first.nameUpper}\u0000${second.nameUpper}\u0000${first.name.toLowerCase()}`;
    const existing = pairs.get(key);
    if (!existing) {
      pairs.set(key, {
        a: first.name,
        b: second.name,
        similarity,
        reasons: [reason],
      });
      return;
    }
    existing.similarity = Math.max(existing.similarity, similarity);
    if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
  };

  // Lane 2+3 — alias variants + case-fold identity collisions (cheap, always on).
  const byNameUpper = new Map<string, typeof nodes>();
  for (const node of nodes) {
    const list = byNameUpper.get(node.nameUpper) ?? [];
    list.push(node);
    byNameUpper.set(node.nameUpper, list);
  }
  for (const group of byNameUpper.values()) {
    // Identical folded name → identity collision; flag type conflicts explicitly.
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i]!;
        const b = group[j]!;
        const reason: RelinkPairReason =
          normalizeLinkType(a.type) !== normalizeLinkType(b.type)
            ? "same-name-different-type"
            : "name-variant";
        remember(a, b, 1, reason);
      }
    }
  }
  for (const node of nodes) {
    for (const alias of node.aliases ?? []) {
      const upper = foldName(alias);
      if (!upper || upper === node.nameUpper) continue;
      for (const other of byNameUpper.get(upper) ?? []) {
        if (other === node) continue;
        remember(node, other, ALIAS_SIMILARITY, "name-variant");
      }
    }
  }

  // Lane 1 — embedding cosine over identity texts (top-k per node).
  if (options.embedder && nodes.length > 1) {
    const vectors = new Map<number, number[]>();
    for (let start = 0; start < nodes.length; start += EMBED_BATCH_SIZE) {
      const slice = nodes.slice(start, start + EMBED_BATCH_SIZE);
      const embeddings = await options.embedder.embed(slice.map(entityIdentityText));
      slice.forEach((_, index) => {
        const vector = embeddings[index];
        if (vector && vector.length > 0) vectors.set(start + index, vector);
      });
    }
    for (let i = 0; i < nodes.length; i += 1) {
      const vi = vectors.get(i);
      if (!vi) continue;
      const scored: Array<{ index: number; similarity: number }> = [];
      for (let j = 0; j < nodes.length; j += 1) {
        if (j === i) continue;
        const vj = vectors.get(j);
        if (!vj) continue;
        const similarity = cosineSimilarity(vi, vj);
        if (similarity >= threshold) scored.push({ index: j, similarity });
      }
      scored.sort((a, b) => b.similarity - a.similarity || nodes[a.index]!.nameUpper.localeCompare(nodes[b.index]!.nameUpper));
      for (const hit of scored.slice(0, topK)) {
        remember(nodes[i]!, nodes[hit.index]!, hit.similarity, "vector");
      }
    }
  }

  return [...pairs.values()]
    .sort(
      (a, b) =>
        b.similarity - a.similarity ||
        a.a.localeCompare(b.a) ||
        a.b.localeCompare(b.b),
    )
    .slice(0, maxPairs);
}
