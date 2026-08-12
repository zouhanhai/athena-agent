/**
 * Canonical wiki frontmatter update (G4.S3.T1).
 *
 * ONE function keeps the wiki md frontmatter and the Neo4j Document node in
 * sync (write-through). Every future frontmatter change — KB review (T2),
 * re-curation (T3), feedback (T5), read_count increments (T1), manual wiki
 * edits — MUST go through `WikiFrontmatterSyncer.update` so wiki + RAG never
 * drift.
 *
 * The wiki md file is the source of truth: `update` patches its `---` block
 * (upserting the lifecycle fields + bumping `updated`), writes the page back
 * to disk, then mirrors the resulting lifecycle fields (read_count /
 * last_reviewed / confidence / topic_history) onto the linked Neo4j Document
 * node (Document -[:IS_DOCUMENT]-> WikiPage, matched by the wiki page path).
 * The Document mirror is best-effort — a failing store never fails the wiki
 * write.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import {
  DOCUMENT_LABEL,
  IS_DOCUMENT_TYPE,
  WIKIPAGE_LABEL,
  type Neo4jDriverLike,
} from "./store/schema.js";

/** The subset of wiki frontmatter a single canonical update may change. */
export interface WikiFrontmatterPatch {
  /** Times Athena/retrieval read this page. */
  read_count?: number;
  /** ISO date of the last Athena KB review. */
  last_reviewed?: string;
  /** Freshness confidence in 0..1 (decays over time). */
  confidence?: number;
  /** Ordered list of past topics (migration audit trail). */
  topic_history?: string[];
  /** Re-topic: the current topic key (G4.S3.T2/T3). */
  topic?: string;
  /** Re-classify: the document type (one of DOC_TYPES, G4.S3.T2). */
  type?: string;
}

/** The full lifecycle state carried by a wiki page (mirrored on the Document node). */
export interface WikiLifecycleState {
  read_count: number;
  last_reviewed?: string;
  confidence: number;
  topic_history: string[];
}

export interface WikiFrontmatterSyncerOptions {
  /** Local wiki pages dir (project.path/wiki). Resolved lazily via resolveWikiDir when absent. */
  wikiDir?: string;
  resolveWikiDir?: () => Promise<string>;
  /** Read a page file by absolute local path (tests). Default: node fs readFile. */
  readFile?: (path: string) => Promise<string>;
  /** Write a page file by absolute local path (tests). Default: node fs writeFile. */
  writeFile?: (path: string, content: string) => Promise<void>;
  /** Neo4j driver for the write-through Document mirror. Skipped when absent. */
  driver?: Neo4jDriverLike;
}

/** Map a project-relative wiki page path to its local path under the wiki dir.
 *  Traversal paths are rejected so the syncer can never write outside the wiki. */
export function wikiLocalPath(wikiDir: string, path: string): string {
  const relative = path.startsWith("wiki/") ? path.slice("wiki/".length) : path;
  if (relative.includes("..") || relative.includes("\\") || relative.startsWith("/")) {
    throw new Error(`invalid wiki path: ${path}`);
  }
  return join(wikiDir, relative);
}

/** Serialize a topic list as an inline YAML array (single-line, best-effort parseable). */
function serializeTopicHistory(topics: string[]): string {
  return `[${topics.map((t) => `"${t}"`).join(", ")}]`;
}

/** Parse a topic_history frontmatter value ('["a", "b"]' or 'a, b') into a list. */
export function parseTopicHistory(raw: string | undefined): string[] {
  if (!raw) return [];
  const inner = raw
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .trim();
  if (!inner) return [];
  return inner
    .split(",")
    .map((t) => t.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/** Read the lifecycle fields from a parsed frontmatter map, with safe defaults. */
export function parseWikiLifecycle(fm: Record<string, string>): WikiLifecycleState {
  const readCount = Number.parseInt(fm.read_count ?? "", 10);
  const confidence = Number.parseFloat(fm.confidence ?? "");
  return {
    read_count: Number.isFinite(readCount) ? readCount : 0,
    ...(fm.last_reviewed ? { last_reviewed: fm.last_reviewed } : {}),
    confidence: Number.isFinite(confidence) ? confidence : 1,
    topic_history: parseTopicHistory(fm.topic_history),
  };
}

/** Today as an ISO date (YYYY-MM-DD), matching the existing created/updated format. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Split a wiki page into its frontmatter lines and the body markdown. */
function splitFrontmatter(content: string): { lines: string[]; body: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { lines: [], body: normalized };
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) return { lines: [], body: normalized };
  return {
    lines: normalized.slice(4, end).split("\n"),
    body: normalized.slice(end + 5).replace(/^\n/, ""),
  };
}

/** Parse frontmatter lines into ordered [key, value] pairs (best-effort). */
function parseLines(lines: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) out.push([key, value]);
  }
  return out;
}

/** Re-render ordered frontmatter pairs + the (untouched) body as a full page. */
function renderFrontmatter(pairs: Array<[string, string]>, body: string): string {
  const inner = pairs.map(([k, v]) => `${k}: ${v}`).join("\n");
  return `---\n${inner}\n---\n\n${body}`;
}

