/**
 * Per-page wiki review state (G4.S8.T17).
 *
 * The refinement quality gate (G4.S8.T16) persists structured issues in
 * `<refinement dir>/<stem>/quality.json` and stamps `review: required` +
 * `review_count: N` on the wiki page frontmatter. This module is the READ
 * surface (anchors re-validated against the CURRENT page content — issues
 * whose quote no longer matches degrade to unanchored, never dropped) and the
 * WRITE surface for the per-issue user workflow: resolve / reopen flips the
 * issue in quality.json, recomputes review_count, and writes the resulting
 * gate state through the canonical WikiFrontmatterSyncer (wiki md + Neo4j
 * Document mirror).
 */
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { WikiFrontmatterSyncer, type WikiReviewState } from "./wiki-frontmatter.js";

/** One structured review issue as persisted in quality.json. */
export interface WikiReviewIssue {
  id: string;
  message: string;
  anchor?: { quote: string; heading_path?: string };
  resolved: boolean;
  /** Operator note attached when keeping an issue open ("需要修改"). */
  note?: string;
}

/** A review issue plus the server-side anchor validation verdict for THIS fetch. */
export interface ValidatedWikiReviewIssue extends WikiReviewIssue {
  /**
   * true when the anchor quote still matches the current page content.
   * Unanchored issues are surfaced in the banner only (the page was likely
   * edited since the review; anchors re-validate on every fetch).
   */
  anchored: boolean;
}

export interface WikiReviewStateView {
  path: string;
  /** Frontmatter gate state; undefined when the page carries none. */
  review?: WikiReviewState;
  /** Unresolved issue count (frontmatter value, or derived from the issues). */
  review_count: number;
  issues: ValidatedWikiReviewIssue[];
}

function normalizeWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Strip a leading `---` frontmatter block (local copy — keeps this module light). */
function stripFrontmatterBody(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized;
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) return normalized;
  return normalized.slice(end + 5).replace(/^\n/, "");
}

function isReviewState(value: unknown): value is WikiReviewState {
  return value === "required" || value === "clear";
}

/** Server-side anchor re-validation against the current page body. */
export function validateAnchors(
  issues: WikiReviewIssue[],
  body: string,
): ValidatedWikiReviewIssue[] {
  const haystack = normalizeWs(body);
  return issues.map((issue) => ({
    ...issue,
    anchored: Boolean(issue.anchor?.quote) && haystack.includes(normalizeWs(issue.anchor!.quote)),
  }));
}

function isQualityIssue(value: unknown): value is WikiReviewIssue {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.id === "string" && typeof raw.message === "string" && typeof raw.resolved === "boolean";
}

export interface WikiReviewStateServiceOptions {
  /** Read a wiki page's full markdown (frontmatter + body) by project path. */
  readPage: (path: string) => Promise<string>;
  /** Candidate roots holding `<stem>/quality.json` (refinement + code output dirs). */
  refinementRoots?: string[];
  /** Injectable fs read for quality.json (tests). Default: node fs. */
  readFile?: (path: string) => Promise<string>;
  /** Injectable fs write for quality.json (tests). Default: node fs. */
  writeFile?: (path: string, content: string) => Promise<void>;
  /** The canonical frontmatter channel (wiki md + Neo4j Document mirror). */
  syncer: Pick<WikiFrontmatterSyncer, "update">;
}

interface LoadedQuality {
  file: string;
  raw: Record<string, unknown>;
  issues: WikiReviewIssue[];
}

const readFileDefault = async (path: string): Promise<string> => {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
};

const writeFileDefault = async (path: string, content: string): Promise<void> => {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, content, "utf8");
};

export class WikiReviewStateService {
  private readonly readPage: (path: string) => Promise<string>;
  private readonly roots: string[];
  private readonly readFile: (path: string) => Promise<string>;
  private readonly writeFile: (path: string, content: string) => Promise<void>;
  private readonly syncer: Pick<WikiFrontmatterSyncer, "update">;

  constructor(options: WikiReviewStateServiceOptions) {
    this.readPage = options.readPage;
    this.roots = options.refinementRoots ?? [];
    this.readFile = options.readFile ?? readFileDefault;
    this.writeFile = options.writeFile ?? writeFileDefault;
    this.syncer = options.syncer;
  }

  /** Resolve + parse `<root>/<stem>/quality.json`; null when absent everywhere. */
  private async loadQuality(wikiPath: string): Promise<LoadedQuality | null> {
    const stem = wikiPath.split("/").pop()?.replace(/\.md$/i, "") ?? "";
    if (!stem) return null;
    for (const root of this.roots) {
      const file = join(root, stem, "quality.json");
      try {
        const raw = JSON.parse(await this.readFile(file)) as Record<string, unknown>;
        const list = Array.isArray(raw.issues) ? raw.issues : [];
        return { file, raw, issues: list.filter(isQualityIssue) };
      } catch {
        // missing/unreadable in this root — try the next one
      }
    }
    return null;
  }

  /**
   * GET semantics: the page's gate state with anchors validated against the
   * CURRENT content. Pages without any review data get an empty view (no
   * banner, zero overhead).
   */
  async get(path: string): Promise<WikiReviewStateView> {
    const page = await this.readPage(path);
    const fm = parseFrontmatter(page);
    const quality = await this.loadQuality(path);
    const issues = validateAnchors(quality?.issues ?? [], stripFrontmatterBody(page));
    const unresolved = issues.filter((i) => !i.resolved).length;
    const fmCount = Number.parseInt(fm.review_count ?? "", 10);
    return {
      path,
      ...(isReviewState(fm.review) ? { review: fm.review } : {}),
      review_count: Number.isFinite(fmCount) && fmCount > 0 ? fmCount : unresolved,
      issues,
    };
  }

  /**
   * POST /api/kb/wiki/review-state semantics: flip one issue's resolved flag
   * (+ optional operator note), persist quality.json, then write the
   * recomputed gate state through the canonical syncer (review_count
   * decrement; all resolved → review: clear + Neo4j Document mirror).
   */
  async apply(
    path: string,
    issueId: string,
    action: "resolve" | "reopen",
    note?: string,
  ): Promise<WikiReviewStateView> {
    const quality = await this.loadQuality(path);
    if (!quality) {
      throw new Error(`no quality.json found for ${path} — nothing to review`);
    }
    const issue = quality.issues.find((i) => i.id === issueId);
    if (!issue) {
      throw new Error(`unknown issue id: ${issueId}`);
    }
    issue.resolved = action === "resolve";
    if (action === "reopen") {
      const trimmed = note?.trim();
      if (trimmed) issue.note = trimmed;
    }
    await this.writeFile(
      quality.file,
      JSON.stringify({ ...quality.raw, action: issue.resolved ? "auto_accept" : "review_required", issues: quality.issues }, null, 2),
    );
    const reviewCount = quality.issues.filter((i) => !i.resolved).length;
    const review: WikiReviewState = reviewCount > 0 ? "required" : "clear";
    await this.syncer.update(path, { review, review_count: reviewCount });
    const page = await this.readPage(path);
    return {
      path,
      review,
      review_count: reviewCount,
      issues: validateAnchors(quality.issues, stripFrontmatterBody(page)),
    };
  }
}
