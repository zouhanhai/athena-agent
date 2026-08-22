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
  /** Code lineage (G4.S8.T11): `system`/`devclass`/`transport`/`component`
   *  parsed from a code page's embedded frontmatter — the topic tree groups
   *  code pages under `code/<system>/<devclass|component>/`. */
  system?: string;
  devclass?: string;
  transport?: string;
  component?: string;
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
    /** G4.S8.T17: structured review issues (quality.json mirror) — message +
     *  heading path per issue, shown in the Uploads task detail. */
    refinement_issues?: WikiReviewIssue[];
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
  // G4.S3.T10: RBAC-gated KB writes (saveWikiPage) need the session token; attach
  // it from localStorage when present so save/delete work for authenticated users.
  const headers = new Headers(init?.headers ?? {});
  const token = localStorage.getItem("athena.session_token");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
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

/** One chunk of a code page's structured metadata (G4.S8.T11). */
export interface WikiCodeMetaChunk {
  /** Chunk id from the stored RefinementChunk (e.g. `ddic-1`, `cds-1`). */
  id: string;
  /** The chunk's location path — its `heading_path` (<TABLE>/_header, ...). */
  path: string;
  heading_path?: string;
  /** The chunk's raw text (DDL source for cds, unit/field text otherwise). */
  text?: string;
  /** Channel-specific parsed metadata — `fields` (ddic), `sourceTables` /
   *  `associations` / `members` (cds), `dependencies` (abap), `references`
   *  (ui5). The frontend detects the DocType channel from these keys. */
  metadata: Record<string, unknown>;
}

/** Structured code metadata for a `type: code` wiki page (G4.S8.T11). */
export interface WikiCodeMeta {
  type: string;
  topic?: string;
  system?: string;
  devclass?: string;
  transport?: string;
  component?: string;
  chunks: WikiCodeMetaChunk[];
}

/** GET /api/kb/wiki/code-meta?path= → the page's structured code metadata
 *  resolved from its stored chunks_ref. Throws 404 when the page is missing or
 *  not a code page. */
export async function getWikiCodeMeta(path: string): Promise<WikiCodeMeta> {
  return request<WikiCodeMeta>(
    `${KB_BASE}/wiki/code-meta?path=${encodeURIComponent(path)}`,
  );
}

// --- G4.S8.T17: per-page review workflow (quality gate issues) ---

/** One structured review issue (mirror of the server's quality.json entry). */
export interface WikiReviewIssue {
  id: string;
  message: string;
  anchor?: { quote: string; heading_path?: string };
  resolved: boolean;
  note?: string;
}

/** A review issue plus the server-side anchor validation verdict for this fetch:
 *  unanchored issues no longer match the page content (likely edited since) and
 *  are surfaced in the banner only — never dropped. */
export type WikiReviewIssueView = WikiReviewIssue & { anchored: boolean };

export interface WikiReviewStateView {
  path: string;
  review?: "required" | "clear";
  review_count: number;
  issues: WikiReviewIssueView[];
}

/** GET /api/kb/wiki/review-state?path= → the page's review gate state with
 *  anchors re-validated against the CURRENT content. */
export async function getWikiReviewState(path: string): Promise<WikiReviewStateView> {
  return request<WikiReviewStateView>(
    `${KB_BASE}/wiki/review-state?path=${encodeURIComponent(path)}`,
  );
}

/** POST /api/kb/wiki/review-state { path, issueId, action, note? } → flip one
 *  issue's resolved state; persists quality.json + frontmatter review fields. */
