/**
 * KnowledgeIngestService - dual-pipeline ingestion (G2.S3.T2).
 *
 * Consumes already-parsed Markdown (docling belongs to G2.S5) and feeds it to
 * both knowledge systems:
 *   - LightRAG: POST /documents/text (chunk → vector + entity graph)
 *   - llm_wiki: write the Markdown directly into the project's wiki dir, then
 *     rescan so Source Watch picks it up as a searchable wiki page.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LightRagClient } from "./lightrag.js";
import type { LlmWikiClient, WikiCategory, WikiClassification } from "./llmwiki.js";
import { WIKI_CATEGORIES } from "./llmwiki.js";

export interface IngestInput {
  /** Human-readable document title (also used to derive a safe filename). */
  title: string;
  /** Parsed Markdown content to ingest. */
  content: string;
  /** Original filename/source label, if known. */
  source?: string;
}

export interface SystemIngestStatus {
  ok: boolean;
  error?: string;
  trackId?: string;
}

export interface IngestResult {
  documentId: string;
  systems: {
    lightrag: SystemIngestStatus;
    llmwiki: SystemIngestStatus;
  };
}

export interface KnowledgeIngestOptions {
  lightrag: LightRagClient;
  llmwiki: LlmWikiClient;
  /**
   * llm_wiki wiki pages directory to write into. When omitted, it is resolved
   * from the project path returned by listProjects() as `<project.path>/wiki`.
   */
  wikiDir?: string;
  /** llm_wiki project id used for rescan. Default: current/first project. */
  projectId?: string;
  writeFile?: (path: string, content: string) => Promise<void>;
  mkdir?: (path: string) => Promise<void>;
  /**
   * Override the wiki-page classifier. Defaults to the llm_wiki agent
   * (`LlmWikiClient.classify`) with a local heuristic fallback.
   */
  classify?: (input: { title: string; content: string }) => Promise<WikiClassification>;
  /**
   * Override the wiki/index.md rebuild. Default scans the wiki dir and rewrites
   * index.md grouped by frontmatter type (best-effort: failure never fails ingest).
   */
  rebuildIndex?: (wikiDir: string) => Promise<void>;
}

/** Map any title/source to a filesystem-safe stem. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "document";
}

/** Derive a safe filename stem from source (basename w/o extension) or title. */
export function documentIdFrom(title: string, source?: string): string {
  if (source) {
    const base = source.split("/").pop() ?? source;
    const stem = base.replace(/\.(md|markdown|txt)$/i, "");
    const slug = slugify(stem);
    if (slug) return slug;
  }
  return slugify(title);
}

/** First markdown H1 heading of a page body, if present. */
export function extractPageTitle(content: string): string | undefined {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim();
}

/** Human-readable title fallback derived from a file stem (kebab-case → words). */
export function stemTitle(fileName: string): string {
  const stem = fileName.replace(/\.md$/i, "");
  const words = stem.replace(/[-_]+/g, " ").trim();
  return words || stem;
}

/** Deterministic heuristic classifier used when the llm_wiki agent is unavailable. */
export function localClassify(title: string, content: string): WikiClassification {
  const stem = slugify(title);
  const haystack = `${title}\n${content}`.toLowerCase();
  if (/\b(vs\.?|comparison|compare|differences?|alternatives?)\b/.test(haystack)) {
    return { category: "comparison", pagePath: `wiki/comparisons/${stem}.md` };
  }
  if (/(open question|research question|investigat|\?\s*$)/.test(haystack)) {
    return { category: "query", pagePath: `wiki/queries/${stem}.md` };
  }
  if (/\b(paper|arxiv|doi|blog|article|talk|conference|publication)\b/.test(haystack)) {
    return { category: "source", pagePath: `wiki/sources/${stem}.md` };
  }
  if (/\b(summary|overview|conclusion|synthesis|takeaways?|cross-cutting)\b/.test(haystack)) {
    return { category: "synthesis", pagePath: `wiki/synthesis/${stem}.md` };
  }
  if (/\b(company|corporation|inc\.?|dataset|model)\b/.test(haystack)) {
    return { category: "entity", pagePath: `wiki/entities/${stem}.md` };
  }
  return { category: "concept", pagePath: `wiki/concepts/${stem}.md` };
}

