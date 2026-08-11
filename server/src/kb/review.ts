/**
 * Athena KB review pass (G4.S3.T2).
 *
 * On a schedule / on demand Athena scans every wiki page's frontmatter
 * (read_count / last_reviewed / confidence / topic_history / updated) and
 * decides a lifecycle action per page:
 *   - re-topic     → update `topic`, append the old topic to `topic_history`,
 *                    bump `last_reviewed`
 *   - re-classify  → update `type`, bump `last_reviewed`
 *   - deprecate    → lower `confidence` (time fade); very stale + rarely read
 *                    pages are flagged for archive
 *   - reinforce    → a fresh confirming source raises `confidence`
 *
 * `read_count` + `last_reviewed` tell Athena what's actually used vs rotting:
 * a page that was never read and has not been updated in months is the prime
 * deprecation candidate.
 *
 * Every applied change goes through the canonical `WikiFrontmatterSyncer.update`
 * (G4.S3.T1) so the wiki md AND the Neo4j Document node stay in sync
 * (write-through).
 *
 * The decision core (`decideReview`) is a pure function of the parsed
 * frontmatter so the lifecycle rules are unit-testable; `KbReviewService`
 * scans the pages, applies decisions via the syncer and reports the result.
 */
import { join } from "node:path";
import type { LlmWikiClient } from "./llmwiki.js";
import { normalizeTopic, isValidTopic } from "./llmwiki.js";
import { DOC_TYPES } from "./taxonomy.js";
import { parseFrontmatter } from "./frontmatter.js";
import { parseWikiLifecycle, WikiFrontmatterSyncer } from "./wiki-frontmatter.js";

/** Tuning knobs for the review rules. */
export interface ReviewConfig {
  /** Fraction of confidence lost per day the page has not been updated. */
  decayPerDay: number;
  /** A page this old (in days) without updates is stale. */
  staleAfterDays: number;
  /** read_count at/above which a stale page counts as "still used". */
  archiveReadThreshold: number;
  /** Confidence at/below which a stale + unused page is flagged for archive. */
  archiveConfidence: number;
  /** Confidence boost applied by a fresh confirming source. */
  reinforceBoost: number;
  /** Confidence is clamped to [minConfidence, maxConfidence]. */
  minConfidence: number;
  maxConfidence: number;
}

export const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  decayPerDay: 0.001,
  staleAfterDays: 180,
  archiveReadThreshold: 3,
  archiveConfidence: 0.3,
  reinforceBoost: 0.15,
  minConfidence: 0,
  maxConfidence: 1,
};

/** The lifecycle action Athena picked for one page. */
export type ReviewAction = "retopic" | "reclassify" | "deprecate" | "reinforce" | "none";

/** What the review decided for a single page. */
export interface ReviewDecision {
  path: string;
  action: ReviewAction;
  /** Resulting confidence after the review pass. */
  confidence: number;
  /** Change applied to confidence (negative = fade, positive = reinforce). */
  confidenceDelta: number;
  /** Date (YYYY-MM-DD) the review ran — bumps last_reviewed when applied. */
  lastReviewed: string;
  /** New topic for a re-topic decision. */
  topic?: string;
  /** Previous topic (migration trail source). */
  topicFrom?: string;
  /** New document type for a re-classify decision. */
  type?: string;
  /** Previous document type. */
  typeFrom?: string;
  /** Set when a rotting page is flagged for archive. */
  archive?: boolean;
  /** Human-readable summary of why. */
  reason: string;
}

export interface ReviewOptions {
  /** Override "today" (YYYY-MM-DD) for deterministic tests. */
  now?: string;
  config?: Partial<ReviewConfig>;
  /** Suggested new topic per page path (re-topic). */
  retopic?: string;
  /** Suggested new document type (re-classify). */
  reclassify?: string;
  /** A fresh confirming source exists for this page (reinforce). */
  reinforce?: boolean;
}