export async function updateWikiReviewState(
  path: string,
  issueId: string,
  action: "resolve" | "reopen",
  note?: string,
): Promise<WikiReviewStateView> {
  return request<WikiReviewStateView>(`${KB_BASE}/wiki/review-state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, issueId, action, ...(note ? { note } : {}) }),
  });
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

// --- G4.S8.T12: code-object browser graph queries -----------------------------

/** One entity in the code browser's left list (GET /api/kb/graph/entities). */
export interface CodeObjectEntity {
  name: string;
  type?: string;
  description?: string;
}

/** One Uses / Used-by relation entry (GET /api/kb/graph/entities/:name). */
export interface CodeObjectRelation {
  /** The relationship keyword(s) (e.g. READS_FROM / CALLS / BINDS_TO). */
  keywords: string[];
  description?: string;
  /** The counterpart entity name (target for Uses, source for Used by). */
  entity: string;
  type?: string;
  /** Wiki page path(s) whose chunks mention the counterpart — deep-link targets.
   *  Empty when none resolve (render without a link). */
  wikiPaths: string[];
}

/** Full detail for one selected code object (GET /api/kb/graph/entities/:name). */
export interface CodeObjectDetail {
  name: string;
  type?: string;
  description?: string;
  /** Edges where this entity is the source: what it USES. */
  outgoing: CodeObjectRelation[];
  /** Edges where this entity is the target: what USES it (WHERE-USED). */
  incoming: CodeObjectRelation[];
}

/** GET /api/kb/graph/entities?type=&q=&limit= → code objects filtered by type
 *  and a case-insensitive name substring (SE80-style browser, G4.S8.T12). */
export async function listCodeObjects(options: {
  type?: string;
  q?: string;
  limit?: number;
} = {}): Promise<CodeObjectEntity[]> {
  const params = new URLSearchParams();
  if (options.type) params.set("type", options.type);
  if (options.q) params.set("q", options.q);
  if (options.limit) params.set("limit", String(options.limit));
  const query = params.toString();
  const data = await request<{ entities: CodeObjectEntity[] }>(
    `${KB_BASE}/graph/entities${query ? `?${query}` : ""}`,
  );
  return data.entities;
}

/** GET /api/kb/graph/entities/:name → one object + its Uses/Used-by relation
 *  lists with wiki-page deep links (G4.S8.T12). Throws 404 when unknown. */
export async function getCodeObject(name: string): Promise<CodeObjectDetail> {
  return request<CodeObjectDetail>(`${KB_BASE}/graph/entities/${encodeURIComponent(name)}`);
}

// --- Knowledge-base audit (G4.S8.T15) ----------------------------------------

export type KbAuditTrigger = "scheduled" | "manual";

/** Stage-2 outcome of an audit run (graph vs disk repairs). */
export interface KbAuditFileCheck {
  repaired: number;
  details: string[];
}

/** Stage-3 outcome: the orphan refinement sweep. */
export interface KbAuditOrphanSweep {
  scannedDirs: number;
  removed: string[];
  kept: string[];
}

export interface KbAuditReport {
  id?: string;
  trigger: KbAuditTrigger;
  startedAt: string;
  durationMs: number;
  review: {
    runAt: string;
    scanned: number;
    changed: number;
    archive: string[];
    results: Array<{ path: string; action: string; reason: string }>;
  };
  fileCheck: KbAuditFileCheck;
  orphans: KbAuditOrphanSweep;
}

/** Error carrying the HTTP status so the UI can special-case 409 (a run is
 *  already in progress) and 401/403. */
export class KbAuditHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function auditRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  const token = localStorage.getItem("athena.session_token");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    throw new KbAuditHttpError(res.status, `Request failed with status ${res.status}`);
  }
  return (await res.json()) as T;
}

/** POST /api/kb/audit → run the full audit pipeline now (admin-gated). Rejects
 *  with KbAuditHttpError(409) while another run is in progress. */
export async function runKbAudit(): Promise<KbAuditReport> {
  const data = await auditRequest<{ report: KbAuditReport }>(`${KB_BASE}/audit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  return data.report;
}

/** GET /api/kb/audit/reports?limit= → recent runs, newest first (scheduled AND
 *  manual). */
export async function listKbAuditReports(limit = 20): Promise<KbAuditReport[]> {
  const data = await auditRequest<{ reports: KbAuditReport[] }>(
    `${KB_BASE}/audit/reports?limit=${limit}`,
  );
  return data.reports;
}
