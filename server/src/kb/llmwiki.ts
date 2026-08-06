/**
 * LlmWikiClient - thin HTTP client for the llm_wiki API server (:19828, /api/v1).
 *
 * Encapsulates the endpoints used by the athena knowledge access layer:
 * file tree, page content, hybrid search, wikilinks graph, and source rescan.
 */

export interface LlmWikiOptions {
  /** Base URL of the llm_wiki API. Default: http://127.0.0.1:19828 */
  baseUrl?: string;
  /** Bearer token for the llm_wiki API. Default: LLM_WIKI_API_TOKEN env. */
  token?: string;
  /** Injectable fetch implementation for unit tests. */
  fetchImpl?: typeof fetch;
}

export interface LlmWikiHealth {
  ok?: boolean;
  status?: string;
  enabled?: boolean;
  authRequired?: boolean;
  version?: string;
  [key: string]: unknown;
}

export interface LlmWikiProject {
  id: string;
  name: string;
  path: string;
  current: boolean;
}

export interface LlmWikiFileNode {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  children?: LlmWikiFileNode[];
}

export interface LlmWikiSearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number;
  titleMatch?: boolean;
  vectorScore?: number | null;
}

export interface LlmWikiSearchResponse {
  results: LlmWikiSearchResult[];
  mode?: string;
  tokenHits?: number;
  vectorHits?: number;
}

export interface LlmWikiGraphNode {
  id: string;
  label: string;
  type?: string;
  path?: string;
  linkCount?: number;
  weight?: number;
}

export interface LlmWikiGraphEdge {
  source: string;
  target: string;
  weight?: number;
}

export interface LlmWikiGraphResult {
  nodes: LlmWikiGraphNode[];
  edges: LlmWikiGraphEdge[];
}

export interface LlmWikiFileTreeOptions {
  /** Root directory to list. Default: "wiki". */
  root?: "wiki" | "sources" | "all";
  recursive?: boolean;
  maxFiles?: number;
}

export interface LlmWikiSearchOptions {
  topK?: number;
  includeContent?: boolean;
}

/** llm_wiki wiki page categories (from the project schema / project.rs). */
export const WIKI_CATEGORIES = [
  "entity",
  "concept",
  "source",
  "query",
  "comparison",
  "synthesis",
] as const;

export type WikiCategory = (typeof WIKI_CATEGORIES)[number];

export interface WikiClassification {
  /** Which category directory the page belongs under (wiki/<category>/). */
  category: WikiCategory;
  /** Project-relative page path, e.g. "wiki/concepts/chain-of-thought.md". */
  pagePath: string;
}

export interface WikiClassifyInput {
  title: string;
  content: string;
}

