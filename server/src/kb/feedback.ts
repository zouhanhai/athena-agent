/**
 * Feedback loop service (G4.S3.T5).
 *
 * A chat answer's thumbs up/down feeds the KB lifecycle:
 *   - the Q&A pair `{question, answer, sources, feedback}` is stored in the
 *     `QaPairStore` (reusable — no re-RAG for the same question), deduped by
 *     vector similarity (a semantically similar question updates the existing
 *     pair instead of inserting a duplicate);
 *   - upvote = reinforce → the source wiki pages' `confidence` RISES,
 *   - downvote = fade → their `confidence` FALLS.
 *
 * Every confidence change goes through the canonical `WikiFrontmatterSyncer`
 * (G4.S3.T1) so the wiki md AND the Neo4j Document node stay in sync
 * (write-through). The direction-change guard keeps a repeat of the same
 * direction from double-adjusting confidence.
 */
import type { QaEmbeddingIndex } from "./qa-index.js";
import type {
  FeedbackDirection,
  QaPair,
  QaPairStore,
  QaSource,
} from "./qa-pairs.js";
import type { WikiFrontmatterSyncer } from "./wiki-frontmatter.js";

/** Manual Q&A entry (G4.S3.T6): typed straight into the Terms & QA tab. */
export interface ManualQaInput {
  question: string;
  answer: string;
  sources?: QaSource[];
}

/** How the user resolves a manual entry that vector-matches an existing pair. */
export type ManualQaMode = "merge" | "overwrite" | "add-anyway";

export interface ManualAddResult {
  pair: QaPair | null;
  /** The vector-matched existing pair, when one exists at/above the threshold. */
  similar?: { id: string; question: string; score: number };
  /** How the manual entry landed. `needs_decision` = a similar pair exists and
   *  no mode was chosen → the front-end shows a merge/overwrite/add-anyway dialog. */
  action: "inserted" | "merged" | "overwritten" | "added_anyway" | "needs_decision";
}

/** A QA pair surfaced to search as reference context (G4.S3.T6) — reference
 *  only, never a short-circuit answer. */
export interface QaReference {
  id: string;
  question: string;
  answer: string;
  score: number;
}

/** Tuning knobs for the feedback confidence rule. */
export interface FeedbackConfig {
  /** Upvote (reinforce) raises confidence by this. */
  reinforceBoost: number;
  /** Downvote (fade) lowers confidence by this. */
  fadePenalty: number;
  /** Confidence is clamped to [minConfidence, maxConfidence]. */
  minConfidence: number;
  maxConfidence: number;
}

export const DEFAULT_FEEDBACK_CONFIG: FeedbackConfig = {
  // Matches the KB review reinforce boost (DEFAULT_REVIEW_CONFIG.reinforceBoost).
  reinforceBoost: 0.15,
  fadePenalty: 0.15,
  minConfidence: 0,
  maxConfidence: 1,
};

export interface FeedbackInput {
  question: string;
  answer: string;
  sources?: QaSource[];
  feedback: FeedbackDirection;
}

export interface ConfidenceUpdate {
  /** Wiki page path the confidence changed on. */
  path: string;
  feedback: FeedbackDirection;
  /** Confidence before the feedback. */
  from: number;
  /** Confidence after the feedback. */
  to: number;
}

export interface FeedbackResult {
  /** The stored Q&A pair (a similar question updates the existing pair). */
  pair: QaPair;
  /** True when the question matched an existing pair by vector similarity. */
  deduped: boolean;
  /** The matched existing question, when deduped. */
  matchedQuestion?: string;
  /** Confidence changes applied to the source wiki pages. */
  confidenceUpdates: ConfidenceUpdate[];
}

export interface FeedbackServiceOptions {
  store: QaPairStore;
  syncer: WikiFrontmatterSyncer;
  /** Optional Q&A vector index (G4.S3.T5 dedup). When absent, insert-only. */
  index?: QaEmbeddingIndex;
  config?: Partial<FeedbackConfig>;
  /** Cosine similarity at/above which a stored question counts as a duplicate.
   *  Default: 0.9. */
  dedupThreshold?: number;
  /** Cosine similarity at/above which a stored question is surfaced to search
   *  as reference context (G4.S3.T6). Default: 0.85. */
  referenceThreshold?: number;
}

/** The pure confidence rule: upvote adds reinforceBoost, downvote subtracts
 *  fadePenalty, clamped to [minConfidence, maxConfidence]. */
