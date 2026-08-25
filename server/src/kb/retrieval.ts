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
import { parseFrontmatter } from "./frontmatter.js";
import { defaultCodeOutputDir } from "./store/code.js";
import type { WikiFrontmatterSyncer } from "./wiki-frontmatter.js";
import type { SemanticMappingStore } from "./semantic-mappings.js";
import { expandTerms } from "./semantic-mappings.js";
import type {
  Neo4jRetrievalService,
  Neo4jSearchHit,
  Neo4jSearchResponse,
  RetrieverName,
} from "./store/retrieval.js";
import type {
  EntityDetail,
  EntityGraphService,
  EntityListEntry,
} from "./store/graph.js";

export type { EntityDetail, EntityListEntry } from "./store/graph.js";

export interface KnowledgeRetrievalOptions {
  llmwiki: LlmWikiClient;
  /** Neo4j lean RAG store retrieval (G4.S2.T5). It is the sole semantic + graph
   *  path (fused vector + BM25 + graph + topic, G4.S2.T7/T10) while llm_wiki
   *  stays the BM25 keyword source. When omitted, search returns keyword hits
   *  only and the graph is empty. */
  neo4j?: Neo4jRetrievalService;
  /** Neo4j entity-graph query service (G4.S8.T12): SE80-style code-object browser
   *  (listEntities + getEntity with wiki-page deep links). Built from the same
   *  driver when omitted and the store is wired. */
  entityGraph?: EntityGraphService;
  /** llm_wiki project id. When omitted, current/first project is used. */
  projectId?: string;
  /** llm_wiki wiki pages directory (project.path/wiki). When omitted, it is
   *  resolved from the project path returned by listProjects(). */
  wikiDir?: string;
  /** Override reading image bytes from disk (tests). */
  readFile?: (path: string) => Promise<Buffer>;
  /** Code-store output dir holding `<stem>/chunks.json` for code pages
   *  (G4.S8.T11 code-meta). Default: `defaultCodeOutputDir()`. */
  codeOutputDir?: string;
  /** Canonical wiki-frontmatter syncer (G4.S3.T1). Tracks read_count on BOTH
   *  the wiki frontmatter and the Neo4j Document node (write-through) whenever
   *  the retrieval service surfaces a page. Best-effort. */
  frontmatter?: WikiFrontmatterSyncer;
  /** Custom semantic mappings (G4.S3.T6): colloquial term → canonical, applied
   *  at search time so a colloquial query also recalls the canonical text. */
  mappings?: SemanticMappingStore;
  /** QA reference provider (G4.S3.T6): a matching stored Q&A is surfaced as
   *  reference context — the RAG search ALWAYS runs and never short-circuits. */
  qa?: QaReferenceProvider;
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
  /** The query after semantic-mapping expansion (G4.S3.T6), when it changed. */
  expandedQuery?: string;
  results: KnowledgeSearchResult[];
  /** A matching stored Q&A pair as REFERENCE context only (G4.S3.T6) — never a
   *  short-circuit answer; the RAG search always runs. */
  qaReference?: {
    id: string;
    question: string;
    answer: string;
    score: number;
  };
}

/** Anything that can vector-search the stored Q&A for a query-similar question. */
export interface QaReferenceProvider {
  findReference(question: string): Promise<{
    id: string;
    question: string;
    answer: string;
    score: number;
  } | null>;
}

interface ResolvedProject {
  id: string;
  /** Local wiki pages dir (project.path/wiki) for image byte reads. */
  wikiDir?: string;
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
  /** The channel-specific parsed metadata — `fields` (ddic), `sourceTables` /
   *  `associations` / `members` (cds), `dependencies` (abap), `references`
   *  (ui5). The frontend detects the DocType channel from these keys. */
  metadata: Record<string, unknown>;
}

/** Structured code metadata for a `type: code` wiki page (G4.S8.T11). Empty
 *  `chunks` means the page's chunks.json was not resolvable (fall back to the
 *  markdown renderer). */
export interface WikiCodeMeta {
  type: string;
  topic?: string;
  system?: string;
  devclass?: string;
  transport?: string;
  component?: string;
  chunks: WikiCodeMetaChunk[];
}

/** Keys carried by every RefinementChunk that are NOT code-channel metadata —
 *  stripped from a chunk's `metadata` object so it stays channel-specific. */
const CHUNK_BASE_KEYS = new Set(["id", "text", "heading_path", "path"]);

/** Map one stored RefinementChunk to the code-meta API shape: `metadata` holds
 *  the channel fields (everything except the base RefinementChunk keys). */
function mapCodeMetaChunk(raw: Record<string, unknown>): WikiCodeMetaChunk {
  const headingPath = typeof raw.heading_path === "string" ? raw.heading_path : "";
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (CHUNK_BASE_KEYS.has(key)) continue;
    metadata[key] = value;
  }
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    path: headingPath,
    heading_path: headingPath,
    ...(typeof raw.text === "string" ? { text: raw.text } : {}),
    metadata,
  };
}

