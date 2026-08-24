/**
 * G4.S10.T3 — the weekly FULL-GRAPH re-link pass (T15 flow stage).
 *
 * Layered pipeline over the WHOLE entity graph:
 *   ① deterministic pre-scan (NO LLM) → near-duplicate candidate pairs
 *     (`scanRelinkCandidates`: embedding cosine ≥0.85 top-k, alias/name
 *     variants, case-fold/type-conflict collisions);
 *   ② candidate adjudication through the T1 LINK ENGINE ONLY — `linkCandidates`
 *     is injected (`linkEngine`, default = the real function) exactly like the
 *     ingest/wiki-edit pipelines do, so the SAME classification thresholds,
 *     json_schema adjudication, retry/repair/degrade, endpoint validation and
 *     atomic-write rules apply. No second implementation exists;
 *   ③ an INCREMENTAL sweep feeds additionally-changed-provenance entities
 *     (Document.ingested_at watermark) plus low-degree entities through the
 *     SAME engine via the multi-lane `ExistingGraphApi` — the weekly pass
 *     covers both the full and the incremental sweeps;
 *   ④ decisions apply under the graph write lock with truthful counts and the
 *     report lands in the auditRunsStore: {trigger:"weekly", merges,
 *     unmergedCandidates (with similarity), newEdges, candidateCount,
 *     llmCalls}.
 *
 * Cost stays bounded: LLM work happens ONLY on candidate pairs (one bounded
 * json_schema call per batch, repair retries included in `llmCalls`); every
 * non-candidate entity costs embeddings at most.
 */
import {
  linkCandidates,
  renameFor,
  type ExistingEntityMatch,
  type ExistingGraphApi,
  type LinkCandidate,
  type LinkDecisions,
  type LinkLlmCaller,
  type LinkMerge,
  type LinkNewEdge,
} from "../link/link-engine.js";
import type { TextEmbedder } from "../embedding.js";
import {
  RELINK_MAX_PAIRS,
  RELINK_SIMILARITY_THRESHOLD,
  RELINK_TOP_K,
  scanRelinkCandidates,
  type RelinkCandidatePair,
  type RelinkEntitySnapshot,
} from "./relink-scan.js";

/** Candidates fed to the link engine per invocation (one LLM call per batch). */
export const RELINK_BATCH_SIZE = 40;
/** Entities with ≤ this many relations join the incremental low-degree sweep. */
export const RELINK_LOW_DEGREE_MAX = 1;
/** Sample cap per report list (summary + drill-in, never pages of rows). */
export const RELINK_REPORT_SAMPLE_LIMIT = 50;

/**
 * Reuse seam (ticket acceptance): the weekly pass MUST go through the T1
 * engine. Default is the real `linkCandidates`; tests inject spies around it
 * to prove routing. No second implementation is written or allowed.
 */
export const DEFAULT_LINK_ENGINE: typeof linkCandidates = linkCandidates;

export type RelinkLinkEngine = typeof linkCandidates;

export interface KbRelinkAppliedMerge {
  from: string;
  to: string;
  similarity: number;
  evidence: string;
}

export interface KbRelinkUnmergedPair {
  a: string;
  b: string;
  similarity: number;
  reasons: string[];
}

/** The persisted weekly re-link report block (inside a KbAuditRunRecord). */
export interface KbRelinkReport {
  /** Identifies THIS flow regardless of what triggered the audit run. */
  trigger: "weekly";
  scannedEntities: number;
  /** Candidate pairs produced by the deterministic pre-scan (+incremental feeds). */
  candidateCount: number;
  /** LLM adjudication calls actually made (repairs included) — cost observability. */
  llmCalls: number;
  mergesApplied: number;
  unmergedCount: number;
  newEdgesCreated: number;
  /** Entities additionally covered by the incremental (changed/low-degree) sweep. */
  incrementalEntities: number;
  /** Applied merges (capped sample). */
  merges: KbRelinkAppliedMerge[];
  /** Candidate pairs left unlinked, with similarity (capped sample). */
  unmergedCandidates: KbRelinkUnmergedPair[];
  /** Created cross-document edges (capped sample). */
  newEdges: LinkNewEdge[];
  errors: string[];
}