export function adjustConfidence(
  current: number,
  feedback: FeedbackDirection,
  config: FeedbackConfig,
): number {
  const delta = feedback === "up" ? config.reinforceBoost : -config.fadePenalty;
  return Math.min(config.maxConfidence, Math.max(config.minConfidence, current + delta));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export class FeedbackService {
  private readonly store: QaPairStore;
  private readonly syncer: WikiFrontmatterSyncer;
  private readonly index?: QaEmbeddingIndex;
  private readonly config: FeedbackConfig;
  private readonly dedupThreshold: number;
  private readonly referenceThreshold: number;

  constructor(options: FeedbackServiceOptions) {
    this.store = options.store;
    this.syncer = options.syncer;
    this.index = options.index;
    this.config = { ...DEFAULT_FEEDBACK_CONFIG, ...options.config };
    this.dedupThreshold = options.dedupThreshold ?? 0.9;
    this.referenceThreshold = options.referenceThreshold ?? 0.85;
  }

  /** The Q&A table backing this service (exposed for listing, e.g. GET /api/kb/qa). */
  get qaStore(): QaPairStore {
    return this.store;
  }

  /** Release the underlying Q&A store (e.g. its Postgres pool) on shutdown. */
  async close(): Promise<void> {
    await this.store.close();
  }

  /**
   * Record a feedback event: (a) store the Q&A pair — deduping by vector
   * similarity so a semantically similar question updates the existing pair —
   * then (b) reinforce/fade the confidence of every source wiki page through
   * the canonical syncer. Confidence is only adjusted when the feedback
   * direction actually changed (or the pair is new) so a repeated direction
   * never double-applies.
   */
  async record(input: FeedbackInput): Promise<FeedbackResult> {
    const question = input.question.trim();
    const existing = this.index
      ? await this.index.findSimilar(question, this.dedupThreshold)
      : null;

    // The pair this feedback lands on (vector match, else exact question text),
    // so a repeat of the same direction is never double-applied.
    const previousByQuestion = await this.store.findByQuestion(question);
    const previous = existing
      ? (await this.store.getById(existing.id)) ?? previousByQuestion
      : previousByQuestion;
    const previousFeedback = previous?.feedback ?? null;

    const pair = existing
      ? await this.store.merge(existing.id, { ...input, question })
      : await this.store.upsert({ ...input, question });

    if (this.index) {
      // keep the dedup index fresh for both the merged and the new pair.
      await this.index.upsert(pair.id, pair.question);
    }

    const confidenceUpdates: ConfidenceUpdate[] = [];
    if (previousFeedback !== input.feedback) {
      for (const source of input.sources ?? []) {
        const path = source.path ?? source.wikiPath;
        if (!path || !path.startsWith("wiki/")) continue;
        try {
          confidenceUpdates.push(await this.applyConfidence(path, input.feedback));
        } catch {
          // best-effort — a missing page or a failing store never fails feedback.
        }
      }
    }

    return {
      pair,
      deduped: existing !== null,
      ...(existing ? { matchedQuestion: existing.question } : {}),
      confidenceUpdates,
    };
  }

  /** Adjust one source wiki page's confidence via the canonical syncer (wiki md
   *  + Neo4j Document mirror write-through). */
  async applyConfidence(path: string, feedback: FeedbackDirection): Promise<ConfidenceUpdate> {
    const state = await this.syncer.readLifecycle(path);
    const to = round3(adjustConfidence(state.confidence, feedback, this.config));
    await this.syncer.update(path, { confidence: to });
    return { path, feedback, from: state.confidence, to };
  }

  /**
   * Manual Q&A entry (G4.S3.T6): type a Q&A pair straight into the Terms & QA
   *  tab. Reuses the T5 vector-dedup (`QaEmbeddingIndex`): the existing
   *  questions are vector-searched first; when a similar one exists the caller
   *  chooses how to resolve it — `merge` (append the answer), `overwrite`
   *  (replace the answer) or `add-anyway` (insert a new row). Without a mode a
   *  similar match returns `needs_decision` and nothing is written.
   */
  async manualAdd(input: ManualQaInput, mode?: ManualQaMode): Promise<ManualAddResult> {
    const question = input.question.trim();
    const similar = this.index
      ? await this.index.findSimilar(question, this.dedupThreshold)
      : null;

    if (similar) {
      if (!mode) {
        return {
          pair: null,
          similar: { id: similar.id, question: similar.question, score: similar.score },
          action: "needs_decision",
        };
      }
      const upsertInput = {
        question,
        answer: input.answer,
        sources: input.sources ?? [],
        feedback: null,
      };
      let pair: QaPair;
      if (mode === "merge") {
        pair = await this.store.merge(similar.id, upsertInput);
      } else if (mode === "overwrite") {
        pair = await this.store.overwrite(similar.id, upsertInput);
      } else {
        pair = await this.store.upsert(upsertInput);
      }
      await this.index?.upsert(pair.id, pair.question);
      return {
        pair,
        similar: { id: similar.id, question: similar.question, score: similar.score },
        action: mode === "merge" ? "merged" : mode === "overwrite" ? "overwritten" : "added_anyway",
      };
    }

    const pair = await this.store.upsert({
      question,
      answer: input.answer,
      sources: input.sources ?? [],
      feedback: null,
    });
    await this.index?.upsert(pair.id, pair.question);
    return { pair, action: "inserted" };
  }

  /** Delete a Q&A pair (manual cleanup in the Terms & QA tab). Also drops its
   *  embedding so the vector index stays deduped. */
  async deletePair(id: string): Promise<boolean> {
    const removed = await this.store.remove(id);
    if (removed) {
      await this.index?.remove(id);
    }
    return removed;
  }

  /**
   * QA lookup as REFERENCE for the search path (G4.S3.T6): vector-search the
   *  stored questions for one similar to the query. A match is returned as
   *  reference context only — the RAG search still always runs and the LLM
   *  grounds on the fresh retrieval + this reference (never a short-circuit).
   */
  async findReference(question: string): Promise<QaReference | null> {
    if (!this.index) return null;
    const similar = await this.index.findSimilar(question, this.referenceThreshold);
    if (!similar) return null;
    const pair = await this.store.getById(similar.id);
    if (!pair) return null;
    return {
      id: pair.id,
      question: pair.question,
      answer: pair.answer,
      score: similar.score,
    };
  }
}
