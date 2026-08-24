/**
 * G4.S10.T1 — the LINK engine (graph-aware entity linking).
 *
 * Channel-agnostic, pure-ish matcher between a batch of freshly extracted
 * candidate entities and the EXISTING knowledge graph:
 *
 *   deterministic tier (no LLM): exact nameUpper / alias / substring hit or
 *     vector similarity ≥ AUTO_MERGE_SIMILARITY — always guarded by "same
 *     normalized type". Different known types NEVER merge; they route to the
 *     typed-edge path instead.
 *   LLM tier: ambiguous candidates (AMBIGUOUS_SIMILARITY_FLOOR ≤ similarity <
 *     AUTO_MERGE_SIMILARITY, or unknown/`other` types) get ONE json_schema
 *     call carrying top-K existing matches + evidence quotes. Retries ≤ N
 *     with a repair retry on schema mismatch; TOTAL failure degrades to
 *     deterministic-only results and never blocks ingestion.
 *
 * Input/output contract is bounded by construction: candidates + per-candidate
 * top-K matches only — no full documents, no full graph, no markdown
 * re-emission. Output = {merges[], new_edges[], standalone[]} with endpoint
 * validation (merge from∈candidates, to∈existing; edge endpoints∈
 * candidates∪existing), evidence quotes capped at EVIDENCE_MAX_CHARS and the
 * LLM response capped via max_tokens.
 *
 * This module deliberately imports NOTHING from the refine modules — it is
 * consumed by both the upload refine pass and the wiki-edit diff-refine.
 */

/** A candidate entity as produced by any refinement channel (structural). */
export interface LinkCandidate {
  name: string;
  type?: string;
  description?: string;
  aliases?: string[];
  occurrences?: string[];
}

/** One pre-ranked match of a candidate against an existing graph entity. */
export interface ExistingEntityMatch {
  name: string;
  type?: string;
  /** Normalized 0..1 similarity (1 = exact identity). */
  similarity: number;
  /** ≤80-char quote grounding the match (entity description / chunk text). */
  evidence_quote: string;
  /** Which retrieval lane produced the hit. */
  source: "exact" | "alias" | "substring" | "vector";
}

/** The read port the engine uses to consult the existing graph. */
export interface ExistingGraphApi {
  /** Top-K existing entities matching `candidate`, best first. */
  findMatches(candidate: LinkCandidate, limit: number): Promise<ExistingEntityMatch[]>;
}

export interface LinkMerge {
  /** Candidate name (verbatim from the batch). */
  from: string;
  /** Existing canonical node name. */
  to: string;
  similarity: number;
  evidence: string;
}

export interface LinkNewEdge {
  source: string;
  target: string;
  /** Semantic relation keyword, e.g. "HAS_OFFICE". */
  relation: string;
  evidence_quote: string;
}

export interface LinkDecisions {
  merges: LinkMerge[];
  new_edges: LinkNewEdge[];
  /** Candidate names that stay untouched (no merge). */
  standalone: string[];
}

/** Structural subset of the refinement LLM caller — both transports satisfy it. */
export interface LinkLlmMessagePart {
  type: string;
  text?: string;
}

export type LinkLlmCaller = (params: {
  systemPrompt: string;
  userContent: string;
  schema?: unknown;
  maxTokens?: number;
  model?: string;
  reasoningEffort?: "none" | "low" | "medium" | "high";
}) => Promise<{ message: { content?: Array<LinkLlmMessagePart> }; usage?: unknown }>;

/** The hook both pipelines accept: candidates in, link decisions out. */
export type EntityLinker = (candidates: LinkCandidate[]) => Promise<LinkDecisions>;

// --- tuning constants ---------------------------------------------------------

/** Vector similarity at/above which a same-type candidate auto-merges. */
export const AUTO_MERGE_SIMILARITY = 0.92;
/** Similarity at/above which an unmatched candidate goes to the LLM tier. */
export const AMBIGUOUS_SIMILARITY_FLOOR = 0.6;
/** Hard cap for every evidence string crossing the contract. */
export const EVIDENCE_MAX_CHARS = 80;
/** max_tokens cap on the LLM adjudication response (bounded output). */
export const LINK_MAX_TOKENS = 2048;
/** LLM attempts per batch (initial + repair retries), aligned with refine. */
export const LINK_LLM_RETRIES = 3;
/** Top-K existing matches carried per candidate into the LLM prompt. */
export const LINK_TOP_K = 5;

