/**
 * Frontend API layer for the knowledge endpoints served by the backend kb/
 * service (G2.S4). Mirrors the request/error conventions of `./chat.ts`.
 */

const KB_BASE = "/api/kb";

export interface KnowledgeGraphNode {
  id: string;
  label: string;
  type?: string;
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

export interface WikiTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: WikiTreeNode[];
}

export interface KnowledgeSearchResult {
  source: "lightrag" | "llmwiki";
  title: string;
  snippet: string;
  path?: string;
  score?: number;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`Request failed with status ${res.status}`);
  }
  return (await res.json()) as T;
}

/** GET /api/kb/graph?label= → LightRAG entity-relation graph. */
export async function getGraph(label?: string): Promise<KnowledgeGraph> {
  const params = new URLSearchParams();
  if (label) params.set("label", label);
  const query = params.toString();
  return request<KnowledgeGraph>(`${KB_BASE}/graph${query ? `?${query}` : ""}`);
}

/** GET /api/kb/wiki → llm_wiki wiki page tree (recursive). */
export async function getWikiTree(): Promise<WikiTreeNode[]> {
  const data = await request<{ files: WikiTreeNode[] }>(`${KB_BASE}/wiki`);
  return data.files;
}

/** GET /api/kb/wiki/page?path= → raw markdown of a wiki page. */
export async function readWikiPage(path: string): Promise<string> {
  const data = await request<{ content: string }>(
    `${KB_BASE}/wiki/page?path=${encodeURIComponent(path)}`,
  );
  return data.content;
}

/** POST /api/kb/search { query } → fused LightRAG + llm_wiki results. */
export async function searchKnowledge(query: string): Promise<KnowledgeSearchResult[]> {
  const data = await request<{ results: KnowledgeSearchResult[] }>(`${KB_BASE}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return data.results;
}
