/**
 * KnowledgeIngestService - wiki-page ingestion (G2.S3.T2).
 *
 * Consumes already-parsed Markdown (docling belongs to G2.S5) and writes it into
 * the llm_wiki project's wiki dir, then rescans so Source Watch picks it up as a
 * searchable wiki page. The RAG store ingest (Neo4j) is driven by the ingest
 * task queue from the Athena refinement output (G4.S2.T4).
 */
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LlmWikiClient, WikiCategory, WikiClassification } from "./llmwiki.js";
import { WIKI_CATEGORIES, isValidTopic } from "./llmwiki.js";
import { DOC_TYPE_DIRS } from "./taxonomy.js";
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

/** llm_wiki sub-step progress reporting (G3.S5.T2). */
export type LlmWikiStepName = "classify" | "write_page" | "rebuild_index";
export type LlmWikiProgress = (step: LlmWikiStepName, status: "running" | "done") => void;

export interface DeleteDocumentResult {
  /** True when the wiki page was removed (the tree can refresh). */
  ok: boolean;
  /** llm_wiki delete outcome for the page path (and/or an error). */
  llmwiki?: { path?: string; error?: string };
}

export interface IngestResult {
  documentId: string;
  systems: {
    llmwiki: SystemIngestStatus;
  };
}

