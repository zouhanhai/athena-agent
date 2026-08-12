/**
 * KnowledgeRetrievalService - frontend-facing retrieval access layer (G2.S4).
 *
 * Exposes the read endpoints the Knowledge/Wiki panels consume, backed by the
 * knowledge systems:
 *   - Neo4j lean RAG store: /api/kb/graph (entity-relation graph), /api/kb/search
 *     (fused vector + BM25 + graph + topic)
 *   - llm_wiki: /api/kb/wiki (page tree), /api/kb/wiki/page (markdown), /api/kb/search (BM25 keyword)
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { LlmWikiClient, LlmWikiFileNode, LlmWikiSearchResult } from "./llmwiki.js";
import type { WikiFrontmatterSyncer } from "./wiki-frontmatter.js";
import type {
  Neo4jRetrievalService,
  Neo4jSearchHit,
  Neo4jSearchResponse,
} from "./store/retrieval.js";

export interface KnowledgeRetrievalOptions {
  llmwiki: LlmWikiClient;
  /** Neo4j lean RAG store retrieval (G4.S2.T5). It is the sole semantic + graph
   *  path (fused vector + BM25 + graph + topic, G4.S2.T7/T10) while llm_wiki
   *  stays the BM25 keyword source. When omitted, search returns keyword hits
   *  only and the graph is empty. */
  neo4j?: Neo4jRetrievalService;
  /** llm_wiki project id. When omitted, current/first project is used. */
  projectId?: string;
  /** llm_wiki wiki pages directory (project.path/wiki). When omitted, it is
   *  resolved from the project path returned by listProjects(). */
  wikiDir?: string;
  /** Override reading image bytes from disk (tests). */
  readFile?: (path: string) => Promise<Buffer>;
  /** Canonical wiki-frontmatter syncer (G4.S3.T1). Tracks read_count on BOTH
   *  the wiki frontmatter and the Neo4j Document node (write-through) whenever
   *  the retrieval service surfaces a page. Best-effort. */
  frontmatter?: WikiFrontmatterSyncer;
}

export interface KnowledgeGraphNode {
  id: string;
  label: string;
  type?: string;
  [key: string]: unknown;
}

export interface KnowledgeGraphEdge {
  source: string;
  target: string;
  weight?: number;
}

export interface KnowledgeGraph {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
}

/** A single file_path → topic mapping entry from llm_wiki pages. */
export interface WikiTopicEntry {
  /** Full wiki page path, e.g. wiki/sommerseminar/foo.md. */
  path: string;
  topic: string;
}

export interface WikiPage {
  path: string;
  content: string;
}

export interface KnowledgeSearchResult {
  /** Which knowledge system produced this hit. */
  source: "llmwiki" | "neo4j";
  title: string;
  snippet: string;
  path?: string;
  score?: number;
  /** Wiki page path of a neo4j chunk hit (RAG↔Wiki fusion, G4.S2.T11). */
  wikiPath?: string;
  /** Heading path of a neo4j chunk hit's Section (e.g. "Sommerseminar / Workshops"). */
  sectionPath?: string;
  /** Same-section sibling chunk texts (context enrichment, G4.S2.T11). */
  siblings?: string[];
}

export interface KnowledgeSearchResponse {
  query: string;
  results: KnowledgeSearchResult[];
}

interface ResolvedProject {
  id: string;
  /** Local wiki pages dir (project.path/wiki) for image byte reads. */
  wikiDir?: string;
}

export class KnowledgeRetrievalService {
  private readonly llmwiki: LlmWikiClient;
  private readonly neo4j?: Neo4jRetrievalService;
  private readonly projectId?: string;
  private readonly wikiDir?: string;
  private readonly readFile: (path: string) => Promise<Buffer>;
  private readonly frontmatter?: WikiFrontmatterSyncer;
  private resolved?: ResolvedProject;

  constructor(options: KnowledgeRetrievalOptions) {
    this.llmwiki = options.llmwiki;
    this.neo4j = options.neo4j;
    this.projectId = options.projectId;
    this.wikiDir = options.wikiDir;
    this.readFile = options.readFile ?? readFile;
    this.frontmatter = options.frontmatter;
  }

  /** GET /api/kb/graph → the entity-relation graph from the Neo4j store
   *  (G4.S2.T10). Empty when the store is not wired. */
  async getGraph(): Promise<KnowledgeGraph> {
    if (!this.neo4j) return { nodes: [], edges: [] };
    const raw = await this.neo4j.getGraph();
    return {
      nodes: raw.nodes.map((n) => ({
        id: n.id,
        label: n.label,
        ...(n.type ? { type: n.type } : {}),
      })),
      edges: raw.edges.map((e) => ({ source: e.source, target: e.target })),
    };
  }

