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

  constructor(options: FeedbackServiceOptions) {
    this.store = options.store;
    this.syncer = options.syncer;
    this.index = options.index;
    this.config = { ...DEFAULT_FEEDBACK_CONFIG, ...options.config };
    this.dedupThreshold = options.dedupThreshold ?? 0.9;
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
}
