/**
 * KnowledgeIngestService - dual-pipeline ingestion (G2.S3.T2).
 *
 * Consumes already-parsed Markdown (docling belongs to G2.S5) and feeds it to
 * both knowledge systems:
 *   - LightRAG: POST /documents/text (chunk → vector + entity graph)
 *   - llm_wiki: write the Markdown directly into the project's wiki dir, then
 *     rescan so Source Watch picks it up as a searchable wiki page.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LightRagClient } from "./lightrag.js";
import type { LlmWikiClient, WikiCategory, WikiClassification } from "./llmwiki.js";
import { WIKI_CATEGORIES, isValidTopic } from "./llmwiki.js";
import { parseFrontmatter } from "./frontmatter.js";

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

export interface DeleteDocumentResult {
  /** True when the wiki page was removed (the tree can refresh). */
  ok: boolean;
  /** LightRAG delete outcome: doc ids removed (and/or an error). */
  lightrag?: { deleted: string[]; error?: string };
  /** llm_wiki delete outcome for the page path (and/or an error). */
  llmwiki?: { path?: string; error?: string };
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

/**
 * Extract a short distinctive probe from a document for LightRAG semantic
 * near-duplicate queries (G2.S5.T14). Prefers the first non-heading paragraph,
 * else the first non-empty line; capped to ~400 chars.
 */
export function distinctiveProbe(content: string): string | undefined {
  const withoutFrontmatter = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const lines = withoutFrontmatter
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const paragraphs = withoutFrontmatter
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/^#{1,6}\s/.test(p));
  const probe = (paragraphs[0] ?? lines[0] ?? "").slice(0, 400).trim();
  return probe || undefined;
}

/** Human-readable title fallback derived from a file stem (kebab-case → words). */
export function stemTitle(fileName: string): string {
  const stem = fileName.replace(/\.md$/i, "");
  const words = stem.replace(/[-_]+/g, " ").trim();
  return words || stem;
}

/**
 * Deterministic local topic detection (G2.S5.T10). Recognizes a stable
 * subject key so related documents (e.g. 3 Sommerseminar PDFs) group under a
 * shared topic folder even when the llm_wiki agent is unavailable. Returns
 * undefined when no recognizable subject is found (falls back to type dir).
 */
export function localTopic(title: string, content: string): string | undefined {
  const haystack = `${title}\n${content}`.toLowerCase();
  const patterns: [RegExp, string][] = [
    [/\bsommerseminar\b/, "sommerseminar"],
    [/\bsummer\s*school\b/, "summer-school"],
    [/\bconference\b/, "conference"],
    [/\bworkshop\b/, "workshop"],
    [/\bretreat\b/, "retreat"],
    [/\bmeetup\b/, "meetup"],
  ];
  for (const [re, topic] of patterns) {
    if (re.test(haystack)) return topic;
  }
  return undefined;
}

