/**
 * Frontend API layer for the knowledge endpoints served by the backend kb/
 * service (G2.S4). Mirrors the request/error conventions of `./chat.ts`.
 */

import type { QaPair, QaSource } from "./feedback";

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

/** A matching stored Q&A pair surfaced as reference context (G4.S3.T6) — the
 *  RAG search always runs and never short-circuits to this answer. */
export interface QaReference {
  id: string;
  question: string;
  answer: string;
  score: number;
}

export interface KnowledgeSearchResponse {
  query: string;
  expandedQuery?: string;
  results: KnowledgeSearchResult[];
  qaReference?: QaReference;
}

/** Custom semantic mapping (G4.S3.T6): colloquial/company term → one or more
 *  canonical forms. Input accepts comma- or `/`-separated values; the store
 *  keeps them as an array and query expansion ORs them. */
export interface SemanticMapping {
  id: string;
  term: string;
  canonicals: string[];
  created_at: string;
  updated_at: string;
}

/** How a manual Q&A entry resolved against a vector-similar stored pair. */
export interface ManualAddResult {
  pair: QaPair | null;
  similar?: { id: string; question: string; score: number };
  action: "inserted" | "merged" | "overwritten" | "added_anyway" | "needs_decision";
}

export type ManualQaMode = "merge" | "overwrite" | "add-anyway";

export type TaskStageName = "parsing" | "refinement" | "ingesting_llmwiki" | "ingesting_neo4j";
export type StageStatus = "pending" | "running" | "done" | "failed";
export type TaskStatus = "pending" | "parsing" | "refining" | "ingesting" | "done" | "failed";

/** Per-system sub-step (G3.S5.T2): docling / llm_wiki / Neo4j phases. */
export interface IngestTaskStep {
  name: string;
  status: StageStatus;
  error?: string;
  /** Live sub-step progress text (G4.S3.T9): the Neo4j embed_store step carries
   *  "X/Y" while chunks embed (rendered as "embed store: 5/16"). */
  progress?: string;
}

export interface IngestTaskStage {
  name: TaskStageName;
  status: StageStatus;
  error?: string;
  steps: IngestTaskStep[];
  /** Neo4j chunk ingest progress (G4.S3.T8): chunks embedded + stored so far
   *  vs the total, plus the 0..1 fraction. Present on the ingesting_neo4j stage
   *  while it runs and kept once it completes. */
  chunksStored?: number;
  chunksTotal?: number;
  progress?: number;
  /** Chunk progress aliases (G4.S3.T9): processed/total mirror chunksStored/
   *  chunksTotal so the ETA reads (total - processed) × avg ms per chunk. */
  processed?: number;
  total?: number;
  /** Rolling ETA (ms) for the remaining chunks, set by the server while total > 0. */
  etaMs?: number;
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

/** PUT /api/kb/wiki/page { path, content } → save a corrected wiki page
 *  (G4.S3.T10). `content` is the FULL page markdown (frontmatter + body +
 *  image refs). Returns the background task id + diff metadata; poll
 *  GET /api/kb/task/:id for the diff-refine + RAG overwrite progress. */
export async function saveWikiPage(
  path: string,
  content: string,
): Promise<{ taskId: string; saved: boolean; diff: { changed: boolean; structural: boolean } }> {
  return request(`${KB_BASE}/wiki/page`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, content }),
  });
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

/** POST /api/kb/search → full response including the expanded query + any QA
 *  reference (G4.S3.T6): term query expansion + QA reference, never short-circuit. */
export async function searchKnowledgeFull(query: string, topic?: string): Promise<KnowledgeSearchResponse> {
  return request<KnowledgeSearchResponse>(`${KB_BASE}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, ...(topic ? { topic } : {}) }),
  });
}

/** GET /api/kb/mappings → the stored semantic mappings (G4.S3.T6). */
export async function listSemanticMappings(): Promise<SemanticMapping[]> {
  const data = await request<{ mappings: SemanticMapping[] }>(`${KB_BASE}/mappings`);
  return data.mappings;
}

/** POST /api/kb/mappings { term, canonical } → upsert a semantic mapping.
 *  `canonical` may be comma- or `/`-separated to map a term to MULTIPLE
 *  canonical forms (one-to-many, G4.S3.T6). */
export async function addSemanticMapping(term: string, canonical: string): Promise<SemanticMapping> {
  const data = await request<{ mapping: SemanticMapping }>(`${KB_BASE}/mappings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ term, canonical }),
  });
  return data.mapping;
}

/** DELETE /api/kb/mappings/:id → remove a semantic mapping. */
export async function deleteSemanticMapping(id: string): Promise<boolean> {
  await request<{ ok: boolean }>(`${KB_BASE}/mappings/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return true;
}

/** POST /api/kb/qa/manual { question, answer, sources?, mode? } → manual Q&A
 *  entry (G4.S3.T6). Without a mode a vector-similar match returns
 *  `needs_decision` so the UI can offer merge / overwrite / add-anyway. */
export async function addManualQa(input: {
  question: string;
  answer: string;
  sources?: QaSource[];
  mode?: ManualQaMode;
}): Promise<ManualAddResult> {
  return request<ManualAddResult>(`${KB_BASE}/qa/manual`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** DELETE /api/kb/qa/:id → delete a stored Q&A pair. */
export async function deleteQaPair(id: string): Promise<boolean> {
  await request<{ ok: boolean }>(`${KB_BASE}/qa/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return true;
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