/**
 * Type normalization BEFORE matching (G4.S10 Spec §3): observed leakage like
 * organization/group beside org must not split identities; place/location are
 * folded too. Unknown/`other` types never merge deterministically — they go to
 * the LLM ("other→prompt LLM").
 */
const TYPE_NORMALIZATION_MAP: Record<string, string> = {
  organization: "org",
  group: "org",
  company: "org",
  place: "location",
  city: "location",
};

export function normalizeLinkType(raw: string | undefined): string {
  const folded = (raw ?? "").trim().toLowerCase();
  return TYPE_NORMALIZATION_MAP[folded] ?? folded;
}

// --- engine -------------------------------------------------------------------

interface CandidateMatchContext {
  candidate: LinkCandidate;
  matches: ExistingEntityMatch[];
  decision:
    | { kind: "deterministic-merge"; target: ExistingEntityMatch }
    | { kind: "ambiguous" }
    | { kind: "standalone" };
}

function sameKnownType(a: string | undefined, b: string | undefined): boolean | undefined {
  const na = normalizeLinkType(a);
  const nb = normalizeLinkType(b);
  if (!na || !nb || na === "other" || nb === "other") return undefined;
  return na === nb;
}

function truncateEvidence(raw: string | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim().slice(0, EVIDENCE_MAX_CHARS);
}

function classify(
  candidate: LinkCandidate,
  matches: ExistingEntityMatch[],
): CandidateMatchContext["decision"] {
  const best = matches[0];
  if (!best) return { kind: "standalone" };
  if (best.similarity < AMBIGUOUS_SIMILARITY_FLOOR) return { kind: "standalone" };
  const sameType = sameKnownType(candidate.type, best.type);
  if (sameType === false) {
    // Different KNOWN types → NEVER merge; the typed-edge path decides below.
    return { kind: "ambiguous" };
  }
  if (sameType === true) {
    const strong =
      best.source !== "vector" || best.similarity >= AUTO_MERGE_SIMILARITY;
    if (strong) return { kind: "deterministic-merge", target: best };
  }
  // Same type but sub-threshold vector similarity, or unknown/`other` types.
  return { kind: "ambiguous" };
}