/** Patch a wiki page's frontmatter: upsert lifecycle fields, bump `updated`,
 *  preserve every other field and the body verbatim. */
export function patchFrontmatter(content: string, patch: WikiFrontmatterPatch): string {
  const { lines, body } = splitFrontmatter(content);
  const pairs = parseLines(lines);

  const upsert = (key: string, value: string | undefined): void => {
    if (value === undefined) return;
    const idx = pairs.findIndex(([k]) => k === key);
    if (idx === -1) pairs.push([key, value]);
    else pairs[idx] = [key, value];
  };

  if (patch.read_count !== undefined) upsert("read_count", String(patch.read_count));
  if (patch.last_reviewed !== undefined) upsert("last_reviewed", patch.last_reviewed);
  if (patch.confidence !== undefined) upsert("confidence", String(patch.confidence));
  if (patch.topic_history !== undefined) upsert("topic_history", serializeTopicHistory(patch.topic_history));
  if (patch.topic !== undefined) upsert("topic", patch.topic);
  if (patch.type !== undefined) upsert("type", patch.type);
  upsert("updated", today());

  return renderFrontmatter(pairs, body);
}

/**
 * The single canonical frontmatter-update function. Every frontmatter change
 * (KB review T2, re-curation T3, feedback T5, read_count increments T1, manual
 * edits) must go through this class so the wiki md and the Neo4j Document node
 * stay in sync.
 */
export class WikiFrontmatterSyncer {
  private readonly wikiDir?: string;
  private readonly resolveWikiDir?: () => Promise<string>;
  private readonly readFile: (path: string) => Promise<string>;
  private readonly writeFile: (path: string, content: string) => Promise<void>;
  private readonly driver?: Neo4jDriverLike;

  constructor(options: WikiFrontmatterSyncerOptions) {
    this.wikiDir = options.wikiDir;
    this.resolveWikiDir = options.resolveWikiDir;
    this.readFile = options.readFile ?? ((path) => readFile(path, "utf8"));
    this.writeFile = options.writeFile ?? writeFile;
    this.driver = options.driver;
  }

  /** Resolve the on-disk wiki dir (fixed or lazily from the project). */
  private async wikiRoot(): Promise<string> {
    const root = this.wikiDir ?? (await this.resolveWikiDir?.());
    if (!root) throw new Error("wiki dir could not be resolved");
    return root;
  }

  /**
   * THE canonical frontmatter update: (a) patch the page's frontmatter on disk
   * (upsert lifecycle fields + bump `updated`), (b) write the page back, then
   * (c) write the resulting lifecycle fields through to the linked Neo4j
   * Document node. Returns the resulting lifecycle state.
   */
  async update(path: string, patch: WikiFrontmatterPatch): Promise<WikiLifecycleState> {
    const wikiDir = await this.wikiRoot();
    const local = wikiLocalPath(wikiDir, path);
    const content = await this.readFile(local);
    const next = patchFrontmatter(content, patch);
    await this.writeFile(local, next);
    const state = parseWikiLifecycle(parseFrontmatter(next));
    await this.mirrorDocument(path, state);
    return state;
  }

  /** Read the current lifecycle state of a wiki page from its frontmatter.
   *  Resolves the page's local path like update() — feedback (G4.S3.T5) and
   *  any other caller read the current confidence through this canonical path
   *  before writing a delta back through update(). */
  async readLifecycle(path: string): Promise<WikiLifecycleState> {
    const wikiDir = await this.wikiRoot();
    const local = wikiLocalPath(wikiDir, path);
    const content = await this.readFile(local);
    return parseWikiLifecycle(parseFrontmatter(content));
  }

  /** Increment read_count on BOTH the wiki frontmatter and the Document node,
   *  via the shared canonical update path. */
  async incrementReadCount(path: string): Promise<WikiLifecycleState> {
    const wikiDir = await this.wikiRoot();
    const local = wikiLocalPath(wikiDir, path);
    const content = await this.readFile(local);
    const current = parseWikiLifecycle(parseFrontmatter(content));
    return this.update(path, { read_count: current.read_count + 1 });
  }

  /** Write the lifecycle state through to the Document node linked to the page
   *  (Document -[:IS_DOCUMENT]-> WikiPage, matched by the wiki path). Best-effort. */
  private async mirrorDocument(path: string, state: WikiLifecycleState): Promise<void> {
    if (!this.driver) return;
    const session = this.driver.session();
    try {
      await session.run(
        `MATCH (wp:${WIKIPAGE_LABEL} {id: $wikiPath})<-[:${IS_DOCUMENT_TYPE}]-(d:${DOCUMENT_LABEL})
         SET d.read_count = $readCount, d.last_reviewed = $lastReviewed,
             d.confidence = $confidence, d.topic_history = $topicHistory`,
        {
          wikiPath: path,
          readCount: state.read_count,
          lastReviewed: state.last_reviewed ?? null,
          confidence: state.confidence,
          topicHistory: state.topic_history,
        },
      );
    } catch {
      // best-effort write-through — the wiki write above already landed.
    } finally {
      await session.close();
    }
  }
}