/** Today as YYYY-MM-DD (matching the frontmatter created/updated format). */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Whole days between two YYYY-MM-DD dates (>= 0; unknown/future → 0). */
export function daysBetween(from: string | undefined, to: string): number {
  if (!from) return 0;
  const parse = (value: string): number => {
    const [y, m, d] = value.split("-").map(Number);
    if (!y || !m || !d) return NaN;
    return Date.UTC(y, m - 1, d);
  };
  const a = parse(from);
  const b = parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Normalize a suggested document type to a known DOC_TYPE, else undefined. */
function normalizeType(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase();
  return (DOC_TYPES as readonly string[]).includes(value) ? value : undefined;
}

/**
 * THE deterministic review core: given a parsed frontmatter map, decide the
 * lifecycle action for the page. Pure — no IO — so every rule is unit-testable.
 */
export function decideReview(
  fm: Record<string, string>,
  options: ReviewOptions = {},
): ReviewDecision {
  const now = options.now ?? today();
  const cfg: ReviewConfig = { ...DEFAULT_REVIEW_CONFIG, ...options.config };
  const lifecycle = parseWikiLifecycle(fm);
  const currentTopic = fm.topic?.trim() || undefined;
  const currentType = fm.type?.trim() || undefined;
  const contentAge = daysBetween(fm.updated, now);

  // 1. Base fade: confidence decays with how old the content is.
  let confidence = clamp(
    lifecycle.confidence - contentAge * cfg.decayPerDay,
    cfg.minConfidence,
    cfg.maxConfidence,
  );
  let action: ReviewAction = "none";
  let archive = false;
  const reasons: string[] = [];

  // 2. Re-topic: a valid suggested topic that differs from the current one.
  const newTopic = options.retopic && isValidTopic(options.retopic) ? normalizeTopic(options.retopic) : undefined;
  if (newTopic && newTopic !== currentTopic) {
    action = "retopic";
    reasons.push(`re-topic ${currentTopic ?? "(untagged)"} -> ${newTopic}`);
  }

  // 3. Re-classify: a valid suggested type that differs from the current one.
  const newType = normalizeType(options.reclassify);
  if (action === "none" && newType && newType !== currentType) {
    action = "reclassify";
    reasons.push(`re-classify ${currentType ?? "(untyped)"} -> ${newType}`);
  }

  // 4. Deprecate / fade: very stale + rarely read pages rot. Lower confidence
  //    hard and flag for archive when confidence has all but gone.
  const stale = contentAge >= cfg.staleAfterDays;
  const usedRecently = lifecycle.read_count >= cfg.archiveReadThreshold;
  if (action === "none" && stale && !usedRecently) {
    confidence = clamp(confidence * 0.5, cfg.minConfidence, cfg.maxConfidence);
    archive = confidence <= cfg.archiveConfidence;
    action = "deprecate";
    reasons.push(
      `stale ${contentAge}d, read ${lifecycle.read_count}x -> deprecated${archive ? ", flag for archive" : ""}`,
    );
  }

  // 5. Reinforce: a fresh confirming source raises confidence.
  if (action === "none" && options.reinforce) {
    confidence = clamp(confidence + cfg.reinforceBoost, cfg.minConfidence, cfg.maxConfidence);
    action = "reinforce";
    reasons.push("reinforced by a fresh confirming source");
  }

  // 6. Any residual time-fade is still a (mild) deprecation.
  if (action === "none" && confidence < lifecycle.confidence - 1e-9) {
    action = "deprecate";
    reasons.push(`confidence faded ${lifecycle.confidence} -> ${confidence}`);
  }

  return {
    path: fm._path ?? "",
    action,
    confidence: round3(confidence),
    confidenceDelta: round3(confidence - lifecycle.confidence),
    lastReviewed: now,
    ...(newTopic && newTopic !== currentTopic ? { topic: newTopic, topicFrom: currentTopic } : {}),
    ...(newType && newType !== currentType ? { type: newType, typeFrom: currentType } : {}),
    ...(archive ? { archive: true } : {}),
    reason: reasons.length > 0 ? reasons.join("; ") : "no action needed",
  };
}

export interface ReviewablePage {
  /** Project-relative wiki page path, e.g. wiki/concepts/foo.md. */
  path: string;
  /** Full markdown content of the page (frontmatter + body). */
  content: string;
}

/** Optional LLM hook for per-page re-topic / re-classify suggestions. */
export type ReviewClassifier = (
  page: ReviewablePage,
) => Promise<{ topic?: string; type?: string } | undefined>;

export interface ReviewAllOptions {
  /** Override "today" (YYYY-MM-DD). */
  now?: string;
  /** Do not write anything — only compute + report. */
  dryRun?: boolean;
  /** Suggested new topic per page path (re-topic). */
  retopics?: Record<string, string>;
  /** Suggested new type per page path (re-classify). */
  reclassify?: Record<string, string>;
  /** Pages with a fresh confirming source (reinforce). */
  reinforce?: string[];
  /** LLM hook returning per-page suggestions when the maps don't. */
  classify?: ReviewClassifier;
}

export interface ReviewPageResult {
  path: string;
  action: ReviewAction;
  confidence: number;
  confidenceDelta: number;
  /** Date (YYYY-MM-DD) the review ran (bumps last_reviewed when applied). */
  lastReviewed: string;
  topic?: string;
  topicFrom?: string;
  type?: string;
  typeFrom?: string;
  archive?: boolean;
  reason: string;
}

export interface ReviewReport {
  /** Date (YYYY-MM-DD) the review ran. */
  runAt: string;
  scanned: number;
  changed: number;
  /** Page paths flagged for archive (rotting). */
  archive: string[];
  results: ReviewPageResult[];
}

export interface KbReviewServiceOptions {
  llmwiki: LlmWikiClient;
  /** The canonical frontmatter syncer — every applied change goes through it. */
  syncer: WikiFrontmatterSyncer;
  projectId?: string;
  config?: Partial<ReviewConfig>;
  /** Local wiki pages dir; used only for test overrides of readPage. */
  wikiDir?: string;
  /** Override reading a page file (tests). Default: llmwiki.readFile. */
  readFile?: (localPath: string) => Promise<string>;
}

export class KbReviewService {
  private readonly llmwiki: LlmWikiClient;
  private readonly syncer: WikiFrontmatterSyncer;
  private readonly projectId?: string;
  private readonly config: Partial<ReviewConfig>;
  private readonly wikiDir?: string;
  private readonly readFile?: (localPath: string) => Promise<string>;

  constructor(options: KbReviewServiceOptions) {
    this.llmwiki = options.llmwiki;
    this.syncer = options.syncer;
    this.projectId = options.projectId;
    this.config = options.config ?? {};
    this.wikiDir = options.wikiDir;
    this.readFile = options.readFile;
  }

  /** Resolve the project id (current/first, like KnowledgeRetrievalService). */
  private async resolveProjectId(): Promise<string> {
    const { projects, currentProject } = await this.llmwiki.listProjects();
    const project =
      currentProject ??
      projects.find((p) => p.id === this.projectId) ??
      projects[0];
    if (!project) throw new Error("No llm_wiki project found");
    return this.projectId ?? project.id;
  }

  /** Enumerate all wiki pages of the project. */
  private async listPages(projectId: string): Promise<ReviewablePage[]> {
    const pages = await this.llmwiki.listWikiPages(projectId);
    const out: ReviewablePage[] = [];
    for (const page of pages) {
      if (!page.path.endsWith(".md")) continue;
      let content = "";
      if (this.readFile) {
        if (!this.wikiDir) throw new Error("wiki dir could not be resolved for the KB review");
        const relative = page.path.startsWith("wiki/") ? page.path.slice("wiki/".length) : page.path;
        content = await this.readFile(join(this.wikiDir, relative));
      } else {
        const { content: body } = await this.llmwiki.readFile(projectId, page.path);
        content = body;
      }
      out.push({ path: page.path, content });
    }
    return out;
  }

  /**
   * Run the full KB review pass: scan every wiki page's frontmatter, decide a
   * lifecycle action, and (unless dryRun) apply it through the canonical
   * syncer so the wiki md + Neo4j Document node stay in sync.
   */
  async reviewAll(options: ReviewAllOptions = {}): Promise<ReviewReport> {
    const now = options.now ?? today();
    const projectId = await this.resolveProjectId();
    const pages = await this.listPages(projectId);

    const results: ReviewPageResult[] = [];
    const archive: string[] = [];
    let changed = 0;

    for (const page of pages) {
      const fm = parseFrontmatter(page.content);
      const decision = await this.decideFor(page, fm, now, options);
      if (decision.action === "none") continue;

      if (!options.dryRun) {
        await this.applyDecision(page, decision);
      }
      changed += 1;
      if (decision.archive) archive.push(decision.path);
      results.push(decision);
    }

    return { runAt: now, scanned: pages.length, changed, archive, results };
  }

  /** Decide the action for one page, folding in maps + the LLM classify hook. */
  private async decideFor(
    page: ReviewablePage,
    fm: Record<string, string>,
    now: string,
    options: ReviewAllOptions,
  ): Promise<ReviewPageResult> {
    const path = page.path;
    let retopic = options.retopics?.[path];
    let reclassify = options.reclassify?.[path];
    const reinforce = options.reinforce?.includes(path) === true;

    if ((!retopic && !reclassify) && options.classify) {
      const suggestion = await options.classify(page);
      retopic ??= suggestion?.topic;
      reclassify ??= suggestion?.type;
    }

    const decision = decideReview({ ...fm, _path: path }, {
      now,
      config: this.config,
      retopic,
      reclassify,
      reinforce,
    });

    return {
      path,
      action: decision.action,
      confidence: decision.confidence,
      confidenceDelta: decision.confidenceDelta,
      lastReviewed: decision.lastReviewed,
      ...(decision.topic !== undefined ? { topic: decision.topic, topicFrom: decision.topicFrom } : {}),
      ...(decision.type !== undefined ? { type: decision.type, typeFrom: decision.typeFrom } : {}),
      ...(decision.archive ? { archive: true } : {}),
      reason: decision.reason,
    };
  }

  /** Apply one decision through the canonical syncer (write-through). */
  private async applyDecision(
    page: ReviewablePage,
    decision: ReviewPageResult,
  ): Promise<void> {
    const fm = parseFrontmatter(page.content);
    const lifecycle = parseWikiLifecycle(fm);
    switch (decision.action) {
      case "retopic": {
        // Migration audit trail: append the old topic so re-curation is traceable.
        const currentTopic = fm.topic?.trim() || undefined;
        const history = [...lifecycle.topic_history];
        if (currentTopic && history[history.length - 1] !== currentTopic) {
          history.push(currentTopic);
        }
        await this.syncer.update(page.path, {
          topic: decision.topic,
          topic_history: history,
          last_reviewed: decision.lastReviewed,
        });
        return;
      }
      case "reclassify":
        await this.syncer.update(page.path, {
          type: decision.type,
          last_reviewed: decision.lastReviewed,
        });
        return;
      case "deprecate":
      case "reinforce":
        await this.syncer.update(page.path, {
          confidence: decision.confidence,
          last_reviewed: decision.lastReviewed,
        });
        return;
      default:
        return;
    }
  }
}

/** A handle to stop a scheduled review. */
export interface ScheduledKbReview {
  stop: () => void;
}

/** Trigger the KB review pass on a fixed interval (scheduled). */
export function scheduleKbReview(
  service: KbReviewService,
  intervalMs: number,
  options: ReviewAllOptions = {},
): ScheduledKbReview {
  let timer: NodeJS.Timeout | undefined;
  const run = async (): Promise<void> => {
    try {
      await service.reviewAll(options);
    } catch {
      // a scheduled review must never crash the server.
    }
  };
  timer = setInterval(run, intervalMs);
  return {
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}