function isValidCategory(category: string): category is WikiCategory {
  return (WIKI_CATEGORIES as readonly string[]).includes(category);
}

const CATEGORY_DIRS: Record<WikiCategory, string> = {
  entity: "entities",
  concept: "concepts",
  source: "sources",
  query: "queries",
  comparison: "comparisons",
  synthesis: "synthesis",
};

/** Map a wiki category (frontmatter `type`) to its plural directory under wiki/. */
export function categoryDir(category: WikiCategory): string {
  return CATEGORY_DIRS[category];
}

/** Wrap parsed markdown with the llm_wiki frontmatter schema (type + title). */
export function withFrontmatter(category: WikiCategory, title: string, content: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `---\ntype: ${category}\ntitle: ${title}\ncreated: ${today}\nupdated: ${today}\n---\n\n${content}`;
}

export interface WikiIndexPage {
  /** Frontmatter `type` of the page (grouping key). */
  type: string;
  /** Frontmatter `title` (display label). */
  title: string;
  /** Project-relative target without extension, e.g. "concepts/foo". */
  target: string;
}

/** Replicate llm_wiki's wiki/index.md builder (project.rs rebuild_wiki_index). */
export function buildWikiIndex(pages: WikiIndexPage[]): string {
  const groups = new Map<string, WikiIndexPage[]>();
  for (const page of pages) {
    const kind = page.type || "other";
    const list = groups.get(kind) ?? [];
    list.push(page);
    groups.set(kind, list);
  }
  let out = "# Wiki Index\n\n";
  for (const kind of [...groups.keys()].sort()) {
    out += `## ${kind}\n\n`;
    const list = groups.get(kind)!;
    list.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
    for (const page of list) {
      out += `- [[${page.target}|${page.title}]]\n`;
    }
    out += "\n";
  }
  return out;
}

export interface WikiIndexEntry {
  name: string;
  isDir: boolean;
}

export interface WikiIndexFs {
  readDir: (path: string) => Promise<WikiIndexEntry[]>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
}

/** Scan <wikiDir> for pages and rewrite wiki/index.md grouped by frontmatter type. */
export async function rebuildWikiIndex(wikiDir: string, fs: WikiIndexFs): Promise<void> {
  const indexFile = join(wikiDir, "index.md");
  const pages: WikiIndexPage[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readDir(dir);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = join(dir, entry.name);
      if (entry.isDir) {
        await walk(abs);
      } else if (entry.name.endsWith(".md")) {
        const stem = entry.name.replace(/\.md$/i, "");
        if (["index", "overview", "log"].includes(stem.toLowerCase())) continue;
        const content = await fs.readFile(abs);
        pages.push({
          type: frontmatterValue(content, "type") || "other",
          title: frontmatterValue(content, "title") || stem,
          target: abs.replace(/\.md$/i, "").slice(wikiDir.length + 1),
        });
      }
    }
  };
  await walk(wikiDir);
  await fs.writeFile(indexFile, buildWikiIndex(pages));
}

