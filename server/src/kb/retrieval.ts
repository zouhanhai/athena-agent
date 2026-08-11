/**
 * KnowledgeRetrievalService - frontend-facing retrieval access layer (G2.S4).
 *
 * Exposes the read endpoints the Knowledge/Wiki panels consume, backed by the
 * knowledge systems:
 *   - LightRAG: /api/kb/graph (entity-relation graph) only — the semantic
 *     search query path was decommissioned in G4.S2.T7 (Neo4j replaces it)
 *   - Neo4j lean RAG store: /api/kb/search (fused vector + BM25 + graph + topic)
 *   - llm_wiki: /api/kb/wiki (page tree), /api/kb/wiki/page (markdown), /api/kb/search (BM25 keyword)
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { LightRagClient, LightRagGraphResult } from "./lightrag.js";
import type { LlmWikiClient, LlmWikiFileNode, LlmWikiSearchResult } from "./llmwiki.js";
import type {
  Neo4jRetrievalService,
  Neo4jSearchHit,
  Neo4jSearchResponse,
} from "./store/retrieval.js";

export interface KnowledgeRetrievalOptions {
  lightrag: LightRagClient;
  llmwiki: LlmWikiClient;
  /** Neo4j lean RAG store retrieval (G4.S2.T5). It is the sole semantic path in
   *  `search` (fused vector + BM25 + graph + topic, G4.S2.T7) while llm_wiki
   *  stays the BM25 keyword source. When omitted, search returns keyword hits only. */
  neo4j?: Neo4jRetrievalService;
  /** llm_wiki project id. When omitted, current/first project is used. */
  projectId?: string;
  /** Default label for the LightRAG graph export. Default: "*" (full graph). */
  lightragLabel?: string;
  /** llm_wiki wiki pages directory (project.path/wiki). When omitted, it is
   *  resolved from the project path returned by listProjects(). */
  wikiDir?: string;
  /** Override reading image bytes from disk (tests). */
  readFile?: (path: string) => Promise<Buffer>;
}

export interface KnowledgeGraphNode {
  id: string;
  label: string;
  type?: string;
  /** Source file the node was extracted from (LightRAG file_path). */
  filePath?: string;
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
  private readonly lightrag: LightRagClient;
  private readonly llmwiki: LlmWikiClient;
  private readonly neo4j?: Neo4jRetrievalService;
  private readonly projectId?: string;
  private readonly lightragLabel: string;
  private readonly wikiDir?: string;
  private readonly readFile: (path: string) => Promise<Buffer>;
  private resolved?: ResolvedProject;

  constructor(options: KnowledgeRetrievalOptions) {
    this.lightrag = options.lightrag;
    this.llmwiki = options.llmwiki;
    this.neo4j = options.neo4j;
    this.projectId = options.projectId;
    this.lightragLabel = options.lightragLabel ?? "*";
    this.wikiDir = options.wikiDir;
    this.readFile = options.readFile ?? readFile;
  }

