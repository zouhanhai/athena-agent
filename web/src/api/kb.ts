/**
 * Frontend API layer for the knowledge endpoints served by the backend kb/
 * service (G2.S4). Mirrors the request/error conventions of `./chat.ts`.
 */

const KB_BASE = "/api/kb";

export interface KnowledgeGraphNode {
  id?: string;
  label?: string;
  type?: string;
  /** Source file the node was extracted from. */
  filePath?: string;
}

export interface KnowledgeGraphEdge {
  source?: string;
  target?: string;
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
  /** Frontmatter `type` of a wiki page (entity/concept/...). */
  type?: string;
  /** Frontmatter `topic` of a wiki page (may be a slash path, e.g. "sap/fiori"). */
  topic?: string;
  /** True for heading-outline entries under a selected wiki file (G3.S5.T6). */
  isHeading?: boolean;
  /** Heading level (1..3) of a heading-outline entry (G3.S5.T6). */
  level?: number;
  /** Slugified heading id a heading-outline entry scrolls to (G3.S5.T6). */
  anchorId?: string;
  children?: WikiTreeNode[];
}

export interface KnowledgeSearchResult {
  source: "llmwiki" | "neo4j";
  title: string;
  snippet: string;
  path?: string;
  score?: number;
  /** Wiki page path of a neo4j chunk hit (RAG↔Wiki fusion, G4.S2.T11). */
  wikiPath?: string;
  /** Heading path of a neo4j chunk hit's Section. */
  sectionPath?: string;
  /** Same-section sibling chunk texts (context enrichment, G4.S2.T11). */
  siblings?: string[];
}

export type TaskStageName = "parsing" | "refinement" | "ingesting_llmwiki" | "ingesting_neo4j";
export type StageStatus = "pending" | "running" | "done" | "failed";
export type TaskStatus = "pending" | "parsing" | "refining" | "ingesting" | "done" | "failed";

/** Per-system sub-step (G3.S5.T2): docling / llm_wiki / Neo4j phases. */
export interface IngestTaskStep {
  name: string;
  status: StageStatus;
  error?: string;
}

export interface IngestTaskStage {
  name: TaskStageName;
  status: StageStatus;
  error?: string;
  steps: IngestTaskStep[];
}

export interface IngestTask {
  id: string;
  source: string;
  status: TaskStatus;
  progress: number;
  stages: {
    parsing: IngestTaskStage;
    refinement: IngestTaskStage;
    ingesting_llmwiki: IngestTaskStage;
    ingesting_neo4j: IngestTaskStage;
  };
  documentId?: string;
  error?: string;
  /** Athena refinement small ref (G4.S1.T4): type/topic + entities/keywords
   *  injected for the G4.S2 RAG self-build. */
  refinement?: {
    md_ref?: string;
    chunks_ref?: string;
    preview?: string;
    chunk_count?: number;
    frontmatter?: { type: string; topic: string };
    entities?: { name: string; type: string; description: string }[];
    keywords?: string[];
    quality?: { complete: boolean; confidence: number; issues: string[]; action: "auto_accept" | "review_required" };
    mode?: "single" | "two-stage";
  };
  /** Operator-review flag (G4.S1.T5): set when Athena refinement emitted
   *  quality.action=review_required, or refinement failed and the raw docling
   *  output was used. The Uploads list shows a review badge for such tasks. */
  reviewRequired?: boolean;
  /** Content dedup outcome (G2.S5.T14): set when the doc was skipped as a duplicate. */
  dedup?: {
    duplicate: boolean;
    method?: "hash" | "chunks";
    existingSource?: string;
  };
  createdAt: number;
  updatedAt: number;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`Request failed with status ${res.status}`);
  }
  return (await res.json()) as T;
}

/** GET /api/kb/graph → Neo4j entity-relation graph. */
export async function getGraph(label?: string, topic?: string): Promise<KnowledgeGraph> {
  const params = new URLSearchParams();
  if (label) params.set("label", label);
  if (topic) params.set("topic", topic);
  const query = params.toString();
  return request<KnowledgeGraph>(`${KB_BASE}/graph${query ? `?${query}` : ""}`);
}

/** GET /api/kb/graph/topics → distinct topics available for graph filtering. */
export async function getGraphTopics(): Promise<string[]> {
  const data = await request<{ topics: string[] }>(`${KB_BASE}/graph/topics`);
  return data.topics;
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

/** POST /api/kb/doc/delete { path } → delete a wiki page. */
export async function deleteWikiDoc(path: string): Promise<{
  ok: boolean;
  llmwiki?: { path?: string; error?: string };
}> {
  return request(`${KB_BASE}/doc/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

/** POST /api/kb/search { query, topic? } → fused retrieval results
 *  (Neo4j vector+BM25+graph+topic when the RAG store is wired) +
 *  llm_wiki keyword hits. */
export async function searchKnowledge(query: string, topic?: string): Promise<KnowledgeSearchResult[]> {
  const data = await request<{ results: KnowledgeSearchResult[] }>(`${KB_BASE}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, ...(topic ? { topic } : {}) }),
  });
  return data.results;
}

/** POST /api/kb/ingest (multipart file) → 202 { taskId }. */
export async function ingestFile(file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const data = await request<{ taskId: string }>(`${KB_BASE}/ingest`, {
    method: "POST",
    body: form,
  });
  return data.taskId;
}

/** POST /api/kb/ingest-url { url } → 202 { taskId }. */
export async function ingestUrl(url: string): Promise<string> {
  const data = await request<{ taskId: string }>(`${KB_BASE}/ingest-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  return data.taskId;
}

/** GET /api/kb/task/:id → poll an ingestion task's status. */
export async function getTask(taskId: string): Promise<IngestTask> {
  return request<IngestTask>(`${KB_BASE}/task/${encodeURIComponent(taskId)}`);
}

/** POST /api/kb/ingest/retry { taskId } → re-run failed stages, returns updated task. */
export async function retryTask(taskId: string): Promise<IngestTask> {
  return request<IngestTask>(`${KB_BASE}/ingest/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId }),
  });
}