  /** GET /api/kb/graph/topics → distinct topics seen in wiki pages, sorted. */
  async getGraphTopics(): Promise<string[]> {
    const { id } = await this.resolveProject();
    const pages = await this.llmwiki.listWikiPages(id);
    const topics = new Set<string>();
    for (const page of pages) {
      if (page.topic) topics.add(page.topic);
    }
    return Array.from(topics).sort();
  }

  /** GET /api/kb/wiki → llm_wiki wiki page tree (recursive) with per-page
   *  frontmatter metadata (type + topic) so the frontend can group pages
   *  dynamically by view (Topic/Type/All) without duplicating files (G2.S5.T11). */
  async getWikiTree(): Promise<LlmWikiFileNode[]> {
    const { id } = await this.resolveProject();
    const [tree, pages] = await Promise.all([
      this.llmwiki.getFileTree(id, { root: "wiki", recursive: true }),
      this.llmwiki.listWikiPages(id),
    ]);
    const meta = new Map(pages.map((p) => [p.path, p]));
    return attachWikiMetadata(tree.files, meta);
  }

  /** GET /api/kb/wiki/page?path= → markdown content of a wiki page. */
  async readWikiPage(path: string): Promise<WikiPage> {
    const { id } = await this.resolveProject();
    const page = await this.llmwiki.readFile(id, path);
    await this.trackReadCount(path);
    return page;
  }

  /** GET /api/kb/wiki/image?path= → the wiki page's source image bytes.
   *  `path` is a project-relative wiki path (e.g. "wiki/sommerseminar/images/
   *  report.pdf/image_000000_x.png") already validated by the route guard; the
   *  file is resolved against the on-disk wiki dir (G3.S5.T5). */
  async readWikiImage(path: string): Promise<{ data: Buffer; contentType: string }> {
    const { wikiDir } = await this.resolveProject();
    if (!wikiDir) {
      throw new Error("llm_wiki wiki dir could not be resolved");
    }
    const relative = path.startsWith("wiki/") ? path.slice("wiki/".length) : path;
    if (relative.includes("..") || relative.includes("\\") || relative.startsWith("/")) {
      throw new Error("invalid wiki image path");
    }
    const data = await this.readFile(join(wikiDir, relative));
    return { data, contentType: contentTypeForImage(relative) };
  }

  /**
   * POST /api/kb/search → fused results across the configured knowledge systems.
   * The Neo4j store (G4.S2.T5) is the sole semantic path — fused vector + BM25 +
   * graph + topic — and llm_wiki stays the BM25 keyword source. When the Neo4j
   * store is not wired (NEO4J_PASSWORD unset) search degrades to llm_wiki keyword hits.
   *
   * `topic` scopes the search to a wiki-frontmatter topic subtree (G4.S3.T4): the
   * scope is expanded into the concrete list of topics under it (scope + every
   * known `scope/...` descendant), which pre-filters Neo4j candidates before
   * semantic scoring and drops out-of-subtree llm_wiki keyword hits.
   */
  async search(query: string, options: { topic?: string } = {}): Promise<KnowledgeSearchResponse> {
    const results: KnowledgeSearchResult[] = [];
    const project = await this.resolveProject();
    const scope = options.topic ? await this.loadScope(options.topic, project.id) : undefined;
    const [neo4jResult, wiki] = await Promise.allSettled([
      this.neo4j
        ? this.neo4j.search(query, {
            ...(scope ? { topics: scope.topics } : {}),
            topK: 5,
            enrichContext: true,
          })
        : Promise.resolve(null),
      this.llmwiki.search(project.id, query, { topK: 5 }),
    ]);

    if (neo4jResult.status === "fulfilled" && neo4jResult.value) {
      for (const hit of neo4jResult.value.hits) {
        results.push(mapNeo4jHit(hit));
      }
    }
    if (wiki.status === "fulfilled") {
      for (const hit of wiki.value.results) {
        if (scope && !this.hitInScope(hit.path, scope)) continue;
        results.push(mapWikiHit(hit));
      }
    }

    await this.trackSurfacePages(results);

    return { query, results };
  }

  /** Load the topic subtree for a scope from the wiki frontmatter (G4.S3.T4):
   *  the expanded topic list + a path → topic map for keyword-hit scoping.
   *  Best-effort: a wiki scan failure keeps only the scope itself. */
  private async loadScope(
    scope: string,
    projectId: string,
  ): Promise<{ topics: string[]; byPath: Map<string, string> }> {
    const topics = new Set<string>([scope]);
    const byPath = new Map<string, string>();
    try {
      const pages = await this.llmwiki.listWikiPages(projectId);
      for (const page of pages) {
        if (!page.topic) continue;
        byPath.set(page.path, page.topic);
        if (isDescendant(page.topic, scope)) topics.add(page.topic);
      }
    } catch {
      // topic-scoped search stays scoped to the exact topic on wiki failure.
    }
    return { topics: Array.from(topics).sort(), byPath };
  }