  /** GET /api/kb/graph → LightRAG entity-relation graph, normalized for the
   *  frontend. When `topic` is given, only nodes whose source file maps to that
   *  topic (via wiki frontmatter) are kept, plus the edges between them. */
  async getGraph(label?: string, topic?: string): Promise<KnowledgeGraph> {
    const raw = await this.lightrag.getGraph(label ?? this.lightragLabel);
    const graph = normalizeGraph(raw);
    if (!topic) return graph;
    const topics = await this.buildTopicMap();
    return filterGraphByTopic(graph, topic, topics);
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
    return this.llmwiki.readFile(id, path);
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
   * graph + topic — and llm_wiki stays the BM25 keyword source. The LightRAG
   * semantic query path was decommissioned in G4.S2.T7; when the Neo4j store is
   * not wired (NEO4J_PASSWORD unset) search degrades to llm_wiki keyword hits.
   */
  async search(query: string, options: { topic?: string } = {}): Promise<KnowledgeSearchResponse> {
    const results: KnowledgeSearchResult[] = [];
    const project = await this.resolveProject();
    const [neo4jResult, wiki] = await Promise.allSettled([
      this.neo4j
        ? this.neo4j.search(query, { topic: options.topic, topK: 5 })
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
        results.push(mapWikiHit(hit));
      }
    }

    return { query, results };
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

  /** Build a map from wiki page basename → topic (frontmatter), so LightRAG
   *  node file_path values (e.g. "Sommerseminar-L-sen.md") can be resolved to
   *  a topic. Falls back to the full path for robustness. */
  private async buildTopicMap(): Promise<Map<string, string>> {
    const { id } = await this.resolveProject();
    const pages = await this.llmwiki.listWikiPages(id);
    const map = new Map<string, string>();
    for (const page of pages) {
      if (!page.topic) continue;
      const base = basename(page.path);
      map.set(base, page.topic);
      map.set(page.path, page.topic);
    }
    return map;
  }
}

function basename(path: string): string {
  const cleaned = path.replace(/\\/g, "/");
  const parts = cleaned.split("/");
  return parts[parts.length - 1] ?? path;
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

/** Keep only nodes whose source file maps to `topic` (or a sub-topic of it,
 *  enabling hierarchical drill-down, e.g. "sap" includes "sap/consolidation/
 *  group-reporting"), plus the edges between them. */
function filterGraphByTopic(
  graph: KnowledgeGraph,
  topic: string,
  topicMap: Map<string, string>,
): KnowledgeGraph {
  // A node's file_path is the LightRAG file_source (<documentId>.md). The
  // topic map (built from llm_wiki page frontmatter) keys on the wiki page
  // basename AND full path, so a node maps to its topic via file_path.
  const nodeTopic = (node: KnowledgeGraphNode): string | undefined => {
    if (!node.filePath) return undefined;
    return topicMap.get(node.filePath) ?? topicMap.get(basename(node.filePath));
  };

  const matches = (nodeTopicValue: string | undefined): boolean => {
    if (nodeTopicValue === topic) return true;
    return typeof nodeTopicValue === "string" && nodeTopicValue.startsWith(`${topic}/`);
  };

  const kept = new Set<string>();
  const nodes: KnowledgeGraphNode[] = [];
  for (const node of graph.nodes) {
    if (matches(nodeTopic(node))) {
      kept.add(node.id);
      nodes.push(node);
    }
  }

  const edges: KnowledgeGraphEdge[] = [];
  for (const edge of graph.edges) {
    if (kept.has(edge.source) && kept.has(edge.target)) {
      edges.push(edge);
    }
  }

  return { nodes, edges };
}

function normalizeGraph(raw: LightRagGraphResult): KnowledgeGraph {
  const nodes: KnowledgeGraphNode[] = [];
  for (const node of raw.nodes) {
    const id = node.id ?? node.label;
    if (!id) continue;
    nodes.push({
      id: String(id),
      label: node.label ?? String(id),
      ...(node.type ? { type: String(node.type) } : {}),
      ...(node.file_path ? { filePath: String(node.file_path) } : {}),
      ...(node.properties?.file_path
        ? { filePath: String(node.properties.file_path) }
        : {}),
    });
  }

  const edges: KnowledgeGraphEdge[] = [];
  for (const edge of raw.edges) {
    if (edge.source === undefined || edge.target === undefined) continue;
    edges.push({
      source: String(edge.source),
      target: String(edge.target),
      ...(edge.weight !== undefined ? { weight: Number(edge.weight) } : {}),
    });
  }

  return { nodes, edges };
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

/** Map a Neo4j fused-retrieval hit to the frontend search result shape (G4.S2.T5). */
function mapNeo4jHit(hit: Neo4jSearchHit): KnowledgeSearchResult {
  const title =
    hit.source === "graph" ? (hit.related?.length ? `${hit.id} → ${hit.related.join(", ")}` : hit.id) : hit.id;
  return {
    source: "neo4j",
    title,
    snippet: hit.text,
    ...(hit.documentId ? { path: `chunk/${hit.documentId}` } : {}),
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