/** Validate + parse the LLM agent's JSON classification reply. */
export function parseClassification(value: unknown): WikiClassification | null {
  if (typeof value !== "string") return null;
  const match = value.match(/\{[^{}]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as { category?: unknown; pagePath?: unknown };
    if (typeof obj.pagePath !== "string" || !obj.pagePath.endsWith(".md")) return null;
    const category = String(obj.category ?? "").toLowerCase();
    if (!(WIKI_CATEGORIES as readonly string[]).includes(category)) return null;
    return { category: category as WikiCategory, pagePath: obj.pagePath };
  } catch {
    return null;
  }
}

export interface LlmWikiGraphOptions {
  q?: string;
  nodeType?: string;
  limit?: number;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export class LlmWikiClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LlmWikiOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.LLM_WIKI_API_BASE_URL ?? "http://127.0.0.1:19828");
    this.token = options.token ?? process.env.LLM_WIKI_API_TOKEN;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** GET /health - service liveness + auth state. */
  async getHealth(): Promise<LlmWikiHealth> {
    return this.request("/health", { auth: false });
  }

  /** GET /projects - list available wiki projects. */
  async listProjects(): Promise<{ projects: LlmWikiProject[]; currentProject: LlmWikiProject | null }> {
    const json = await this.request("/projects");
    const projects = Array.isArray(json.projects) ? json.projects.map(parseProject) : [];
    const currentProject = json.currentProject ? parseProject(json.currentProject) : null;
    return { projects, currentProject };
  }

  /** GET /projects/{id}/files - file tree of a project root (wiki pages or raw sources). */
  async getFileTree(projectId: string, options: LlmWikiFileTreeOptions = {}): Promise<{ files: LlmWikiFileNode[]; truncated?: boolean }> {
    const params = new URLSearchParams();
    params.set("root", options.root ?? "wiki");
    if (options.recursive !== undefined) params.set("recursive", String(options.recursive));
    if (options.maxFiles !== undefined) params.set("maxFiles", String(options.maxFiles));
    const json = await this.request(`/projects/${encodeURIComponent(projectId)}/files?${params.toString()}`);
    return {
      files: Array.isArray(json.files) ? json.files.map(parseFileNode) : [],
      truncated: json.truncated === true,
    };
  }

  /** GET /projects/{id}/files/content - read a wiki page or source file. */
  async readFile(projectId: string, path: string): Promise<{ path: string; content: string }> {
    const params = new URLSearchParams({ path });
    const json = await this.request(`/projects/${encodeURIComponent(projectId)}/files/content?${params.toString()}`);
    return {
      path: typeof json.path === "string" ? json.path : path,
      content: typeof json.content === "string" ? json.content : "",
    };
  }

  /** POST /projects/{id}/search - hybrid (keyword + vector + graph) search. */
  async search(projectId: string, query: string, options: LlmWikiSearchOptions = {}): Promise<LlmWikiSearchResponse> {
    const body: Record<string, unknown> = { query };
    if (options.topK !== undefined) body.topK = options.topK;
    if (options.includeContent !== undefined) body.includeContent = options.includeContent;
    const json = await this.request(`/projects/${encodeURIComponent(projectId)}/search`, {
      method: "POST",
      body,
    });
    return {
      results: Array.isArray(json.results) ? json.results.map(parseSearchResult) : [],
      mode: typeof json.mode === "string" ? json.mode : undefined,
      tokenHits: numberOrUndefined(json.tokenHits),
      vectorHits: numberOrUndefined(json.vectorHits),
    };
  }

  /** GET /projects/{id}/graph - export the wikilinks knowledge graph. */
  async getGraph(projectId: string, options: LlmWikiGraphOptions = {}): Promise<LlmWikiGraphResult> {
    const params = new URLSearchParams();
    if (options.q) params.set("q", options.q);
    if (options.nodeType) params.set("nodeType", options.nodeType);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    const json = await this.request(`/projects/${encodeURIComponent(projectId)}/graph${suffix}`);
    return {
      nodes: Array.isArray(json.nodes) ? json.nodes.map(parseGraphNode) : [],
      edges: Array.isArray(json.edges) ? json.edges.map(parseGraphEdge) : [],
    };
  }

  /** POST /projects/{id}/sources/rescan - trigger Source Watch to pick up new files. */
  async rescan(projectId: string): Promise<Record<string, unknown>> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/sources/rescan`, {
      method: "POST",
    });
  }

  /**
   * POST /projects/{id}/chat - ask the llm_wiki LLM agent to classify a
   * document into a wiki category (entity/concept/source/query/comparison/
   * synthesis) so ingestion can place it in the right wiki/<category>/ dir.
   */
  async classify(projectId: string, input: WikiClassifyInput): Promise<WikiClassification> {
    const excerpt = input.content.slice(0, 2000);
    const prompt =
      "You are a wiki librarian. Classify the following document into exactly one wiki category:\n" +
      "- entity: named things (models, companies, people, datasets)\n" +
      "- concept: ideas, techniques, phenomena\n" +
      "- source: papers, articles, talks, blog posts\n" +
      "- query: open questions under investigation\n" +
      "- comparison: side-by-side analysis of related entities\n" +
      "- synthesis: cross-cutting summaries and conclusions\n\n" +
      `Document title: ${input.title}\n\n` +
      `Document content:\n${excerpt}\n\n` +
      'Reply with ONLY a single JSON object like {"category":"concept","pagePath":"wiki/concepts/chain-of-thought.md"} and nothing else. pagePath must start with "wiki/" and end with ".md".';
    const body: Record<string, unknown> = {
      message: prompt,
      mode: "fast",
      history: [],
      history_explicit: true,
      persist_session: false,
    };
    const json = await this.request(`/projects/${encodeURIComponent(projectId)}/chat`, {
      method: "POST",
      body,
      timeoutMs: 60_000,
    });
    const raw =
      typeof json.message === "object" && json.message !== null
        ? (json.message as { content?: unknown }).content
        : undefined;
    const parsed = parseClassification(raw);
    if (!parsed) throw new Error("llm_wiki agent returned no valid classification");
    return parsed;
  }

  private async request(
    path: string,
    options: { method?: "GET" | "POST"; body?: unknown; auth?: boolean; timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}/api/v1${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.auth !== false && this.token?.trim()) {
      headers.Authorization = `Bearer ${this.token.trim()}`;
    }
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    const response = await this.fetchImpl(url, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      ...(options.timeoutMs !== undefined ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
    });

    const text = await response.text();
    let json: Record<string, unknown>;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }

    if (!response.ok || json.ok === false) {
      const message = typeof json.error === "string" ? json.error : response.statusText;
      throw new Error(`LLM Wiki API ${response.status}: ${message}`);
    }
    return json;
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseProject(value: unknown): LlmWikiProject {
  const obj = (value ?? {}) as Record<string, unknown>;
  return {
    id: String(obj.id ?? ""),
    name: String(obj.name ?? ""),
    path: String(obj.path ?? ""),
    current: obj.current === true,
  };
}

function parseFileNode(value: unknown): LlmWikiFileNode {
  const obj = (value ?? {}) as Record<string, unknown>;
  const children = Array.isArray(obj.children) ? obj.children.map(parseFileNode) : undefined;
  return {
    name: String(obj.name ?? ""),
    path: String(obj.path ?? ""),
    isDir: obj.isDir === true || obj.is_dir === true,
    size: numberOrUndefined(obj.size),
    ...(children ? { children } : {}),
  };
}

function parseSearchResult(value: unknown): LlmWikiSearchResult {
  const obj = (value ?? {}) as Record<string, unknown>;
  return {
    path: String(obj.path ?? ""),
    title: String(obj.title ?? ""),
    snippet: String(obj.snippet ?? ""),
    score: numberOrUndefined(obj.score) ?? 0,
    titleMatch: obj.titleMatch === true,
    vectorScore: numberOrUndefined(obj.vectorScore) ?? null,
  };
}

function parseGraphNode(value: unknown): LlmWikiGraphNode {
  const obj = (value ?? {}) as Record<string, unknown>;
  return {
    id: String(obj.id ?? ""),
    label: String(obj.label ?? ""),
    type: String(obj.nodeType ?? obj.type ?? "other"),
    path: typeof obj.path === "string" ? obj.path : undefined,
    linkCount: numberOrUndefined(obj.linkCount),
    weight: numberOrUndefined(obj.weight),
  };
}

function parseGraphEdge(value: unknown): LlmWikiGraphEdge {
  const obj = (value ?? {}) as Record<string, unknown>;
  return {
    source: String(obj.source ?? ""),
    target: String(obj.target ?? ""),
    weight: numberOrUndefined(obj.weight),
  };
}
