/**
 * LightRagClient - thin HTTP client for the LightRAG API server (:9621).
 *
 * Encapsulates the endpoints used by the athena knowledge access layer:
 * health, text ingestion, semantic query, and knowledge-graph export.
 */

export interface LightRagOptions {
  /** Base URL of the LightRAG server. Default: http://127.0.0.1:9621 */
  baseUrl?: string;
  /** Optional bearer token for the LightRAG API. Default: none (auth disabled). */
  token?: string;
  /** Injectable fetch implementation for unit tests. */
  fetchImpl?: typeof fetch;
}

export interface LightRagHealth {
  status: string;
  [key: string]: unknown;
}

export interface LightRagInsertResult {
  status: string;
  message: string;
  track_id?: string;
}

export interface LightRagReference {
  reference_id: string;
  file_path: string;
  content?: string[];
}

export interface LightRagQueryResult {
  response: string;
  references?: LightRagReference[];
  response_time?: number;
}

export interface LightRagGraphNode {
  id?: string;
  label?: string;
  type?: string;
  /** Source file the node was extracted from (may be top-level or nested). */
  file_path?: string;
  properties?: {
    file_path?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface LightRagGraphEdge {
  source?: string;
  target?: string;
  weight?: number;
  [key: string]: unknown;
}

export interface LightRagGraphResult {
  nodes: LightRagGraphNode[];
  edges: LightRagGraphEdge[];
  is_truncated?: boolean;
}

export interface LightRagQueryOptions {
  /** Retrieval mode. Default: "hybrid" (local + global). */
  mode?: "local" | "global" | "hybrid" | "naive" | "mix" | "bypass";
  /** Number of top results to retrieve. */
  topK?: number;
  /** Include retrieved chunk text in references (useful for verification). */
  includeChunkContent?: boolean;
}

export interface LightRagGraphOptions {
  /** Maximum depth of the subgraph. Default: 3. */
  maxDepth?: number;
  /** Maximum nodes to return. Default: 1000. */
  maxNodes?: number;
}

export interface LightRagDocument {
  id: string;
  file_path?: string;
  status?: string;
}

export interface LightRagDeleteResult {
  status?: string;
  message?: string;
}

export class LightRagClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LightRagOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.LIGHTRAG_API_BASE_URL ?? "http://127.0.0.1:9621").replace(/\/+$/, "");
    this.token = options.token ?? process.env.LIGHTRAG_API_TOKEN;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** GET /health - service liveness. */
  async getHealth(): Promise<LightRagHealth> {
    return this.request("/health", { auth: false });
  }

  /** POST /documents/text - enqueue text for chunking + indexing. */
  async ingestText(text: string, options: { fileSource?: string } = {}): Promise<LightRagInsertResult> {
    const body: Record<string, unknown> = { text };
    if (options.fileSource) {
      body.file_source = options.fileSource;
    }
    return this.request("/documents/text", { method: "POST", body });
  }

  /** POST /query - semantic retrieval with LLM-grounded answer. */
  async query(query: string, options: LightRagQueryOptions = {}): Promise<LightRagQueryResult> {
    const body: Record<string, unknown> = { query, mode: options.mode ?? "hybrid" };
    if (options.topK !== undefined) body.top_k = options.topK;
    if (options.includeChunkContent) body.include_chunk_content = true;
    return this.request("/query", { method: "POST", body });
  }

  /** GET /graphs?label=X - export the entity-relation knowledge graph subgraph. */
  async getGraph(label: string, options: LightRagGraphOptions = {}): Promise<LightRagGraphResult> {
    const params = new URLSearchParams({ label });
    if (options.maxDepth !== undefined) params.set("max_depth", String(options.maxDepth));
    if (options.maxNodes !== undefined) params.set("max_nodes", String(options.maxNodes));
    return this.request(`/graphs?${params.toString()}`);
  }

  /** GET /documents - list all documents across statuses (flattened). */
  async listDocuments(): Promise<LightRagDocument[]> {
    const json = await this.request("/documents");
    const statuses = (json.statuses ?? {}) as Record<string, unknown[]>;
    const docs: LightRagDocument[] = [];
    for (const list of Object.values(statuses)) {
      if (!Array.isArray(list)) continue;
    for (const item of list) {
      const obj = item as Record<string, unknown>;
      const id = typeof obj.id === "string" ? obj.id : "";
      if (!id) continue;
      docs.push({
        id,
        ...(typeof obj.file_path === "string" && obj.file_path ? { file_path: obj.file_path } : {}),
        ...(typeof obj.status === "string" && obj.status ? { status: obj.status } : {}),
      });
    }
    }
    return docs;
  }

  /**
   * DELETE /documents/delete_document - remove a doc and all its associated
   * data (status, chunks, vector embeddings, graph). Runs in the background;
   * also purges cached LLM extraction results by default so a re-upload of the
   * same file does not hit the "already contains" conflict.
   */
  async deleteDocument(
    docId: string,
    options: { deleteFile?: boolean; deleteLlmCache?: boolean } = {},
  ): Promise<LightRagDeleteResult> {
    return this.request("/documents/delete_document", {
      method: "DELETE",
      body: {
        doc_ids: [docId],
        delete_file: options.deleteFile ?? false,
        delete_llm_cache: options.deleteLlmCache ?? true,
      },
    });
  }

  private async request(
    path: string,
    options: { method?: "GET" | "POST" | "DELETE"; body?: unknown; auth?: boolean } = {},
  ): Promise<any> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.auth !== false && this.token?.trim()) {
      headers.Authorization = `Bearer ${this.token.trim()}`;
    }
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const text = await response.text();
    let json: Record<string, unknown>;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }

    if (!response.ok) {
      const detail = typeof json.detail === "string" ? json.detail : typeof json.detail === "object" ? JSON.stringify(json.detail) : undefined;
      const message = detail ?? (typeof json.error === "string" ? json.error : response.statusText);
      throw new Error(`LightRAG API ${response.status}: ${message}`);
    }
    return json;
  }
}