export interface KnowledgeIngestOptions {
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
  /** Override listing a directory for image copying (tests). */
  readdir?: (path: string) => Promise<WikiIndexEntry[]>;
  /** Override copying one image file (tests). */
  copyFile?: (src: string, dest: string) => Promise<void>;
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

/**
 * Deterministic local topic detection (G2.S5.T10, updated to the hierarchical
 * CALEO topic tree from docs/taxonomy.md). Recognizes stable subject keywords
 * so related documents group under a shared topic folder even when the
 * llm_wiki agent is unavailable. More specific paths are matched first. Returns
 * undefined when no recognizable subject is found (falls back to type dir).
 */
const TOPIC_PATTERNS: [RegExp, string][] = [
  [/\b(sommerseminar|sommer\s*seminar)\b/, "internal/events"],
  [/\b(summer\s*school|conference|workshop|retreat|meetup)\b/, "internal/events"],
  [/\b(group\s*reporting|groupreporting)\b/, "sap/consolidation/group-reporting"],
  [/\b(bcs|business\s*consolidation\s*system)\b/, "sap/consolidation/bcs"],
  [/\bndc\s*financial\s*consolidation\b/, "sap/consolidation/ndc-financial-consolidation"],
  [/\b(bpc|bw\s*planning)\b/, "sap/planning/bpc"],
  [/\bdatasphere\b/, "sap/business-warehouse/datasphere"],
  [/\b(bw\/4|business\s*warehouse)\b/, "sap/business-warehouse/bw"],
  [/\b(btp|business\s*technology\s*platform)\b/, "sap/cloud/btp"],
  [/\bbdc\b/, "sap/cloud/bdc"],
  [/\bsac\b/, "sap/reporting/sac"],
  [/\blumira\b/, "sap/reporting/lumira"],
  [/\b(bex|wad)\b/, "sap/reporting/legacy"],
  [/\babap\b/, "sap/development/abap"],
  [/\bcds\b/, "sap/development/cds"],
  [/\b(fiori|ui5)\b/, "sap/development/fiori"],
  [/\besg\b/, "sap/esg"],
  [/\bs\/?4hana\b/, "sap/migration/s4hana"],
  [/\bconsolidation\b/, "sap/consolidation"],
];

export function localTopic(title: string, content: string): string | undefined {
  const haystack = `${title}\n${content}`.toLowerCase();
  for (const [re, topic] of TOPIC_PATTERNS) {
    if (re.test(haystack)) return topic;
  }
  return undefined;
}

/**
 * Deterministic heuristic classifier used when the llm_wiki agent is
 * unavailable. Implements the 13-kind CALEO taxonomy (docs/taxonomy.md). The
 * old research-oriented comparison/query/synthesis types are gone, so
 * financial-report text can no longer be misclassified as `comparison`.
 */
export function localClassify(title: string, content: string): WikiClassification {
  const stem = slugify(title);
  const haystack = `${title}\n${content}`.toLowerCase();
  const category: WikiCategory = (() => {
    if (/\b(sommerseminar|conference|workshop|retreat|meetup|summer\s*school|agenda|itinerary)\b/.test(haystack)) {
      return "event";
    }
    if (/\b(paper|arxiv|doi|publication|official\s*(documentation|docs?|guide)|help\.sap\.com|vendor\s*(material|documentation|docs?)|published\s*by)\b/.test(haystack)) {
      return "source";
    }
    if (/\b(meeting\s*minutes|attendees?|action\s*items?|discussion\s*points)\b/.test(haystack)) {
      return "minute";
    }
    if (/\b(annual\s*report|financial\s*report|project\s*status|quarterly\s*report|audit\s*report|income\s*statement|balance\s*sheet|profit|revenue|findings|overview)\b/.test(haystack)) {
      return "report";
    }
    if (/\b(how\s*to|runbook|step\s*-?\s*by\s*-?\s*step|operating\s*guide|user\s*guide|manual|handbook|troubleshoot)\b/.test(haystack)) {
      return "manual";
    }
    if (/\b(specification|requirements|architecture|interface|config(?:uration)?|schema|data\s*model)\b/.test(haystack)) {
      return "spec";
    }
    if (/\b(proposal|implementation\s*plan|roadmap|offering|scope\s*of\s*work|statement\s*of\s*work|quotation)\b/.test(haystack)) {
      return "proposal";
    }
    if (/\b(contract|agreement|n\s*d\s*a|partnership|procurement|terms\s*and\s*conditions)\b/.test(haystack)) {
      return "contract";
    }
    if (/\b(policy|regulation|sop|code\s*of\s*conduct|compliance)\b/.test(haystack)) {
      return "policy";
    }
    if (/\b(presentation|slides|slide\s*deck|deck|training\s*material|talk)\b/.test(haystack)) {
      return "presentation";
    }
    if (/\b(employee\s*profile|profile\s*of|curriculum\s*vitae|\bcv\b|biography)\b/.test(haystack)) {
      return "person";
    }
    if (/\b(company|corporation|inc\.?|gmbh|dataset|project|product|client)\b/.test(haystack)) {
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

/**
 * Convert the Athena refinement frontmatter (G4.S1.T4) into a llm_wiki
 * WikiClassification so downstream is pure I/O (no classify LLM call). The
 * refinement emits type/topic once; invalid/missing values fall back to the
 * local heuristic so the pipeline never regresses.
 */
export function classificationFromRefinement(
  frontmatter: { type: string; topic: string } | undefined,
  title: string,
  content: string,
): WikiClassification {
  const fallback = localClassify(title, content);
  const category = frontmatter?.type && isValidCategory(frontmatter.type) ? frontmatter.type : fallback.category;
  const topic = frontmatter?.topic && isValidTopic(frontmatter.topic) ? frontmatter.topic : fallback.topic;
  const stem = slugify(title);
  return {
    category,
    pagePath: `wiki/${categoryDir(category)}/${stem}.md`,
    ...(topic ? { topic } : {}),
  };
}

/** Map a wiki category (frontmatter `type`) to its plural directory under wiki/. */
export function categoryDir(category: WikiCategory): string {
  return DOC_TYPE_DIRS[category];
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

/** File-system surface needed to copy docling-extracted images (G3.S5.T5). */
export interface WikiImagesFs {
  readDir: (path: string) => Promise<WikiIndexEntry[]>;
  copyFile: (src: string, dest: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
}

/**
 * Recursively copy the docling-extracted images from `sourceDir` into
 * `targetDir`, preserving the relative layout so the markdown refs
 * (`images/<stem>/image_x.png`) resolve unchanged relative to the wiki page
 * (G3.S5.T5). Throws on a missing source dir (no images for this document).
 */
export async function copyExtractedImages(
  sourceDir: string,
  targetDir: string,
  fs: WikiImagesFs,
): Promise<void> {
  const entries = await fs.readDir(sourceDir);
  await fs.mkdir(targetDir);
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const src = join(sourceDir, entry.name);
    const dest = join(targetDir, entry.name);
    if (entry.isDir) {
      await copyExtractedImages(src, dest, fs);
    } else {
      await fs.copyFile(src, dest);
    }
  }
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
  private readonly llmwiki: LlmWikiClient;
  private readonly wikiDir?: string;
  private readonly projectId?: string;
  private readonly writeFile: (path: string, content: string) => Promise<void>;
  private readonly mkdir: (path: string) => Promise<void>;
  private readonly readdir: (path: string) => Promise<WikiIndexEntry[]>;
  private readonly copyFile: (src: string, dest: string) => Promise<void>;
  private readonly classify: (input: { title: string; content: string }) => Promise<WikiClassification>;
  private readonly rebuildIndex: (wikiDir: string) => Promise<void>;
  private resolved?: ResolvedProject;

  constructor(options: KnowledgeIngestOptions) {
    this.llmwiki = options.llmwiki;
    this.wikiDir = options.wikiDir;
    this.projectId = options.projectId;
    this.writeFile = options.writeFile ?? writeFile;
    this.mkdir = options.mkdir ?? (async (path: string) => {
      await mkdir(path, { recursive: true });
    });
    this.readdir = options.readdir ?? (async (path: string) => {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    });
    this.copyFile = options.copyFile ?? copyFile;
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

    // G3.S8.T2: classify FIRST (llm_wiki agent, local fallback) so the wiki page
    // carries the type + topic frontmatter.
    const { classification } = await this.prepareForIngest(input);

    const llmwikiResult = await this.ingestLlmWiki(fileName, input.content, undefined, classification);

    return {
      documentId,
      systems: {
        llmwiki: llmwikiResult,
      },
    };
  }

  /**
   * Classify a document (llm_wiki agent with local fallback) and wrap its
   * content in the llm_wiki frontmatter schema (type + title + topic).
   * Best-effort: never throws; the local heuristic is the floor.
   */
  async prepareForIngest(input: { title: string; content: string }): Promise<{
    classification: WikiClassification;
    frontmatterContent: string;
  }> {
    let classification: WikiClassification;
    try {
      classification = await this.classify(input);
    } catch {
      classification = localClassify(input.title, input.content);
    }
    const topic = classification.topic && isValidTopic(classification.topic)
      ? classification.topic
      : undefined;
    return {
      classification,
      frontmatterContent: withFrontmatter(classification.category, input.title, input.content, topic),
    };
  }

  /**
   * Ingest into llm_wiki only (write wiki page + rescan). Public so the G2.S5
   * task queue can track per-system progress.
   *
   * G2.S5.T5: the page is classified by the llm_wiki agent and written under
   * wiki/<category>/ (not flat root), then wiki/index.md is rebuilt.
   * G2.S5.T10: when the classifier also derives a topic, the page is written
   * under wiki/<topic>/ instead so related documents group together.
   * G3.S8.T2: when `preclassified` is given (the caller already classified the
   * doc), the classification is REUSED instead of calling the agent again.
   * G3.S5.T5: when `images` is given, the docling-extracted image files are
   * copied beside the page (wiki/<topic>/images/<stem>/...) so the markdown
   * refs `images/<stem>/image_x.png` resolve relative to the page. The refs
   * themselves are NOT rewritten — the copy preserves the relative layout the
   * refs already use.
   */
  async ingestLlmWiki(
    fileName: string,
    content: string,
    onStep?: LlmWikiProgress,
    preclassified?: WikiClassification,
    images?: { sourceDir: string; relativeDir: string },
  ): Promise<SystemIngestStatus> {
    try {
      const { id, wikiDir } = await this.resolveProject();
      const title = extractPageTitle(content) ?? stemTitle(fileName);
      onStep?.("classify", "running");
      const classification = preclassified ?? await this.classify({ title, content });
      onStep?.("classify", "done");
      const category = classification.category;
      const topic = classification.topic && isValidTopic(classification.topic)
        ? classification.topic
        : undefined;
      const subDir = topic ?? categoryDir(category);
      const targetDir = join(wikiDir, subDir);
      onStep?.("write_page", "running");
      await this.mkdir(targetDir);
      await this.writeFile(join(targetDir, fileName), withFrontmatter(category, title, content, topic));
      if (images) {
        await this.copyPageImages(images.sourceDir, join(targetDir, images.relativeDir));
      }
      onStep?.("write_page", "done");
      onStep?.("rebuild_index", "running");
      await this.rebuildIndex(wikiDir);
      await this.llmwiki.rescan(id);
      onStep?.("rebuild_index", "done");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
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
   * Delete a wiki page from llm_wiki (G2.S5.T12). `path` is the project-relative
   * wiki page, e.g. "wiki/concepts/foo.md". Deletes the page file on disk +
   * rescan (Source Watch drops it from the index) + rebuilds wiki/index.md.
   */
  async deleteDocument(path: string): Promise<DeleteDocumentResult> {
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
      llmwiki: llmwikiOutcome,
    };
  }

  /** Copy the docling-extracted images beside the wiki page (G3.S5.T5).
   *  A missing source dir means the document has no images — skip. Other
   *  failures propagate so the write_page step surfaces them. */
  private async copyPageImages(sourceDir: string, destDir: string): Promise<void> {
    try {
      await copyExtractedImages(sourceDir, destDir, {
        readDir: this.readdir,
        copyFile: this.copyFile,
        mkdir: this.mkdir,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw err;
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