function frontmatterValue(content: string, key: string): string | undefined {
  const normalized = content.replace(/\r\n/g, "\n");
  const body = normalized.startsWith("---\n") ? normalized.split("\n---")[0] : undefined;
  if (!body) return undefined;
  for (const line of body.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    if (line.slice(0, idx).trim() === key) {
      return line.slice(idx + 1).trim().replace(/^["']|["']$/g, "") || undefined;
    }
  }
  return undefined;
}

interface ResolvedProject {
  id: string;
  wikiDir: string;
}

export class KnowledgeIngestService {
  private readonly lightrag: LightRagClient;
  private readonly llmwiki: LlmWikiClient;
  private readonly wikiDir?: string;
  private readonly projectId?: string;
  private readonly writeFile: (path: string, content: string) => Promise<void>;
  private readonly mkdir: (path: string) => Promise<void>;
  private readonly classify: (input: { title: string; content: string }) => Promise<WikiClassification>;
  private readonly rebuildIndex: (wikiDir: string) => Promise<void>;
  private resolved?: ResolvedProject;

  constructor(options: KnowledgeIngestOptions) {
    this.lightrag = options.lightrag;
    this.llmwiki = options.llmwiki;
    this.wikiDir = options.wikiDir;
    this.projectId = options.projectId;
    this.writeFile = options.writeFile ?? writeFile;
    this.mkdir = options.mkdir ?? (async (path: string) => {
      await mkdir(path, { recursive: true });
    });
    this.classify = options.classify ?? ((input) => this.classifyWithAgent(input));
    this.rebuildIndex = options.rebuildIndex ?? ((dir: string) => this.rebuildIndexDefault(dir));
  }

  /**
   * Resolve the llm_wiki project id + wiki dir. When not configured, ask the
   * API for the current/first project (headless has none open) and derive the
   * wiki dir from its path.
   */
  private async resolveProject(): Promise<ResolvedProject> {
    if (this.resolved) return this.resolved;
    const { projects, currentProject } = await this.llmwiki.listProjects();
    const project =
      currentProject ??
      projects.find((p) => p.id === this.projectId) ??
      projects[0];
    if (!project) {
      throw new Error("No llm_wiki project found");
    }
    const id = this.projectId ?? project.id;
    const wikiDir = this.wikiDir ?? (project.path ? join(project.path, "wiki") : undefined);
    if (!wikiDir) {
      throw new Error("llm_wiki wiki dir could not be resolved");
    }
    this.resolved = { id, wikiDir };
    return this.resolved;
  }

  async ingestMarkdown(input: IngestInput): Promise<IngestResult> {
    const documentId = documentIdFrom(input.title, input.source);
    const fileName = `${documentId}.md`;

    const lightragResult = await this.ingestLightRag(input.content, fileName);
    const llmwikiResult = await this.ingestLlmWiki(fileName, input.content);

    return {
      documentId,
      systems: {
        lightrag: lightragResult,
        llmwiki: llmwikiResult,
      },
    };
  }

  /**
   * Ingest into LightRAG only. Public so the G2.S5 task queue can track
   * per-system progress independently of llm_wiki.
   */
  async ingestLightRag(content: string, fileName: string): Promise<SystemIngestStatus> {
    try {
      const result = await this.lightrag.ingestText(content, { fileSource: fileName });
      return { ok: true, trackId: result.track_id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Ingest into llm_wiki only (write wiki page + rescan). Public so the G2.S5
   * task queue can track per-system progress independently of LightRAG.
   *
   * G2.S5.T5: the page is classified by the llm_wiki agent and written under
   * wiki/<category>/ (not flat root), then wiki/index.md is rebuilt.
   */
  async ingestLlmWiki(fileName: string, content: string): Promise<SystemIngestStatus> {
    try {
      const { id, wikiDir } = await this.resolveProject();
      const title = extractPageTitle(content) ?? stemTitle(fileName);
      const classification = await this.classify({ title, content });
      const category = classification.category;
      const targetDir = join(wikiDir, categoryDir(category));
      await this.mkdir(targetDir);
      await this.writeFile(join(targetDir, fileName), withFrontmatter(category, title, content));
      await this.rebuildIndex(wikiDir);
      await this.llmwiki.rescan(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Classify via the llm_wiki agent, falling back to a local heuristic. */
  private async classifyWithAgent(input: {
    title: string;
    content: string;
  }): Promise<WikiClassification> {
    const fallback = localClassify(input.title, input.content);
    try {
      const { id } = await this.resolveProject();
      const classifier = (this.llmwiki as {
        classify?: (pid: string, i: { title: string; content: string }) => Promise<WikiClassification>;
      }).classify;
      if (typeof classifier !== "function") return fallback;
      const result = await classifier(id, input);
      if (!result || !isValidCategory(result.category)) return fallback;
      return { category: result.category, pagePath: result.pagePath };
    } catch {
      return fallback;
    }
  }

  /** Best-effort wiki/index.md rebuild; scan failures never fail ingestion. */
  private async rebuildIndexDefault(wikiDir: string): Promise<void> {
    try {
      await rebuildWikiIndex(wikiDir, {
        readDir: async (path) => (await readdir(path, { withFileTypes: true })).map((e) => ({
          name: e.name,
          isDir: e.isDirectory(),
        })),
        readFile: async (path) => readFile(path, "utf8"),
        writeFile: this.writeFile,
      });
    } catch {
      // index.md is derived data; a scan failure must not fail the ingest.
    }
  }
}