/** Graph surface the weekly pass needs (`Neo4jRelinkGraphPort` satisfies it). */
export interface RelinkGraphPort {
  listEntities(): Promise<RelinkEntitySnapshot[]>;
  entitiesChangedSince(sinceIso: string): Promise<string[]>;
  applyMerges(merges: LinkMerge[]): Promise<number>;
  createEdges(edges: LinkNewEdge[]): Promise<number>;
}

export class KbRelinkAlreadyRunningError extends Error {
  constructor() {
    super("a knowledge-base re-link is already running");
    this.name = "KbRelinkAlreadyRunningError";
  }
}

export interface KbRelinkServiceOptions {
  graph: RelinkGraphPort;
  /** Optional: enables the pre-scan vector lane. Absent = name/alias lanes. */
  embedder?: TextEmbedder;
  /** Optional adjudicator handed to the T1 engine (omit = deterministic-only). */
  llm?: LinkLlmCaller;
  /**
   * G4.S10.T3 REUSE SEAM — the LINK engine the pass routes every candidate
   * through. Default: the real T1 `linkCandidates`.
   */
  linkEngine?: RelinkLinkEngine;
  /** Multi-lane matcher for the incremental sweep (real Neo4jExistingGraphApi). */
  existingGraphApi?: ExistingGraphApi;
  batchSize?: number;
  lowDegreeMax?: number;
  scanThreshold?: number;
  topK?: number;
  maxPairs?: number;
  reportSampleLimit?: number;
}

interface PairFeed {
  pair: RelinkCandidatePair;
  /** Candidate-side snapshot (lower degree of the two; deterministic tie-break). */
  candidate: RelinkEntitySnapshot;
  match: ExistingEntityMatch;
}

export class KbRelinkService {
  private readonly graph: RelinkGraphPort;
  private readonly embedder?: TextEmbedder;
  private readonly llm?: LinkLlmCaller;
  private readonly linkEngine: RelinkLinkEngine;
  private readonly existingGraphApi?: ExistingGraphApi;
  private readonly batchSize: number;
  private readonly lowDegreeMax: number;
  private readonly scanThreshold: number;
  private readonly topK: number;
  private readonly maxPairs: number;
  private readonly sampleLimit: number;
  private running = false;

