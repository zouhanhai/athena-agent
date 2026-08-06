/**
 * KnowledgeIngestService - dual-pipeline ingestion (G2.S3.T2).
 *
 * Consumes already-parsed Markdown (docling belongs to G2.S5) and feeds it to
 * both knowledge systems:
 *   - LightRAG: POST /documents/text (chunk → vector + entity graph)
 *   - llm_wiki: write the Markdown directly into the project's wiki dir, then
 *     rescan so Source Watch picks it up as a searchable wiki page.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LightRagClient } from "./lightrag.js";
import type { LlmWikiClient } from "./llmwiki.js";

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
   */
  async ingestLlmWiki(fileName: string, content: string): Promise<SystemIngestStatus> {
    try {
      const { id, wikiDir } = await this.resolveProject();
      await this.mkdir(wikiDir);
      await this.writeFile(join(wikiDir, fileName), content);
      await this.llmwiki.rescan(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