  /** True when a keyword hit's wiki page topic is inside the scoped subtree. */
  private hitInScope(
    path: string,
    scope: { topics: string[]; byPath: Map<string, string> },
  ): boolean {
    const topic = scope.byPath.get(path) ?? topicFromPath(path);
    return topic !== undefined && scope.topics.includes(topic);
  }

  /** Increment read_count (wiki frontmatter + Document node write-through) for
   *  each distinct page the retrieval surfaced (G4.S3.T1). Best-effort: a
   *  missing page or a failing store never fails the retrieval call. */
  private async trackSurfacePages(results: KnowledgeSearchResult[]): Promise<void> {
    const tracked = new Set<string>();
    for (const hit of results) {
      const wikiPath = hit.wikiPath ?? (hit.source === "llmwiki" ? hit.path : undefined);
      if (!wikiPath || tracked.has(wikiPath)) continue;
      tracked.add(wikiPath);
      await this.trackReadCount(wikiPath);
    }
  }

  private async trackReadCount(path: string): Promise<void> {
    if (!this.frontmatter || !path.startsWith("wiki/")) return;
    try {
      await this.frontmatter.incrementReadCount(path);
    } catch {
      // read_count tracking is best-effort — never fail the retrieval call.
    }
  }

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
    this.resolved = { id, ...(wikiDir ? { wikiDir } : {}) };
    return this.resolved;
  }
}

/** Content-type for a served wiki image based on its extension (G3.S5.T5). */
function contentTypeForImage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function mapWikiHit(hit: LlmWikiSearchResult): KnowledgeSearchResult {
  return {
    source: "llmwiki",
    title: hit.title || hit.path,
    snippet: hit.snippet,
    path: hit.path,
    score: hit.score,
  };
}

/** Map a Neo4j fused-retrieval hit to the frontend search result shape (G4.S2.T5/T11).
 *  Graph hits are now chunk hits (G4.S2.T14): `related` holds the entity + neighbors
 *  context, so the title shows "Entity → neighbor, …" instead of the chunk id. */
function mapNeo4jHit(hit: Neo4jSearchHit): KnowledgeSearchResult {
  const title =
    hit.source === "graph" && hit.related?.length
      ? `${hit.related[0]}${hit.related.length > 1 ? ` → ${hit.related.slice(1).join(", ")}` : ""}`
      : hit.id;
  return {
    source: "neo4j",
    title,
    snippet: hit.text,
    ...(hit.documentId ? { path: `chunk/${hit.documentId}` } : {}),
    ...(hit.wikiPath !== undefined ? { wikiPath: hit.wikiPath } : {}),
    ...(hit.sectionPath !== undefined ? { sectionPath: hit.sectionPath } : {}),
    ...(hit.siblings && hit.siblings.length > 0 ? { siblings: hit.siblings } : {}),
    score: hit.score,
  };
}

/** Attach frontmatter type/topic metadata to each file node in the tree. */
function attachWikiMetadata(
  nodes: LlmWikiFileNode[],
  meta: Map<string, { type?: string; topic?: string }>,
): LlmWikiFileNode[] {
  return nodes.map((node) => {
    if (node.isDir) {
      return { ...node, children: attachWikiMetadata(node.children ?? [], meta) };
    }
    const page = meta.get(node.path);
    if (!page) return node;
    return {
      ...node,
      ...(page.type ? { type: page.type } : {}),
      ...(page.topic ? { topic: page.topic } : {}),
    };
  });
}

/** True when `topic` is `scope` or a `scope/...` descendant (G4.S3.T4). */
function isDescendant(topic: string, scope: string): boolean {
  return topic === scope || topic.startsWith(`${scope}/`);
}

/** Best-effort topic derived from a wiki page path, tolerant of the `wiki/` prefix
 *  ("wiki/sap/fiori/x.md" and "sap/fiori/x.md" both → "sap/fiori"). */
function topicFromPath(path: string): string | undefined {
  const normalized = path.startsWith("wiki/") ? path.slice("wiki/".length) : path;
  const match = normalized.match(/^(.+)\/[^/]+\.md$/);
  if (!match) return undefined;
  const dir = match[1]!;
  return dir.length > 0 ? dir : undefined;
}
