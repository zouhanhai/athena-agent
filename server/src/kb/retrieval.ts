/**
 * KnowledgeRetrievalService - frontend-facing retrieval access layer (G2.S4).
 *
 * Exposes the read endpoints the Knowledge/Wiki panels consume, backed by the
 * two knowledge systems:
 *   - LightRAG: /api/kb/graph (entity-relation graph), /api/kb/search (semantic)
 *   - llm_wiki: /api/kb/wiki (page tree), /api/kb/wiki/page (markdown), /api/kb/search (keyword)
 */

import type { LightRagClient, LightRagGraphResult } from "./lightrag.js";
import type { LlmWikiClient, LlmWikiFileNode, LlmWikiSearchResult } from "./llmwiki.js";

export interface KnowledgeRetrievalOptions {
  lightrag: LightRagClient;
  llmwiki: LlmWikiClient;
  /** llm_wiki project id. When omitted, current/first project is used. */
  projectId?: string;
  /** Default label for the LightRAG graph export. Default: "all". */
  lightragLabel?: string;
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

export interface WikiPage {
  path: string;
  content: string;
}

export interface KnowledgeSearchResult {
  /** Which knowledge system produced this hit. */
  source: "lightrag" | "llmwiki";
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
}

export class KnowledgeRetrievalService {
  private readonly lightrag: LightRagClient;
  private readonly llmwiki: LlmWikiClient;
  private readonly projectId?: string;
  private readonly lightragLabel: string;
  private resolved?: ResolvedProject;

  constructor(options: KnowledgeRetrievalOptions) {
    this.lightrag = options.lightrag;
    this.llmwiki = options.llmwiki;
    this.projectId = options.projectId;
    this.lightragLabel = options.lightragLabel ?? "all";
  }

  /** GET /api/kb/graph → LightRAG entity-relation graph, normalized for the frontend. */
  async getGraph(label?: string): Promise<KnowledgeGraph> {
    const raw = await this.lightrag.getGraph(label ?? this.lightragLabel);
    return normalizeGraph(raw);
  }

  /** GET /api/kb/wiki → llm_wiki wiki page tree (recursive). */
  async getWikiTree(): Promise<LlmWikiFileNode[]> {
    const { id } = await this.resolveProject();
    const tree = await this.llmwiki.getFileTree(id, { root: "wiki", recursive: true });
    return tree.files;
  }

  /** GET /api/kb/wiki/page?path= → markdown content of a wiki page. */
  async readWikiPage(path: string): Promise<WikiPage> {
    const { id } = await this.resolveProject();
    return this.llmwiki.readFile(id, path);
  }

  /** POST /api/kb/search → fused results from LightRAG (semantic) + llm_wiki (keyword). */
  async search(query: string): Promise<KnowledgeSearchResponse> {
    const results: KnowledgeSearchResult[] = [];
    const [rag, wiki] = await Promise.allSettled([
      this.lightrag.query(query, { mode: "hybrid", topK: 5 }),
      this.llmwiki.search((await this.resolveProject()).id, query, { topK: 5 }),
    ]);

    if (rag.status === "fulfilled" && rag.value.response?.trim()) {
      results.push({
        source: "lightrag",
        title: "RAG summary",
        snippet: rag.value.response.trim(),
      });
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
    this.resolved = { id };
    return this.resolved;
  }
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