  constructor(options: KbRelinkServiceOptions) {
    this.graph = options.graph;
    this.embedder = options.embedder;
    this.llm = options.llm;
    this.linkEngine = options.linkEngine ?? DEFAULT_LINK_ENGINE;
    this.existingGraphApi = options.existingGraphApi;
    this.batchSize = options.batchSize ?? RELINK_BATCH_SIZE;
    this.lowDegreeMax = options.lowDegreeMax ?? RELINK_LOW_DEGREE_MAX;
    this.scanThreshold = options.scanThreshold ?? RELINK_SIMILARITY_THRESHOLD;
    this.topK = options.topK ?? RELINK_TOP_K;
    this.maxPairs = options.maxPairs ?? RELINK_MAX_PAIRS;
    this.sampleLimit = options.reportSampleLimit ?? RELINK_REPORT_SAMPLE_LIMIT;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Run one full weekly re-link pass. Never throws for per-stage failures —
   *  they land in `report.errors`. */
  async run(input: { sinceIso?: string } = {}): Promise<KbRelinkReport> {
    if (this.running) throw new KbRelinkAlreadyRunningError();
    this.running = true;
    const errors: string[] = [];
    try {
      const entities = await this.graph.listEntities();
      const pairs = await scanRelinkCandidates(entities, {
        threshold: this.scanThreshold,
        topK: this.topK,
        maxPairs: this.maxPairs,
        ...(this.embedder ? { embedder: this.embedder } : {}),
      });

      // Deterministic orientation: the LOWER-degree side plays the candidate
      // (late-arriving duplicates have fewer relations), ties break on nameUpper.
      const entitiesByNameUpper = new Map(
        entities.map((entity) => [entity.nameUpper.toUpperCase(), entity]),
      );
      const feeds: PairFeed[] = [];
      for (const pair of pairs) {
        const a = entitiesByNameUpper.get(pair.a.toUpperCase());
        const b = entitiesByNameUpper.get(pair.b.toUpperCase());
        if (!a || !b) continue;
        const candidateIsA =
          (a.degree ?? 0) < (b.degree ?? 0) ||
          ((a.degree ?? 0) === (b.degree ?? 0) &&
            a.nameUpper.toUpperCase() > b.nameUpper.toUpperCase());
        const candidate = candidateIsA ? a : b;
        const counterpart = candidateIsA ? b : a;
        feeds.push({
          pair,
          candidate,
          match: {
            name: counterpart.name,
            ...(counterpart.type ? { type: counterpart.type } : {}),
            similarity: pair.similarity,
            evidence_quote: (counterpart.description ?? counterpart.name)
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 80),
            source: pair.reasons.includes("vector") ? "vector" : "alias",
          },
        });
      }

      let llmCalls = 0;
      // Cost observability WITHOUT touching the T1 engine: count every LLM
      // invocation the pass makes (initial + repair retries alike).
      const countingLlm: LinkLlmCaller | undefined = this.llm
        ? async (params) => {
            llmCalls += 1;
            return this.llm!(params);
          }
        : undefined;

      // ② Full-sweep adjudication — pre-ranked matches ride a synthetic
      // ExistingGraphApi so the T1 engine classifies/adjudicates EXACTLY as it
      // does at ingest time (deterministic tiers + one json_schema call/batch).
      const matchesByCandidate = new Map<string, ExistingEntityMatch[]>();
      for (const feed of feeds) {
        const list =
          matchesByCandidate.get(feed.candidate.name.toUpperCase()) ?? [];
        list.push(feed.match);
        matchesByCandidate.set(feed.candidate.name.toUpperCase(), list);
      }
      const prescanApi: ExistingGraphApi = {
        findMatches: async (candidate: LinkCandidate, limit: number) =>
          (matchesByCandidate.get(candidate.name.toUpperCase()) ?? []).slice(0, limit),
      };

      const fullCandidates: LinkCandidate[] = feeds.map((feed) =>
        this.candidateOf(feed.candidate),
      );
      const decisionsList: LinkDecisions[] = [];
      for (let start = 0; start < fullCandidates.length; start += this.batchSize) {
        const slice = fullCandidates.slice(start, start + this.batchSize);
        try {
          decisionsList.push(await this.invokeEngine(slice, prescanApi, countingLlm));
        } catch (err) {
          errors.push(`full-sweep batch failed: ${messageOf(err)}`);
        }
      }

      // ③ Incremental sweep — entities whose source_docs changed since the last
      // audit plus low-degree stragglers, matched through the REAL multi-lane
      // matcher and decided by the SAME engine.
      const fedUppers = new Set(fullCandidates.map((c) => c.name.toUpperCase()));
      const incrementalNames: string[] = [];
      if (this.existingGraphApi) {
        const changed = input.sinceIso
          ? await this.safeChangedSince(input.sinceIso, errors)
          : [];
        const lowDegree = entities
          .filter((entity) => (entity.degree ?? 0) <= this.lowDegreeMax)
          .map((entity) => entity.name);
        const selfApi: ExistingGraphApi = {
          findMatches: async (candidate: LinkCandidate, limit: number) => {
            const matches = await this.existingGraphApi!.findMatches(candidate, limit + 1);
            return matches
              .filter((match) => match.name.toUpperCase() !== candidate.name.toUpperCase())
              .slice(0, limit);
          },
        };
        for (const name of [...changed, ...lowDegree]) {
          if (!name || fedUppers.has(name.toUpperCase())) continue;
          fedUppers.add(name.toUpperCase());
          incrementalNames.push(name);
        }
        for (let start = 0; start < incrementalNames.length; start += this.batchSize) {
          const slice = incrementalNames
            .slice(start, start + this.batchSize)
            .map((name) =>
              this.candidateOf(
                entitiesByNameUpper.get(name.toUpperCase()) ?? {
                  name,
                  nameUpper: name.toUpperCase(),
                },
              ),
            );
          try {
            decisionsList.push(await this.invokeEngine(slice, selfApi, countingLlm));
          } catch (err) {
            errors.push(`incremental batch failed: ${messageOf(err)}`);
          }
        }
      }

      // Collect decisions across all batches.
      const allMerges: LinkMerge[] = [];
      const allEdges: LinkNewEdge[] = [];
      for (const decisions of decisionsList) {
        allMerges.push(...decisions.merges);
        allEdges.push(...decisions.new_edges);
      }
      const mergedKeys = new Set(
        allMerges.map((merge) => unorderedKey(merge.from, merge.to)),
      );

      // ④ Apply with the SAME lock/validation rules; counts read back truthfully.
      let mergesApplied = 0;
      let newEdgesCreated = 0;
      try {
        mergesApplied = await this.graph.applyMerges(allMerges);
      } catch (err) {
        errors.push(`merge application failed: ${messageOf(err)}`);
      }
      // Edges referencing a merged-away node retarget onto the survivor.
      const rename = renameFor(allMerges);
      const retargeted: LinkNewEdge[] = allEdges.map((edge) => ({
        ...edge,
        source: rename(edge.source),
        target: rename(edge.target),
      }));
      try {
        newEdgesCreated = await this.graph.createEdges(retargeted);
      } catch (err) {
        errors.push(`edge creation failed: ${messageOf(err)}`);
      }

      const unmergedCandidates = pairs
        .filter((pair) => !mergedKeys.has(unorderedKey(pair.a, pair.b)))
        .map((pair) => ({
          a: pair.a,
          b: pair.b,
          similarity: pair.similarity,
          reasons: [...pair.reasons],
        }));

      return {
        trigger: "weekly",
        scannedEntities: entities.length,
        candidateCount: pairs.length + incrementalNames.length,
        llmCalls,
        mergesApplied,
        unmergedCount: unmergedCandidates.length,
        newEdgesCreated,
        incrementalEntities: incrementalNames.length,
        merges: allMerges.slice(0, this.sampleLimit).map((merge) => ({
          from: merge.from,
          to: merge.to,
          similarity: merge.similarity,
          evidence: merge.evidence,
        })),
        unmergedCandidates: unmergedCandidates.slice(0, this.sampleLimit),
        newEdges: retargeted.slice(0, this.sampleLimit),
        errors,
      };
    } finally {
      this.running = false;
    }
  }

  private async invokeEngine(
    candidates: LinkCandidate[],
    api: ExistingGraphApi,
    llm: LinkLlmCaller | undefined,
  ): Promise<LinkDecisions> {
    if (candidates.length === 0) {
      return { merges: [], new_edges: [], standalone: [] };
    }
    return this.linkEngine({
      candidates,
      existingGraphApi: api,
      ...(llm ? { llm } : {}),
    });
  }

  private candidateOf(entity: RelinkEntitySnapshot): LinkCandidate {
    return {
      name: entity.name,
      ...(entity.type ? { type: entity.type } : {}),
      ...(entity.description ? { description: entity.description } : {}),
      ...(entity.aliases && entity.aliases.length > 0 ? { aliases: entity.aliases } : {}),
    };
  }

  private async safeChangedSince(
    sinceIso: string,
    errors: string[],
  ): Promise<string[]> {
    try {
      return await this.graph.entitiesChangedSince(sinceIso);
    } catch (err) {
      errors.push(`incremental provenance read failed: ${messageOf(err)}`);
      return [];
    }
  }
}

function unorderedKey(a: string, b: string): string {
  const [x, y] = [a.toUpperCase(), b.toUpperCase()].sort();
  return `${x}\u0000${y}`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