/** Deterministic heuristic classifier used when the llm_wiki agent is unavailable. */
export function localClassify(title: string, content: string): WikiClassification {
  const stem = slugify(title);
  const haystack = `${title}\n${content}`.toLowerCase();
  const category: WikiCategory = (() => {
    if (/\b(vs\.?|comparison|compare|differences?|alternatives?)\b/.test(haystack)) {
      return "comparison";
    }
    if (/(open question|research question|investigat|\?\s*$)/.test(haystack)) {
      return "query";
    }
    if (/\b(paper|arxiv|doi|blog|article|talk|conference|publication)\b/.test(haystack)) {
      return "source";
    }
    if (/\b(summary|overview|conclusion|synthesis|takeaways?|cross-cutting)\b/.test(haystack)) {
      return "synthesis";
    }
    if (/\b(company|corporation|inc\.?|dataset|model)\b/.test(haystack)) {
      return "entity";
    }
    return "concept";
  })();
  const topic = localTopic(title, content);
  return {
    category,
    pagePath: `wiki/${categoryDir(category)}/${stem}.md`,
    ...(topic ? { topic } : {}),
  };
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

/** Wrap parsed markdown with the llm_wiki frontmatter schema (type + title + topic). */
export function withFrontmatter(
  category: WikiCategory,
  title: string,
  content: string,
  topic?: string,
): string {
  const today = new Date().toISOString().slice(0, 10);
  const topicLine = topic && isValidTopic(topic) ? `topic: ${topic}\n` : "";
  return `---\ntype: ${category}\ntitle: ${title}\n${topicLine}created: ${today}\nupdated: ${today}\n---\n\n${content}`;
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
  return parseFrontmatter(content)[key] || undefined;
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
   * G2.S5.T10: when the classifier also derives a topic, the page is written
   * under wiki/<topic>/ instead so related documents group together.
   */
  async ingestLlmWiki(fileName: string, content: string): Promise<SystemIngestStatus> {
    try {
      const { id, wikiDir } = await this.resolveProject();
      const title = extractPageTitle(content) ?? stemTitle(fileName);
      const classification = await this.classify({ title, content });
      const category = classification.category;
      const topic = classification.topic && isValidTopic(classification.topic)
        ? classification.topic
        : undefined;
      const subDir = topic ?? categoryDir(category);
      const targetDir = join(wikiDir, subDir);
      await this.mkdir(targetDir);
      await this.writeFile(join(targetDir, fileName), withFrontmatter(category, title, content, topic));
      await this.rebuildIndex(wikiDir);
      await this.llmwiki.rescan(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Layer-2 semantic near-duplicate check (G2.S5.T14), running inside LightRAG
   * (which has embeddings) — NOT llm_wiki (keyword/vector only). After a doc is
   * stored, query LightRAG with a distinctive probe from the doc; if the top
   * reference belongs to a DIFFERENT existing file, return that file's path so
   * the UI can surface a "possibly similar to X" notice. Best-effort: returns
   * undefined when nothing strong matches or LightRAG is unreachable.
   */
  async findNearDuplicate(content: string, selfFileName: string): Promise<string | undefined> {
    const probe = distinctiveProbe(content);
    if (!probe) return undefined;
    try {
      const result = await this.lightrag.query(probe, { mode: "hybrid", topK: 5 });
      for (const ref of result.references ?? []) {
        if (!ref.file_path || ref.file_path === selfFileName) continue;
        return ref.file_path;
      }
    } catch {
      // semantic check is best-effort; a LightRAG outage must never fail ingest
    }
    return undefined;
  }

  /**
   * List the raw markdown content of every existing wiki page (G2.S5.T14).
   * Used to seed the content-dedup store so previously-ingested documents are
   * recognized even after a server restart. Best-effort: unreadable pages are
   * skipped.
   */
  async existingWikiContent(): Promise<{ path: string; content: string }[]> {
    const { id } = await this.resolveProject();
    const pages = await this.llmwiki.listWikiPages(id);
    const out: { path: string; content: string }[] = [];
    for (const page of pages) {
      if (!page.path.endsWith(".md")) continue;
      try {
        const { content } = await this.llmwiki.readFile(id, page.path);
        out.push({ path: page.path, content });
      } catch {
        // skip unreadable page — dedup seeding is best-effort
      }
    }
    return out;
  }

  /**
   * Delete a wiki page from BOTH knowledge systems (G2.S5.T12). `path` is the
   * project-relative wiki page, e.g. "wiki/concepts/foo.md".
   *
   * - LightRAG: list docs, match by file_source basename, delete matched ids
   *   (chunks + vectors + graph + LLM cache, so a re-upload of the same name works).
   * - llm_wiki: delete the page file on disk + rescan (Source Watch drops it from
   *   the index) + rebuild wiki/index.md.
   */
  async deleteDocument(path: string): Promise<DeleteDocumentResult> {
    const fileSource = path.split("/").pop() ?? path;
    const lightragOutcome: { deleted: string[]; error?: string } = { deleted: [] };
    try {
      const docs = await this.lightrag.listDocuments();
      const matches = docs.filter((d) => d.file_path === fileSource);
      for (const doc of matches) {
        await this.lightrag.deleteDocument(doc.id);
        lightragOutcome.deleted.push(doc.id);
      }
    } catch (err) {
      lightragOutcome.error = err instanceof Error ? err.message : String(err);
    }

    const llmwikiOutcome: { path?: string; error?: string } = { path };
    try {
      const { id } = await this.resolveProject();
      await this.llmwiki.deleteFile(id, path);
      const { wikiDir } = await this.resolveProject();
      await this.rebuildIndex(wikiDir);
    } catch (err) {
      llmwikiOutcome.error = err instanceof Error ? err.message : String(err);
    }

    return {
      ok: !llmwikiOutcome.error,
      lightrag: lightragOutcome,
      llmwiki: llmwikiOutcome,
    };
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
        classify?: (
          pid: string,
          i: { title: string; content: string },
          existingTopics?: readonly string[],
        ) => Promise<WikiClassification>;
      }).classify;
      if (typeof classifier !== "function") return fallback;
      const existingTopics = await this.existingTopics(id);
      const result = await classifier(id, input, existingTopics);
      if (!result || !isValidCategory(result.category)) return fallback;
      const topic = result.topic && isValidTopic(result.topic) ? result.topic : fallback.topic;
      return {
        category: result.category,
        pagePath: result.pagePath,
        ...(topic ? { topic } : {}),
      };
    } catch {
      return fallback;
    }
  }

  /**
   * Collect the distinct topic keys already present in the wiki so the
   * classifier can reuse them instead of minting near-duplicate topics
   * (G2.S5.T11). Best-effort: any failure returns an empty list.
   */
  private async existingTopics(projectId: string): Promise<string[]> {
    try {
      const pages = await this.llmwiki.listWikiPages(projectId);
      const topics = new Set<string>();
      for (const page of pages) {
        if (page.topic) topics.add(page.topic);
      }
      return [...topics].sort();
    } catch {
      return [];
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