export class KnowledgeRetrievalService {
  private readonly llmwiki: LlmWikiClient;
  private readonly neo4j?: Neo4jRetrievalService;
  private readonly entityGraph?: EntityGraphService;
  private readonly projectId?: string;
  private readonly wikiDir?: string;
  private readonly readFile: (path: string) => Promise<Buffer>;
  private readonly codeOutputDir: string;
  private readonly frontmatter?: WikiFrontmatterSyncer;
  private readonly mappings?: SemanticMappingStore;
  private readonly qa?: QaReferenceProvider;
  private resolved?: ResolvedProject;

  constructor(options: KnowledgeRetrievalOptions) {
    this.llmwiki = options.llmwiki;
    this.neo4j = options.neo4j;
    this.entityGraph = options.entityGraph;
    this.projectId = options.projectId;
    this.wikiDir = options.wikiDir;
    this.readFile = options.readFile ?? readFile;
    this.codeOutputDir = options.codeOutputDir ?? defaultCodeOutputDir();
    this.frontmatter = options.frontmatter;
    this.mappings = options.mappings;
    this.qa = options.qa;
  }

  /** GET /api/kb/graph → the entity-relation graph from the Neo4j store
   *  (G4.S2.T10). Empty when the store is not wired. */
  async getGraph(topic?: string): Promise<KnowledgeGraph> {
    if (!this.neo4j) return { nodes: [], edges: [] };
    const raw = await this.neo4j.getGraph(topic);
    return {
      nodes: raw.nodes.map((n) => ({
        id: n.id,
        label: n.label,
        ...(n.type ? { type: n.type } : {}),
      })),
      edges: raw.edges.map((e) => ({ source: e.source, target: e.target })),
    };
  }

  /** GET /api/kb/graph/entities?type=&q=&limit= → the code-object browsable
   *  entity list (G4.S8.T12). Empty when the graph query service is not wired
   *  (Neo4j not configured / not indexed). */
  async listEntities(
    options: { type?: string; q?: string; limit?: number } = {},
  ): Promise<EntityListEntry[]> {
    if (!this.entityGraph) return [];
    return this.entityGraph.listEntities(options);
  }

  /** GET /api/kb/graph/entities/:name → the entity + its Uses/Used-by relation
   *  lists with wiki-page deep links (G4.S8.T12). Null when the store is not
   *  wired, or the entity does not exist. */
  async getEntity(name: string): Promise<EntityDetail | null> {
    if (!this.entityGraph) return null;
    return this.entityGraph.getEntity(name);
  }

  /** GET /api/kb/graph/topics → distinct topics seen in wiki pages, sorted. */
  async getGraphTopics(): Promise<string[]> {
    const { id, wikiDir } = await this.resolveProject();
    const topics = new Set<string>();
    // Local-disk first: the wiki is a local directory — scan it directly so
    // big pages llm_wiki's HTTP API refuses (413) still contribute their
    // frontmatter topic (large-file fix).
    if (wikiDir) {
      const diskTopics = await scanTopicsFromDisk(wikiDir);
      for (const t of diskTopics) topics.add(t);
    }
    const pages = await this.llmwiki.listWikiPages(id);
    for (const page of pages) {
      if (page.topic) topics.add(page.topic);
    }
    return Array.from(topics).sort();
  }

  /** GET /api/kb/wiki → llm_wiki wiki page tree (recursive) with per-page
   *  frontmatter metadata (type + topic) so the frontend can group pages
   *  dynamically by view (Topic/Type/All) without duplicating files (G2.S5.T11). */
  async getWikiTree(): Promise<LlmWikiFileNode[]> {
    const { id, wikiDir } = await this.resolveProject();
    const [tree, pages] = await Promise.all([
      this.llmwiki.getFileTree(id, { root: "wiki", recursive: true }),
      this.llmwiki.listWikiPages(id),
    ]);
    const meta = new Map(pages.map((p) => [p.path, p]));
    // LARGE-FILE FIX: llm_wiki's listWikiPages silently drops pages over its
    // API size ceiling (413) — read frontmatter from disk for any page the
    // API missed, so big docs still get topic/type grouping in the wiki tree.
    if (wikiDir) {
      const diskMeta = await scanWikiMetadataFromDisk(wikiDir);
      for (const [path, fm] of diskMeta) {
        if (!meta.has(path)) meta.set(path, fm);
      }
    }
    return attachWikiMetadata(tree.files, meta);
  }