/** Loose JSON extraction: code fences stripped, first {...} block parsed. */
function parseJsonLoose(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

const LINK_SYSTEM_PROMPT = `You are the entity-LINK adjudicator of the athena knowledge graph (G4.S10).

You receive CANDIDATE entities extracted from one document and, per candidate, the TOP existing
graph matches (name/type/similarity/evidence quote). Decide for every AMBIGUOUS candidate:

- "merges": the candidate IS the same real-world thing as an existing entity. Only when types are
  compatible. NEVER invent targets — "to" must be one of the listed existing names.
- "new_edges": a TYPED cross-entity edge instead of a merge (e.g. different types, org HAS_OFFICE
  location). Endpoints must be candidate names OR listed existing names. Keep "relation" short
  UPPER_SNAKE (HAS_OFFICE, PART_OF, EMPLOYS).
- Everything you cannot decide with the given evidence belongs in "standalone".

Return ONLY a JSON object {"merges":[...],"new_edges":[...],"standalone":[...]} matching the given
schema. Evidence fields MUST be short verbatim quotes (≤80 chars) taken from the provided context.
Do NOT restate documents. Do NOT invent entities.`;

function buildLlmPrompt(contexts: CandidateMatchContext[]): string {
  const candidates = contexts.map(({ candidate }) => ({
    name: candidate.name,
    ...(candidate.type ? { type: candidate.type } : {}),
    ...(candidate.description ? { description: candidate.description.slice(0, 200) } : {}),
    ...(candidate.occurrences && candidate.occurrences.length > 0
      ? { occurrences: candidate.occurrences.slice(0, 2).map((o) => o.slice(0, EVIDENCE_MAX_CHARS)) }
      : {}),
  }));
  const matchesByCandidate: Record<string, Array<Pick<ExistingEntityMatch, "name" | "type" | "similarity" | "evidence_quote">>> = {};
  for (const { candidate, matches } of contexts) {
    matchesByCandidate[candidate.name] = matches.map((m) => ({
      name: m.name,
      ...(m.type ? { type: m.type } : {}),
      similarity: Number(m.similarity.toFixed(4)),
      evidence_quote: m.evidence_quote,
    }));
  }
  return JSON.stringify({ candidates, existing_matches: matchesByCandidate });
}

interface RawLinkPayload {
  merges?: Array<{ from?: unknown; to?: unknown; similarity?: unknown; evidence?: unknown }>;
  new_edges?: Array<{ source?: unknown; target?: unknown; relation?: unknown; evidence_quote?: unknown }>;
  standalone?: unknown[];
}

function parseRawPayload(message: { content?: Array<LinkLlmMessagePart> }): RawLinkPayload | undefined {
  const text = (message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  if (!text.trim()) return undefined;
  const parsed = parseJsonLoose(text);
  if (!parsed || typeof parsed !== "object") return undefined;
  return parsed as RawLinkPayload;
}

/**
 * One json_schema-constrained adjudication over all ambiguous candidates.
 * Returns validated decisions plus the names seen, so callers can trust the
 * endpoints without re-querying the graph.
 */
async function adjudicateWithLlm(options: {
  llm: LinkLlmCaller;
  contexts: CandidateMatchContext[];
  candidateNames: Set<string>;
  existingNames: Set<string>;
  topK: number;
  maxTokens: number;
  retries: number;
}): Promise<{ merges: LinkMerge[]; new_edges: LinkNewEdge[] }> {
  const { llm, contexts, candidateNames, existingNames, topK, maxTokens, retries } = options;
  const ambiguous = contexts.filter((c) => c.decision.kind === "ambiguous");
  if (ambiguous.length === 0) return { merges: [], new_edges: [] };

  const baseUserContent = buildLlmPrompt(ambiguous);
  let lastErrors: string[] = [];
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const repairNote =
      attempt === 1
        ? ""
        : `\n\n[repair retry ${attempt - 1}] Your previous response was invalid: ${lastErrors.join(" | ")}. Return ONLY a corrected JSON object matching the schema.`;
    try {
      const { message } = await llm({
        systemPrompt: LINK_SYSTEM_PROMPT,
        userContent: baseUserContent + repairNote,
        schema: LINK_DECISIONS_SCHEMA,
        maxTokens,
        reasoningEffort: "none",
      });
      const raw = parseRawPayload(message);
      if (!raw) {
        lastErrors = ["unparseable output"];
        continue;
      }
      const errors: string[] = [];
      const merges = validateMerges(raw.merges, candidateNames, existingNames, errors);
      const newEdges = validateEdges(raw.new_edges, candidateNames, existingNames, errors);
      if (errors.length === 0) {
        return { merges: dedupeMerges(merges), new_edges: newEdges };
      }
      lastErrors = errors;
    } catch (err) {
      lastErrors = [err instanceof Error ? err.message : String(err)];
    }
  }
  throw new Error(`link LLM adjudication failed after ${retries} attempt(s): ${lastErrors.join(" | ")}`);
}

function validateMerges(
  raw: NonNullable<RawLinkPayload["merges"]> | undefined,
  candidateNames: Set<string>,
  existingNames: Set<string>,
  _errors: string[],
): LinkMerge[] {
  const out: LinkMerge[] = [];
  for (const entry of raw ?? []) {
    const from = typeof entry.from === "string" ? entry.from : "";
    const to = typeof entry.to === "string" ? entry.to : "";
    if (!from || !to) continue;
    // Endpoint violations are SOFT-dropped (phantom nodes never enter the
    // decisions); they do not burn repair retries — the shape was parseable.
    if (!candidateNames.has(from)) {
      console.warn(`[link] dropped merge with non-candidate from "${from}"`);
      continue;
    }
    if (!existingNames.has(to)) {
      console.warn(`[link] dropped merge to non-existing "${to}"`);
      continue;
    }
    out.push({
      from,
      to,
      similarity: typeof entry.similarity === "number" && Number.isFinite(entry.similarity)
        ? Math.min(1, Math.max(0, entry.similarity))
        : 0.75,
      evidence: truncateEvidence(typeof entry.evidence === "string" ? entry.evidence : ""),
    });
  }
  return out;
}

function validateEdges(
  raw: NonNullable<RawLinkPayload["new_edges"]> | undefined,
  candidateNames: Set<string>,
  existingNames: Set<string>,
  _errors: string[],
): LinkNewEdge[] {
  const universe = new Set([...candidateNames, ...existingNames]);
  const out: LinkNewEdge[] = [];
  for (const entry of raw ?? []) {
    const source = typeof entry.source === "string" ? entry.source : "";
    const target = typeof entry.target === "string" ? entry.target : "";
    const relation = typeof entry.relation === "string" ? entry.relation.trim().toUpperCase() : "";
    if (!source || !target || !relation) continue;
    if (!universe.has(source) || !universe.has(target)) {
      console.warn(`[link] dropped edge with phantom endpoint(s): "${source}"→"${target}"`);
      continue;
    }
    out.push({
      source,
      target,
      relation: relation.slice(0, 60),
      evidence_quote: truncateEvidence(typeof entry.evidence_quote === "string" ? entry.evidence_quote : ""),
    });
  }
  return out;
}

function dedupeMerges(merges: LinkMerge[]): LinkMerge[] {
  const seen = new Set<string>();
  const out: LinkMerge[] = [];
  for (const merge of merges) {
    if (merge.from.toUpperCase() === merge.to.toUpperCase()) continue;
    const key = `${merge.from.toUpperCase()}→${merge.to.toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(merge);
  }
  return out;
}

/** TypeBox-style schema handed to json_schema transports (advisory shape). */
export const LINK_DECISIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["merges", "new_edges", "standalone"],
  properties: {
    merges: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["from", "to", "similarity", "evidence"],
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          similarity: { type: "number" },
          evidence: { type: "string" },
        },
      },
    },
    new_edges: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source", "target", "relation", "evidence_quote"],
        properties: {
          source: { type: "string" },
          target: { type: "string" },
          relation: { type: "string" },
          evidence_quote: { type: "string" },
        },
      },
    },
    standalone: { type: "array", items: { type: "string" } },
  },
};

/**
 * Match a batch of candidate entities against the existing graph and return
 * merge/edge/standalone decisions. Never throws: LLM failure degrades to the
 * deterministic-only result so ingestion is never blocked by linking.
 */
export async function linkCandidates(input: {
  candidates: LinkCandidate[];
  existingGraphApi: ExistingGraphApi;
  /** Optional adjudicator for ambiguous candidates (omit = deterministic-only). */
  llm?: LinkLlmCaller;
  /** Top-K existing matches consulted/carried per candidate. Default 5. */
  topK?: number;
  /** max_tokens cap for the LLM response. Default LINK_MAX_TOKENS. */
  maxTokens?: number;
  /** LLM attempts (initial + repairs). Default LINK_LLM_RETRIES. */
  retries?: number;
}): Promise<LinkDecisions> {
  const { candidates, existingGraphApi } = input;
  const topK = input.topK ?? LINK_TOP_K;
  const maxTokens = input.maxTokens ?? LINK_MAX_TOKENS;
  const retries = Math.max(1, input.retries ?? LINK_LLM_RETRIES);

  const empty: LinkDecisions = { merges: [], new_edges: [], standalone: [] };
  if (candidates.length === 0) return empty;

  // 1. Consult the existing graph per candidate (read failures degrade that
  //    candidate to standalone — linking must never block ingestion).
  const contexts: CandidateMatchContext[] = [];
  const existingNames = new Set<string>();
  for (const candidate of candidates) {
    let matches: ExistingEntityMatch[] = [];
    try {
      matches = [...(await existingGraphApi.findMatches(candidate, topK))]
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, topK);
    } catch (err) {
      console.warn(
        `[link] findMatches failed for "${candidate.name}": ${err instanceof Error ? err.message : String(err)} — treating as standalone`,
      );
    }
    for (const match of matches) existingNames.add(match.name);
    contexts.push({ candidate, matches, decision: classify(candidate, matches) });
  }

  // 2. Deterministic merges land immediately.
  const merges: LinkMerge[] = [];
  for (const { candidate, decision } of contexts) {
    if (decision.kind !== "deterministic-merge") continue;
    merges.push({
      from: candidate.name,
      to: decision.target.name,
      similarity: decision.target.similarity,
      evidence: truncateEvidence(decision.target.evidence_quote),
    });
  }

  // 3. Ambiguous batch → ONE bounded json_schema call (with repair retries).
  const candidateNames = new Set(candidates.map((c) => c.name));
  let llmMerges: LinkMerge[] = [];
  let llmEdges: LinkNewEdge[] = [];
  if (input.llm) {
    try {
      const decided = await adjudicateWithLlm({
        llm: input.llm,
        contexts,
        candidateNames,
        existingNames,
        topK,
        maxTokens,
        retries,
      });
      llmMerges = decided.merges;
      llmEdges = decided.new_edges;
    } catch (err) {
      // Degradation: keep the deterministic set, drop the ambiguous calls.
      console.warn(
        `[link] LLM adjudication degraded to deterministic-only: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 4. Combine + truthful standalone recomputation (LLM's standalone list is
  //    advisory only — the engine owns the semantics).
  const allMerges = dedupeMerges([...merges, ...llmMerges]);
  const mergedFroms = new Set(allMerges.map((m) => m.from));
  const standalone = candidates
    .filter((c) => !mergedFroms.has(c.name))
    .map((c) => c.name);

  return {
    merges: allMerges.slice(0, candidates.length),
    new_edges: llmEdges.slice(0, candidates.length * 3),
    standalone,
  };
}

// --- pure transforms shared by both pipelines -----------------------------------

export interface NamedLike {
  name: string;
}

/**
 * Case-insensitive rename resolver from merge decisions: `renameFor(merges)(name)`
 * returns the canonical existing name for a merged candidate, else the input.
 */
export function renameFor(
  merges: LinkMerge[],
): (name: string) => string {
  const map = new Map<string, string>();
  for (const merge of merges) {
    if (!map.has(merge.from.toUpperCase())) {
      map.set(merge.from.toUpperCase(), merge.to);
    }
  }
  return (name: string) => map.get(name.toUpperCase()) ?? name;
}

/**
 * Apply merge decisions to a document-local extraction: merged candidates are
 * renamed onto their canonical existing node (shadowed duplicates removed,
 * aliases unioned into a local twin when present) and relation endpoints are
 * redirected. Pure — used identically by the upload refine pass and the
 * wiki-edit delta-refine before their audit gates.
 */
export function applyMergesToEntities<
  E extends NamedLike & { aliases?: string[] },
  R extends { source: string; target: string },
>(
  entities: E[],
  relations: R[],
  merges: LinkMerge[],
): { entities: E[]; relations: R[] } {
  if (merges.length === 0) return { entities, relations };

  // Case-insensitive rename map (candidate casing may drift from relations).
  const rename = new Map<string, string>();
  for (const merge of merges) {
    if (!rename.has(merge.from.toUpperCase())) {
      rename.set(merge.from.toUpperCase(), merge.to);
    }
  }

  const aliasPatch = new Map<string, Set<string>>();
  const orphanByCanonical = new Map<string, E>();
  const kept: E[] = [];
  for (const entity of entities) {
    const canonical = rename.get(entity.name.toUpperCase());
    if (canonical === undefined) {
      kept.push(entity);
      continue;
    }
    // Remember one shadowed candidate per canonical target: when the batch has
    // NO local twin under the canonical name, this entry is re-added renamed
    // (the document still mentions the thing — it must stay in the extraction).
    if (!orphanByCanonical.has(canonical.toUpperCase())) orphanByCanonical.set(canonical.toUpperCase(), entity);
    const patchKey = canonical.toUpperCase();
    const patch = aliasPatch.get(patchKey) ?? new Set<string>();
    for (const alias of [entity.name, ...(entity.aliases ?? [])]) {
      if (alias && alias.toUpperCase() !== canonical.toUpperCase()) patch.add(alias);
    }
    aliasPatch.set(patchKey, patch);
  }

  const keptCanonicals = new Set<string>();
  for (const entity of kept) {
    const patch = aliasPatch.get(entity.name.toUpperCase());
    if (patch && patch.size > 0) {
      const unioned = [...new Set([...(entity.aliases ?? []), ...patch])].filter(
        (alias) => alias.toUpperCase() !== entity.name.toUpperCase(),
      );
      (entity as { aliases?: string[] }).aliases = unioned;
    }
    keptCanonicals.add(entity.name.toUpperCase());
  }
  // No local twin for a canonical target: resurrect ONE shadowed candidate
  // under the canonical name (the document still mentions the thing).
  for (const [canonicalUpper, patch] of aliasPatch) {
    if (keptCanonicals.has(canonicalUpper)) continue;
    const orphan = orphanByCanonical.get(canonicalUpper);
    if (!orphan) continue;
    kept.push({
      ...orphan,
      name: rename.get(orphan.name.toUpperCase()) ?? orphan.name,
      aliases: [...patch],
    });
    keptCanonicals.add(canonicalUpper);
  }

  const rerouted = relations.map((relation) => ({
    ...relation,
    source: rename.get(relation.source.toUpperCase()) ?? relation.source,
    target: rename.get(relation.target.toUpperCase()) ?? relation.target,
  }));

  return { entities: kept, relations: rerouted };
}