  /** GET /api/kb/wiki/page?path= → markdown content of a wiki page. */
  async readWikiPage(path: string): Promise<WikiPage> {
    const { id, wikiDir } = await this.resolveProject();
    // LARGE-FILE FIX: the wiki is a local directory; read it straight from
    // disk for the display layer instead of round-tripping through llm_wiki's
    // HTTP API, which 413s on big pages (e.g. 2.4MB Group Reporting). The
    // llm_wiki client remains the fallback for projects without a local dir.
    const disk = wikiDir ? await readWikiFileFromDisk(wikiDir, path) : null;
    const page = disk ?? (await this.llmwiki.readFile(id, path));
    await this.trackReadCount(path);
    return page;
  }

  /**
   * G4.S8.T17: raw page markdown WITHOUT the read_count side effect — the
   * review-state service re-reads the page on every fetch/apply and must not
   * inflate the popularity counter as a side effect of a review action.
   */
  async readWikiPageRaw(path: string): Promise<string> {
    const { id, wikiDir } = await this.resolveProject();
    const disk = wikiDir ? await readWikiFileFromDisk(wikiDir, path) : null;
    const page = disk ?? (await this.llmwiki.readFile(id, path));
    return page.content;
  }

  /**
   * G4.S8.T11 `GET /api/kb/wiki/code-meta?path=` → the page's structured code
   * metadata resolved from its stored `chunks_ref`.
   *
   * Chunks-ref resolution (documented, the approach the route uses): the code
   * store façades write `<CODE_OUTPUT_DIR>/<stem>/chunks.json` next to
   * `markdown.md`, where `stem` is the source object's slugified name — which
   * is exactly the wiki page FILE stem (the ingest runner builds both
   * `fileName = <stem>.md` and the storage `stem` from the same slugify). So a
   * wiki page `wiki/code/<system>/mara.md` maps to
   * `<CODE_OUTPUT_DIR>/mara/chunks.json`. We use this convention (no Neo4j
   * lookup needed) and read the file through the injected `readFile`.
   *
   * Returns `null` when the page does not exist or is not a `type: code` page
   * (route → 404). A code page whose `chunks.json` is unreadable reports empty
   * `chunks` so the frontend falls back to markdown rendering.
   */
  async getWikiCodeMeta(path: string): Promise<WikiCodeMeta | null> {
    const { id } = await this.resolveProject();
    let page: { path: string; content: string };
    try {
      page = await this.llmwiki.readFile(id, path);
    } catch {
      // missing page / llm_wiki refuse → 404
      return null;
    }
    const fm = parseFrontmatter(page.content);
    if (fm.type !== "code") return null;

    const stem = path.split("/").pop()?.replace(/\.md$/i, "") ?? "";
    let chunks: WikiCodeMetaChunk[] = [];
    if (stem) {
      try {
        const raw = JSON.parse((await this.readFile(join(this.codeOutputDir, stem, "chunks.json"))).toString("utf8"));
        if (Array.isArray(raw)) {
          chunks = raw
            .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
            .map(mapCodeMetaChunk);
        }
      } catch {
        // chunks.json missing/unreadable → empty chunks (markdown fallback)
      }
    }
    return {
      type: "code",
      ...(fm.topic ? { topic: fm.topic } : {}),
      ...(fm.system ? { system: fm.system } : {}),
      ...(fm.devclass ? { devclass: fm.devclass } : {}),
      ...(fm.transport ? { transport: fm.transport } : {}),
      ...(fm.component ? { component: fm.component } : {}),
      chunks,
    };
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
   *
   * G4.S3.T6: the query is first expanded through the semantic-mapping table
   * (colloquial → canonical, feeding BOTH the Neo4j search and the llm_wiki
   * keyword search), and a matching stored Q&A pair is surfaced as
   * `qaReference` — reference context only, never a short-circuit.
   *
   * G4.S3.T7.3: `retriever` (agentic picker) forwards the chosen retriever to
   * the Neo4j store — it runs ONLY that retriever instead of the fused search.
   * When unset the fused (vector+BM25+graph) search runs as before.
   */
  async search(
    query: string,
    options: { topic?: string; retriever?: RetrieverName; scope?: "local" | "global" } = {},
  ): Promise<KnowledgeSearchResponse> {
    const expandedQuery = await this.expandQuery(query);
    const results: KnowledgeSearchResult[] = [];
    const project = await this.resolveProject();

    // G4.S9.T3 global scope: corpus-level QA over community summaries + member
    // chunks. Runs ONLY the Neo4j global path — llm_wiki keyword hits are a
    // document-level source that would pollute the corpus-level answer.
    if (options.scope === "global") {
      if (!this.neo4j) {
        return { query, results };
      }
      const global = await this.neo4j.search(expandedQuery, {
        scope: "global",
        topK: 5,
        ...(options.retriever ? { retriever: options.retriever } : {}),
      });
      for (const hit of global.hits) {
        results.push(mapNeo4jHit(hit));
      }
      await this.trackSurfacePages(results);
      const qaReference = this.qa ? await this.qa.findReference(query).catch(() => undefined) : undefined;
      return {
        query,
        ...(expandedQuery !== query ? { expandedQuery } : {}),
        results,
        ...(qaReference ? { qaReference } : {}),
      };
    }

    const scope = options.topic ? await this.loadScope(options.topic, project.id) : undefined;
    const [neo4jResult, wiki] = await Promise.allSettled([
      this.neo4j
        ? this.neo4j.search(expandedQuery, {
            ...(scope ? { topics: scope.topics } : {}),
            topK: 5,
            enrichContext: true,
            ...(options.retriever ? { retriever: options.retriever } : {}),
          })
        : Promise.resolve(null),
      this.llmwiki.search(project.id, expandedQuery, { topK: 5 }),
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

    const qaReference = this.qa ? await this.qa.findReference(query) : undefined;
    return {
      query,
      ...(expandedQuery !== query ? { expandedQuery } : {}),
      results,
      ...(qaReference ? { qaReference } : {}),
    };
  }

  /** Apply the custom semantic-mapping table to a query (G4.S3.T6): replace every
   *  colloquial term with its canonical form. Best-effort: a mapping-store
   *  failure keeps the query untouched. */
  private async expandQuery(query: string): Promise<string> {
    if (!this.mappings) return query;
    try {
      const mappings = await this.mappings.list();
      if (mappings.length === 0) return query;
      return expandTerms(query, mappings);
    } catch {
      return query;
    }
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
 *  context, so the title shows "Entity → neighbor, …" instead of the chunk id.
 *  G4.S9.T3: community-summary hits (global scope) title from their theme. */
function mapNeo4jHit(hit: Neo4jSearchHit): KnowledgeSearchResult {
  const title =
    hit.communityId !== undefined
      ? hit.topic
        ? `Community: ${hit.topic}`
        : `Community ${hit.communityId}`
      : hit.source === "graph" && hit.related?.length
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

/** Attach frontmatter type/topic metadata + code lineage to each file node. */
function attachWikiMetadata(
  nodes: LlmWikiFileNode[],
  meta: Map<string, { type?: string; topic?: string; system?: string; devclass?: string; transport?: string; component?: string }>,
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
      ...(page.system ? { system: page.system } : {}),
      ...(page.devclass ? { devclass: page.devclass } : {}),
      ...(page.transport ? { transport: page.transport } : {}),
      ...(page.component ? { component: page.component } : {}),
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


/**
 * Read a wiki page file directly from the on-disk wiki directory.
 * Path-traversal-safe: only resolves under wikiDir, strips a leading wiki/.
 * Returns null when the file does not exist on disk so callers fall back.
 */
async function readWikiFileFromDisk(
  wikiDir: string,
  path: string,
): Promise<{ path: string; content: string } | null> {
  const relative = path.startsWith("wiki/") ? path.slice("wiki/".length) : path;
  if (relative.includes("..") || relative.includes("\\") || relative.startsWith("/")) {
    return null;
  }
  const full = join(wikiDir, relative);
  try {
    const content = await readFile(full, "utf-8");
    return { path, content };
  } catch {
    return null;
  }
}


/**
 * Recursively scan the on-disk wiki directory for *.md files and collect
 * their frontmatter `topic:` values without touching llm_wiki (which 413s
 * on large pages). Skips unreadable files.
 */
async function scanTopicsFromDisk(wikiDir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const topics = new Set<string>();
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.name.endsWith(".md")) {
        try {
          const content = await readFile(full, "utf-8");
          const fm = parseFrontmatter(content);
          if (fm.topic) topics.add(fm.topic);
        } catch {
          // unreadable → skip
        }
      }
    }
  };
  await walk(wikiDir);
  return Array.from(topics);
}


/**
 * Scan the on-disk wiki directory for *.md frontmatter (topic/type/etc.),
 * returning a path → metadata map. Complements llm_wiki's listWikiPages for
 * pages its HTTP API refuses (large files).
 */
async function scanWikiMetadataFromDisk(
  wikiDir: string,
): Promise<Map<string, { path: string; type?: string; topic?: string }>> {
  const { readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const meta = new Map<string, { path: string; type?: string; topic?: string }>();
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(full, childRel);
      } else if (e.name.endsWith(".md")) {
        try {
          const content = await readFile(full, "utf-8");
          const fm = parseFrontmatter(content);
          meta.set(`wiki/${childRel}`, {
            path: `wiki/${childRel}`,
            ...(fm.type ? { type: fm.type } : {}),
            ...(fm.topic ? { topic: fm.topic } : {}),
          });
        } catch {
          // unreadable → skip
        }
      }
    }
  };
  await walk(wikiDir, "");
  return meta;
}

