/**
 * IngestTaskQueue + IngestCoordinator - async ingestion task tracking (G2.S5.T2).
 *
 * In-memory queue (POC) that drives the full pipeline for one source:
 *   docling parsing → llm_wiki ingesting + Neo4j ingesting → done / failed.
 * Per-system stage status is tracked independently, so a task can finish with
 * llm_wiki ok but Neo4j failed (and vice versa).
 */
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { basename, dirname, relative } from "node:path";
import type { DoclingParser } from "./docling.js";
import type { KnowledgeIngestService, SystemIngestStatus } from "./ingest.js";
import type { LlmWikiStepName } from "./ingest.js";
import { documentIdFrom, classificationFromRefinement, extractPageTitle, stemTitle, categoryDir } from "./ingest.js";
import type { WikiClassification, WikiCategory } from "./llmwiki.js";
import { isValidTopic, WIKI_CATEGORIES } from "./llmwiki.js";
import type { RefineOutputRef } from "../agents/refine-output.js";
import { countQualityIssues, deriveStemWithFileName, storeRefinementOutput } from "../agents/refine-output.js";
import {
  defaultRefinementOutputDir,
  fallbackWikiEditRefinement,
  type RefinementEntity,
  type RefinementRelation,
} from "../agents/refine-document.js";
import type { ContentDedupStore } from "./dedup.js";
import type { WikiFrontmatterSyncer } from "./wiki-frontmatter.js";
import type { Neo4jIngestService } from "./store/ingest.js";
import type { Neo4jCommunityService, CommunityRefreshTrigger } from "./store/community.js";
import type { Neo4jCommunitySummaryService } from "./store/community-summary.js";
import { parseCdsViews, type CdsView } from "./codeparse/cds.js";
import { parseAbapUnits, type AbapUnit } from "./codeparse/abap.js";
import { parseUi5Units, type Ui5Unit } from "./codeparse/ui5.js";
import { parseDdicTables, type DdicTable } from "./codeparse/ddic.js";
import { storeCodeOutput, renderCodeMarkdown, storeAbapOutput, renderAbapMarkdown, storeUi5Output, renderUi5Markdown, type CodeProvenance } from "./store/code.js";
import { storeDdicOutput, renderDdicMarkdown } from "./store/ddic.js";

/** Athena refinement runner (G4.S1.T4): one full-doc LLM pass, returns the small
 *  big-output ref + the full re-leveled markdown for downstream consumption.
 *  Injected so tests can fake the LLM pass; the default uses refine_document.
 *  `markdown` is File A′ (refined headers + image refs — llm_wiki); `ragMarkdown`
 *  is File B (refined text-only — the RAG working copy, G4.S1.T6). */
export type Refiner = (
  markdown: string,
  topicHint?: string,
  /** G4.S8.T18: upload file name — keeps the refine storage stem name-derived. */
  fileName?: string,
  /**
   * G4.S10.T6: docling-detected outline (PDF bookmark layer) — parsed from the
   * `<stem>.outline.json` sidecar by `DoclingParser.parse`. Fed to the refine's
   * `pdf-outline` header-grading source for TOC-first grading.
   */
  outline?: unknown,
) => Promise<{
  ref: RefineOutputRef;
  markdown: string;
  ragMarkdown: string;
}>;

/** Wiki-edit diff-refine runner (G4.S3.T10): input = corrected wiki markdown
 *  (ragMarkdown form) + the minimal diff. Athena PRESERVES the corrected text
 *  verbatim and re-derives structure; the runner returns the small ref + the
 *  new entities/relations the correction introduced + the re-chunk decision. */
export interface WikiEditRefineResult {
  ref: RefineOutputRef;
  /** The corrected markdown (ragMarkdown form) — preserved verbatim by the refine. */
  markdown: string;
  /** Entities the correction introduced (subset of ref.entities). */
  newEntities: RefinementEntity[];
  /** Relations the correction introduced (subset of ref.relations). */
  newRelations: RefinementRelation[];
  /** Whether the refine decided re-chunking was required. */
  rechunked: boolean;
}

export type WikiEditRefiner = (
  input: {
    markdown: string;
    before: string;
    diff: string;
    structural: boolean;
    /** Existing frontmatter type (preserved through the diff-refine). */
    type?: string;
    /** Existing frontmatter topic (preserved through the diff-refine). */
    topic?: string;
    /** Upload/page file name for stem derivation when the body has no h1. */
    fileName?: string;
    /**
     * G4.S10.T4: the edited page's wiki path — the refiner reads the
     * document's current graph entities as the KNOWN ENTITIES baseline.
     */
    wikiPath?: string;
  },
) => Promise<WikiEditRefineResult>;

/** The context a wiki-save task carries so the diff-refine + overwrite can run
 *  (and be retried) without re-reading the wiki (G4.S3.T10). */
export interface WikiSaveContext {
  /** wiki page path, e.g. "wiki/concepts/foo.md". */
  path: string;
  /** Previous page BODY in ragMarkdown form (image refs stripped, VLM alt-text kept). */
  beforeRag: string;
  /** Corrected page BODY in the same ragMarkdown form. */
  afterRag: string;
  /** Minimal unified diff (before → after). */
  diff: string;
  /** Whether the change touched heading structure. */
  structural: boolean;
  /** Existing frontmatter type (preserved through the diff-refine). */
  type?: string;
  /** Existing frontmatter topic (preserved through the diff-refine). */
  topic?: string;
}

export type TaskStageName = "parsing" | "refinement" | "ingesting_llmwiki" | "ingesting_neo4j";
export type StageStatus = "pending" | "running" | "done" | "failed";
export type TaskStatus = "pending" | "parsing" | "refining" | "ingesting" | "done" | "failed";

/**
 * G4.S8.T19 pipeline review: WHY the Neo4j ingest stage was a no-op (marked
 * done without writing). The production incident had the server started
 * OUTSIDE scripts/start-all.sh — NEO4J_PASSWORD unset — so every ingest
 * logged an indistinguishable "neo4j ingest: ok" while the graph stayed
 * EMPTY. Returns undefined when the stage really ran.
 */
export function neo4jIngestSkipReason(
  storeConfigured: boolean,
  hasRefinementOutput: boolean,
): string | undefined {
  if (storeConfigured && hasRefinementOutput) return undefined;
  if (!storeConfigured) {
    return "Neo4j store NOT wired (NEO4J_PASSWORD unset) — start via scripts/start-all.sh (exports NEO4J_*) or set NEO4J_URI/NEO4J_USER/NEO4J_PASSWORD; the graph stays EMPTY";
  }
  return "no refinement output (refine pass failed) — nothing to embed into Neo4j";
}

/** Per-system sub-step name (G3.S5.T2). Refinement (G4.S1) has ONE sub-step:
 *  the Athena full-document pass (re-level headers + classify + chunk +
 *  entities/keywords + quality, one read). */
export type DoclingStepName = "read_file" | "parse_ocr_image_desc";
export type RefinementStepName = "refine_document";
export type Neo4jStepName = "embed_store";
export type StepName = DoclingStepName | RefinementStepName | LlmWikiStepName | Neo4jStepName;

export interface TaskStep {
  name: StepName;
  status: StageStatus;
  error?: string;
  /** Live sub-step progress text (G4.S3.T9): the Neo4j embed_store step carries
   *  "X/Y" while chunks embed so the UI can show "embed_store: 5/16". */
  progress?: string;
}

export interface TaskStage {
  name: TaskStageName;
  status: StageStatus;
  error?: string;
  steps: TaskStep[];
  /** Neo4j chunk ingest progress (G4.S3.T8), carried on the ingesting_neo4j
   *  stage: chunks embedded + stored so far vs the total, plus the 0..1
   *  fraction. Set while the stage runs and preserved once it completes. */
  chunksStored?: number;
  chunksTotal?: number;
  progress?: number;
  /** Neo4j chunk progress aliases (G4.S3.T9): `processed`/`total` mirror
   *  chunksStored/chunksTotal so the frontend ETA reads
   *  (total - processed) × avg ms per chunk uniformly. */
  processed?: number;
  total?: number;
  /** Rolling ETA in ms for the remaining chunks (G4.S3.T9): remaining chunks ×
   *  the average ms per chunk measured since the first progress report. Set on
   *  the ingesting_neo4j stage while total > 0. */
  etaMs?: number;
}

/**
 * Rolling ETA for the Neo4j chunk embed loop (G4.S3.T9): remaining chunks
 * (`total - processed`) × the average ms per chunk measured since the anchor
 * timestamp (`anchorAt` = first observed progress). Returns undefined before any
 * chunk is stored or when the anchor is not older than `now` (no baseline yet).
 */
export function rollingEtaMs(
  processed: number,
  total: number,
  anchorAt: number,
  now: number,
): number | undefined {
  if (total <= 0 || processed <= 0) return undefined;
  const elapsed = now - anchorAt;
  if (elapsed <= 0) return undefined;
  const msPerChunk = elapsed / processed;
  return Math.max(0, (total - processed) * msPerChunk);
}

const NEO4J_STEPS: Neo4jStepName[] = ["embed_store"];

/**
 * Derive the llm_wiki page path that will be (or was) written for this doc —
 * mirrors ingestLlmWiki's `wiki/<topic|category>/<fileName>` layout so the Neo4j
 * WikiPage bridge points at the real page (G4.S2.T11). Unknown classification →
 * undefined (no WikiPage bridge).
 */
function wikiPathFor(fileName: string, preclassified?: WikiClassification): string | undefined {
  if (!preclassified) return undefined;
  const subDir =
    preclassified.topic && isValidTopic(preclassified.topic)
      ? preclassified.topic
      : categoryDir(preclassified.category);
  return `wiki/${subDir}/${fileName}`;
}

/**
 * Derive the llm_wiki classification from the STORED code ref frontmatter — the
 * single source of truth shared with the Neo4j Document node (G4.S8.T8). The code
 * store emits `frontmatter = { type: "code", topic: "code/<system>" }` (with
 * `code/unknown` fallback when no system was reported), so the wiki page lands
 * under `wiki/code/<system>/` and both consumers read the same ref.
 */
function codePreclassified(ref: Pick<RefineOutputRef, "frontmatter">, fileName: string): WikiClassification {
  const category = (WIKI_CATEGORIES as readonly string[]).includes(ref.frontmatter.type)
    ? (ref.frontmatter.type as WikiCategory)
    : "code";
  const topic = ref.frontmatter.topic;
  return {
    category,
    pagePath: `wiki/${topic}/${fileName}`,
    topic,
  };
}

/** Fresh pending sub-steps for a stage, e.g. `["read_file", "parse_ocr_image_desc"]`. */
export function initialSteps(stage: TaskStageName): TaskStep[] {
  switch (stage) {
    case "parsing":
      return [
        { name: "read_file", status: "pending" },
        { name: "parse_ocr_image_desc", status: "pending" },
      ];
    case "refinement":
      return [
        { name: "refine_document", status: "pending" },
      ];
    case "ingesting_neo4j":
      return NEO4J_STEPS.map((name) => ({ name, status: "pending" }));
    case "ingesting_llmwiki":
      return [
        // G4.S1.T4: `classify` is folded into the refinement stage — Athena
        // decides type/topic once; llm_wiki is pure I/O (write + rebuild index).
        { name: "write_page", status: "pending" },
        { name: "rebuild_index", status: "pending" },
      ];
  }
}

function initialStage(name: TaskStageName): TaskStage {
  return { name, status: "pending", steps: initialSteps(name) };
}

export interface IngestTask {
  id: string;
  /** Original filename or URL being ingested. */
  source: string;
  /** Wiki page path of the task's output (when known). Surfaced to the
   *  frontend so the Uploads review badge can be cleared on wiki-review
   *  resolve (G4.S10.T4 / web review-cleared event). */
  wikiPath?: string;
  /** Parse input (file path or URL) retained so retry can re-run docling. */
  input?: string;
  /** Parsed markdown retained so retry can re-run ingest stages without re-parsing. */
  markdown?: string;
  /** Derived ingest filename (`<documentId>.md`) retained for retry. */
  fileName?: string;
  /** Docling-extracted image files (G3.S5.T5), retained so retry can re-copy
   *  them beside the wiki page when the llm_wiki stage is re-run. `sourceDir`
   *  is the absolute export dir; `relativeDir` is the layout relative to the
   *  markdown file (`images/<stem>`), which the page refs already use. */
  images?: { sourceDir: string; relativeDir: string };
  /**
   * G4.S10.T6: docling-detected outline (PDF bookmark layer) from the parse step,
   * retained so retry can pass it to the refiner (TOC-first header grading).
   */
  outline?: unknown;
  status: TaskStatus;
  /** Overall progress 0-100. */
  progress: number;
  stages: {
    parsing: TaskStage;
    refinement: TaskStage;
    ingesting_llmwiki: TaskStage;
    ingesting_neo4j: TaskStage;
  };
  /** Re-leveled markdown from the Athena refinement stage (G4.S1.T4). Set once
   *  the refinement stage succeeds; llm_wiki consumes it. Falls back to the raw
   *  docling `markdown` when refinement fails. */
  refinedMarkdown?: string;
  /** RAG working copy (File B, G4.S1.T6): refined text-only markdown without image
   *  refs. Retained so the File B on disk can be cleaned up after ingestion. */
  ragMarkdown?: string;
  /** Athena refinement small ref (frontmatter/entities/keywords/quality/md_ref),
   *  retained so retry re-uses it without re-running the LLM pass. */
  refinement?: RefineOutputRef;
  /** Operator-review flag (G4.S1.T5): true when the Athena refinement pass
   *  emitted quality.action=review_required, OR refinement failed and the raw
   *  docling output was used (never worse than today, but worth a look). */
  reviewRequired?: boolean;
  /** True when the Neo4j stage actually stored refinement output (G4.S2.T4). A
   *  no-op stage (store not wired / no refinement output) leaves this unset. */
  neo4jStored?: boolean;
  /** Wiki-edit context (G4.S3.T10): present on tasks created by submitWikiSave.
   *  Carries the corrected text + diff so the diff-refine and RAG overwrite can
   *  run (and be retried) without re-reading the wiki page. */
  wikiSave?: WikiSaveContext;
  /** Diff-refine outcome surfaced for the operator (G4.S3.T10): the NEW
   *  entities/relations the correction introduced + whether re-chunking was
   *  required. Present after a wiki-save refinement stage. */
  wikiEdit?: {
    newEntities: RefinementEntity[];
    newRelations: RefinementRelation[];
    rechunked: boolean;
  };
  documentId?: string;
  error?: string;
  /** Present on tasks created by submitCds: the raw CDS intake + lineage so the
   *  code pipeline can be re-run on retry without re-fetching the source. */
  codeSource?: CdsIntakeInput;
  /** Deterministic parse of a CDS source (G4.S8.T3), retained for retry. */
  cdsViews?: CdsView[];
  /** Present on tasks created by submitAbap: the raw ABAP intake + lineage so
   *  the code pipeline can be re-run on retry without re-fetching the source. */
  abapSource?: AbapIntakeInput;
  /** Deterministic parse of an ABAP source (G4.S8.T4), retained for retry. */
  abapUnits?: AbapUnit[];
  /** Present on tasks created by submitUi5: the raw UI5 intake so the code
   *  pipeline can be re-run on retry without re-fetching the app files. */
  ui5Source?: Ui5IntakeInput;
  /** Deterministic parse of a UI5 app (G4.S8.T5), retained for retry. */
  ui5Units?: Ui5Unit[];
  /** Present on tasks created by submitDdic: the raw DDIC table-structure
   *  intake + lineage so the code pipeline can be re-run on retry. */
  ddicSource?: DdicIntakeInput;
  /** Deterministic parse of a DDIC source (G4.S8.T9), retained for retry. */
  ddicTables?: DdicTable[];
  /** Code lineage (system/devclass/transport) folded into the wiki frontmatter
   *  so answers can distinguish current/active objects (G4.S8.T3). */
  provenance?: CodeProvenance;
  /** Content dedup outcome (G2.S5.T14). Present when the doc was skipped as a
   *  duplicate: exact normalized-hash match or long-doc chunk-sequence match. */
  dedup?: {
    duplicate: boolean;
    method?: "hash" | "chunks";
    existingSource?: string;
  };
  createdAt: number;
  updatedAt: number;
}

/**
 * G4.S9.T1: entity names touched by a refinement write — declared entities plus
 * every relation endpoint (the consistency layer may have created those). The
 * community refresh uses them as local-recompute seeds.
 */
function touchedEntityNames(ref: RefineOutputRef | undefined): string[] {
  if (!ref) return [];
  return [
    ...(ref.entities ?? []).map((e) => e.name),
    ...(ref.relations ?? []).flatMap((r) => [r.source, r.target]),
  ].filter((n): n is string => Boolean(n && n.trim()));
}

/** Thrown when retry() is asked to re-run an unknown task. */
export class TaskNotFoundError extends Error {}

/** Thrown when retry() is asked to re-run a task that is still running. */
export class TaskBusyError extends Error {}
/** Thrown when retry() finds no failed stage worth re-running. */
export class NothingToRetryError extends Error {}

/** What a CDS code-intake task ingests (G4.S8.T3): raw DDL source + optional lineage. */
export interface CdsIntakeInput {
  /** Full CDS DDL source text (one or many `define view ... }` blocks). */
  content: string;
  /** Source file name (for the wiki page / provenance naming). */
  filename?: string;
  /** Optional lineage: which SAP system the object came from (via MCP pull). */
  system?: string;
  /** Optional lineage: the ABAP devclass/package. */
  devclass?: string;
  /** Optional lineage: the transport request. */
  transport?: string;
}

/** What an ABAP code-intake task ingests (G4.S8.T4): raw ABAP source text. */
export interface AbapIntakeInput {
  /** Full ABAP source text (class/report/function group, incl. includes). */
  content: string;
  /** Source file name (for the wiki page / provenance naming). */
  filename?: string;
  /** Optional lineage: which SAP system the object came from (via MCP pull). */
  system?: string;
  /** Optional lineage: the ABAP devclass/package. */
  devclass?: string;
  /** Optional lineage: the transport request. */
  transport?: string;
}

/** What a UI5 code-intake task ingests (G4.S8.T5): the app's business files.
 *  `files` maps a relative app path (e.g. `webapp/controller/Report.controller.js`)
 *  to its source text. The task queue hands these straight to the local UI5
 *  parser (no docling); node_modules/dist are excluded by the parser. */
export interface Ui5IntakeInput {
  /** Relative app path -> source text for each business file under webapp/. */
  files: Record<string, string>;
  /** Source file / zip label (for the wiki page / provenance naming). */
  filename?: string;
  /** App component namespace, e.g. `com.caleo.consolidation`. */
  component?: string;
  /** Optional lineage: which SAP BTP/system the app came from (via remote pull). */
  system?: string;
  /** Optional lineage: the ABAP devclass/package. */
  devclass?: string;
  /** Optional lineage: the transport request / commit ref. */
  transport?: string;
}

/** What a DDIC table-structure intake task ingests (G4.S8.T9): a JSON array of
 *  SAP table descriptors (what an SAP-side MCP pull or RFC DDIF_FIELDINFO_GET
 *  produces). The platform does NOT call SAP — it only consumes this JSON. */
export interface DdicIntakeInput {
  /** JSON array of table descriptors, e.g. `[{"name":"MARA",...}]`. */
  content: string;
  /** Source file name (for the wiki page / provenance naming). */
  filename?: string;
  /** Optional lineage: which SAP system the table structures came from. */
  system?: string;
  /** Optional lineage: the ABAP devclass/package. */
  devclass?: string;
  /** Optional lineage: the transport request. */
  transport?: string;
}

/** Slugify a technical name / filename for storage + wiki naming. */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Stable source key for a CDS intake (filename stem without the DDL ext). */
export function sourceName(input: CdsIntakeInput): string {
  if (input.filename) {
    const base = input.filename.split(/[\\/]/).pop() ?? input.filename;
    return base.replace(/\.(cds|json|ddls|sql)$/i, "");
  }
  return "cds-source";
}

/** Stable source key for an ABAP intake (filename stem without the ABAP ext). */
export function abapSourceName(input: AbapIntakeInput): string {
  if (input.filename) {
    const base = input.filename.split(/[\\/]/).pop() ?? input.filename;
    return base.replace(/\.(abap|clas|fugr|prog|report|txt|abap)$/i, "");
  }
  return "abap-source";
}

/** Stable source key for a UI5 intake (filename stem without the zip/app ext). */
export function ui5SourceName(input: Ui5IntakeInput): string {
  if (input.filename) {
    const base = input.filename.split(/[\\/]/).pop() ?? input.filename;
    return base.replace(/\.(zip|tar|tgz|gz|app)$/i, "");
  }
  if (input.component) {
    return input.component.split(".").pop() ?? "ui5-app";
  }
  return "ui5-app";
}

/** Stable source key for a DDIC intake (filename stem without the JSON ext). */
export function ddicSourceName(input: DdicIntakeInput): string {
  if (input.filename) {
    const base = input.filename.split(/[\\/]/).pop() ?? input.filename;
    return base.replace(/\.(json|txt|ddic)$/i, "");
  }
  return "ddic-source";
}

export interface IngestTaskQueueOptions {
  parser: DoclingParser;
  ingest: KnowledgeIngestService;
  /** Athena refinement runner (G4.S1.T4). When unset, the refinement stage is
   *  skipped and the raw docling markdown is used (never worse than today). */
  refiner?: Refiner;
  /** Wiki-edit diff-refine runner (G4.S3.T10). When unset, wiki saves fall back
   *  to a mechanical refine (corrected text + heading chunks, review flag). */
  wikiRefiner?: WikiEditRefiner;
  /** Storage root for the mechanical wiki-edit fallback ref (G4.S3.T10).
   *  Default: defaultRefinementOutputDir(). */
  wikiRefineStorageDir?: string;
  /** Neo4j lean RAG store ingest (G4.S2.T4). When unset, the ingesting_neo4j
   *  stage is a no-op marked done — the store is not wired. */
  neo4j?: Neo4jIngestService;
  /** G4.S9.T1: community-detection refresh over the entity graph. Fire-and-
   *  forget — never blocks or fails the ingest stages (eventual consistency). */
  community?: Pick<Neo4jCommunityService, "refresh">;
  /** G4.S9.T2: community-summary sync, chained AFTER `community.refresh`
   *  resolves inside the same fire-and-forget hook — summaries only make sense
   *  once clustering finished, so no separate trigger surface is exposed. */
  communitySummaries?: Pick<Neo4jCommunitySummaryService, "sync">;
  /** Optional content-dedup store (G2.S5.T14). When set, identical content is
   *  skipped before the pipelines run; newly stored content is recorded. */
  dedup?: ContentDedupStore;
  /**
   * G4.S8.T21: the canonical frontmatter channel. When wired, runWikiSave
   * restamps the page's review gate from the wiki-edit refinement quality —
   * the same stamping the upload path performs via ingestLlmWiki's reviewGate.
   */
  frontmatter?: Pick<WikiFrontmatterSyncer, "update" | "readLifecycle">;
}

export interface IngestSubmitResult {
  taskId: string;
}

function initialStages(): IngestTask["stages"] {
  return {
    parsing: initialStage("parsing"),
    refinement: initialStage("refinement"),
    ingesting_llmwiki: initialStage("ingesting_llmwiki"),
    ingesting_neo4j: initialStage("ingesting_neo4j"),
  };
}

export class IngestTaskQueue {
  private readonly parser: DoclingParser;
  /** Shared KB ingest service (same instance the delete-cascade routes use). */
  readonly ingest: KnowledgeIngestService;
  private readonly refiner?: Refiner;
  private readonly wikiRefiner?: WikiEditRefiner;
  private readonly wikiRefineStorageDir: string;
  private readonly neo4j?: Neo4jIngestService;
  private readonly community?: Pick<Neo4jCommunityService, "refresh">;
  private readonly communitySummaries?: Pick<Neo4jCommunitySummaryService, "sync">;
  private readonly dedup?: ContentDedupStore;
  private readonly frontmatter?: Pick<WikiFrontmatterSyncer, "update" | "readLifecycle">;
  private readonly tasks = new Map<string, IngestTask>();
  /** First-observed progress timestamp per task, the anchor for the rolling
   *  ms-per-chunk ETA on the ingesting_neo4j stage (G4.S3.T9). */
  private readonly etaStartAt = new Map<string, number>();

  constructor(options: IngestTaskQueueOptions) {
    this.parser = options.parser;
    this.ingest = options.ingest;
    this.refiner = options.refiner;
    this.wikiRefiner = options.wikiRefiner;
    this.wikiRefineStorageDir = options.wikiRefineStorageDir ?? defaultRefinementOutputDir();
    this.neo4j = options.neo4j;
    this.community = options.community;
    this.communitySummaries = options.communitySummaries;
    this.dedup = options.dedup;
    this.frontmatter = options.frontmatter;
  }

  /**
   * G4.S9.T1: fire-and-forget community refresh after a successful graph write.
   * The trigger carries the touched entity names (folded inside the service) so
   * small diffs can take the bounded local-recompute path above the size
   * threshold; failures are logged and swallowed — retrieval is never blocked.
   *
   * G4.S9.T2: the summary sync is chained after the clustering resolves
   * (post-finalize): it mirrors whatever memberships are persisted at that
   * point, so it must not race the partition write. `sync` never throws.
   */
  private refreshCommunities(trigger: CommunityRefreshTrigger): void {
    this.community
      ?.refresh(trigger)
      .then(() => this.communitySummaries?.sync())
      .catch((err: unknown) => {
        console.error(`[tasks] community refresh failed (${trigger.kind}):`, err);
      });
  }

  /** Create + return a task without starting it. */
  createTask(source: string): IngestTask {
    const now = Date.now();
    const task: IngestTask = {
      id: randomUUID(),
      source,
      status: "pending",
      progress: 0,
      stages: initialStages(),
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  getTask(id: string): IngestTask | undefined {
    return this.tasks.get(id);
  }

  /**
   * Start async processing of a file path. Returns immediately; task status
   * progresses as docling + the two ingestion systems complete.
   */
  submitFile(filePath: string, sourceName: string): IngestSubmitResult {
    const task = this.createTask(sourceName);
    void this.run(task.id, filePath, sourceName);
    return { taskId: task.id };
  }

  /** Start async processing of a URL. Returns immediately. */
  submitUrl(url: string): IngestSubmitResult {
    const task = this.createTask(url);
    void this.run(task.id, url, url);
    return { taskId: task.id };
  }

  /**
   * Start the wiki-edit save pipeline (G4.S3.T10). The caller already persisted
   * the corrected markdown to the wiki file (saveWikiPage) and computed the
   * diff; this task runs the Athena diff-refine + the RAG overwrite (via the
   * wikiPath) in the background, surfacing progress through the normal ingest
   * task model. Returns immediately; poll GET /api/kb/task/:id.
   */
  submitWikiSave(input: WikiSaveContext): IngestSubmitResult {
    const task = this.createTask(input.path);
    task.wikiSave = input;
    void this.runWikiSave(task.id);
    return { taskId: task.id };
  }

  /**
   * Start the CDS code-intake pipeline (G4.S8.T3). The source is CDS DDL text
   * (NOT a docling document): parsing + chunking happen LOCALLY with parseCdsViews
   * — no docling, no LLM — and the resulting per-view chunks flow into the SAME
   * llm_wiki + Neo4j ingest stages as a normal doc. Returns a task id; poll
   * GET /api/kb/task/:id. Provenance (system/devclass/transport) is optional.
   */
  submitCds(input: CdsIntakeInput): IngestSubmitResult {
    const task = this.createTask(input.filename ?? "cds-source");
    task.codeSource = input;
    if (input.system || input.devclass || input.transport) {
      task.provenance = {
        ...(input.system ? { system: input.system } : {}),
        ...(input.devclass ? { devclass: input.devclass } : {}),
        ...(input.transport ? { transport: input.transport } : {}),
      };
    }
    void this.runCode(task.id);
    return { taskId: task.id };
  }

  /**
   * Start the ABAP code-intake pipeline (G4.S8.T4). The source is ABAP text
   * (NOT a docling document): parsing + chunking happen LOCALLY with
   * parseAbapUnits — no docling, no LLM — and the resulting per-unit chunks flow
   * into the SAME llm_wiki + Neo4j ingest stages as a normal doc. Returns a task
   * id; poll GET /api/kb/task/:id. Provenance (system/devclass/transport) is
   * optional and folded into the wiki frontmatter.
   */
  submitAbap(input: AbapIntakeInput): IngestSubmitResult {
    const task = this.createTask(input.filename ?? "abap-source");
    task.abapSource = input;
    if (input.system || input.devclass || input.transport) {
      task.provenance = {
        ...(input.system ? { system: input.system } : {}),
        ...(input.devclass ? { devclass: input.devclass } : {}),
        ...(input.transport ? { transport: input.transport } : {}),
      };
    }
    void this.runAbap(task.id);
    return { taskId: task.id };
  }

  /**
   * Start the UI5 code-intake pipeline (G4.S8.T5). The source is a map of UI5
   * business files (webapp controllers/view/manifest/model — NOT a docling
   * document): parsing + chunking happen LOCALLY with parseUi5Units (business
   * code only; node_modules/dist excluded). The resulting per-file/per-method
   * chunks flow into the SAME llm_wiki + Neo4j ingest stages as a normal doc.
   * Returns a task id; poll GET /api/kb/task/:id. Provenance is optional.
   */
  submitUi5(input: Ui5IntakeInput): IngestSubmitResult {
    const task = this.createTask(input.filename ?? input.component ?? "ui5-source");
    task.ui5Source = input;
    if (input.system || input.devclass || input.transport) {
      task.provenance = {
        ...(input.system ? { system: input.system } : {}),
        ...(input.devclass ? { devclass: input.devclass } : {}),
        ...(input.transport ? { transport: input.transport } : {}),
      };
    }
    void this.runUi5(task.id);
    return { taskId: task.id };
  }

  /**
   * Start the DDIC table-structure intake pipeline (G4.S8.T9). The source is a
   * JSON array of SAP table descriptors (NOT a docling document): parsing +
   * chunking happen LOCALLY with parseDdicTables — no docling, no LLM — and the
   * resulting header + field-group chunks flow into the SAME llm_wiki + Neo4j
   * ingest stages as a normal doc. The local parse emits a Table entity per
   * table + REFERENCES edges to (external) foreign-key targets. Returns a task
   * id; poll GET /api/kb/task/:id. Provenance is optional.
   */
  submitDdic(input: DdicIntakeInput): IngestSubmitResult {
    const task = this.createTask(input.filename ?? "ddic-source");
    task.ddicSource = input;
    if (input.system || input.devclass || input.transport) {
      task.provenance = {
        ...(input.system ? { system: input.system } : {}),
        ...(input.devclass ? { devclass: input.devclass } : {}),
        ...(input.transport ? { transport: input.transport } : {}),
      };
    }
    void this.runDdic(task.id);
    return { taskId: task.id };
  }

  private patch(id: string, mutator: (task: IngestTask) => void): void {
    const task = this.tasks.get(id);
    if (!task) return;
    mutator(task);
    task.updatedAt = Date.now();
  }

  /**
   * Recompute the overall 0-100 progress across parsing → refinement → the two
   * parallel ingest stages (llm_wiki, Neo4j). Never jumps to 100 while any of
   * the ingest systems is still running. Parsing done = 15, refinement done =
   * 35, then the ingest stages share the remaining band.
   */
  private updateProgress(id: string): void {
    this.patch(id, (t) => {
      const p = t.stages.parsing.status;
      const rf = t.stages.refinement.status;
      const lw = t.stages.ingesting_llmwiki.status;
      const n4 = t.stages.ingesting_neo4j.status;
      if (p !== "done") { t.progress = p === "failed" ? 100 : 15; return; }
      if (rf !== "done") { t.progress = rf === "failed" ? 100 : 35; return; }
      const lwDone = lw === "done", n4Done = n4 === "done";
      const lwFail = lw === "failed", n4Fail = n4 === "failed";
      if (lwDone && n4Done) { t.progress = 100; return; }
      if (lwDone) { t.progress = n4Fail ? 100 : 88; return; } // llm_wiki done, waiting on Neo4j
      if (n4Done) { t.progress = lwFail ? 100 : 72; return; } // Neo4j done, waiting on llm_wiki
      if (lwFail || n4Fail) { t.progress = 100; return; }
      t.progress = 50; // all still running
    });
  }

  /** Set every sub-step of a stage to the given status (optionally with an error).
   *  A completed ("done") sub-step is never downgraded to failed — only the
   *  pending/running remainder of a failed stage becomes failed. */
  private markStageSteps(id: string, stageName: TaskStageName, status: StageStatus, error?: string): void {
    this.patch(id, (t) => {
      for (const step of t.stages[stageName].steps) {
        if (status === "failed" && step.status === "done") continue;
        step.status = status;
        if (error !== undefined) step.error = error;
      }
    });
  }

  /** Set a single sub-step's status. */
  private setStep(id: string, stageName: TaskStageName, stepName: StepName, status: StageStatus): void {
    this.patch(id, (t) => {
      const step = t.stages[stageName].steps.find((s) => s.name === stepName);
      if (step) step.status = status;
    });
  }

  private async run(id: string, input: string, source: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) return;
    task.input = input;

    let markdown = task.markdown;
    let fileName = task.fileName;
    let refinedMarkdown = task.refinedMarkdown;
    let ragMarkdown = task.ragMarkdown;
    let refinementRef = task.refinement;
    // G3.S8.T2: classification computed once before the ingest stages so both
    // systems receive the SAME type+topic. Since G4.S1.T4, the classification
    // comes from the Athena refinement output (type/topic decided once); when
    // refinement is unavailable it falls back to the llm_wiki classifier.
    let preclassified: WikiClassification | undefined;

    // --- parsing (docling) ---
    if (task.stages.parsing.status !== "done") {
      this.patch(id, (t) => {
        t.status = "parsing";
        t.progress = 15;
        t.stages.parsing = { name: "parsing", status: "running", steps: t.stages.parsing.steps };
      });
      try {
        console.log(`[tasks:${id}] parsing start: ${input}`);
        this.setStep(id, "parsing", "read_file", "running");
        const parsed = await this.parser.parse(input);
        markdown = parsed.markdown;
        fileName = `${parsed.stem || documentIdFrom(source, source)}.md`;
        console.log(`[tasks:${id}] parsing done (${markdown?.length ?? 0} chars)`);
        this.patch(id, (t) => {
          t.stages.parsing = { name: "parsing", status: "done", steps: t.stages.parsing.steps };
          t.documentId = parsed.stem || documentIdFrom(source, source);
          t.markdown = markdown;
          t.fileName = fileName;
          t.outline = parsed.outline ?? undefined;
          t.images = parsed.imagesDir
            ? {
                sourceDir: parsed.imagesDir,
                relativeDir: relative(dirname(parsed.outputPath), parsed.imagesDir),
              }
            : undefined;
          t.progress = 35;
        });
        this.setStep(id, "parsing", "read_file", "done");
        this.setStep(id, "parsing", "parse_ocr_image_desc", "done");
      } catch (err) {
        console.error(`[tasks:${id}] parsing FAILED:`, err);
        return this.fail(id, err, "parsing");
      }
    }

    if (!markdown || !fileName) {
      return this.fail(id, new Error("missing parsed markdown content"), "parsing");
    }

    // --- content dedup (G2.S5.T14): skip both pipelines on exact/chunk duplicate ---
    if (this.dedup) {
      const dup = await this.dedup.check(markdown);
      if (dup.duplicate) {
        return this.markDedup(id, dup.method, dup.existingSource);
      }
    }

    // --- Ingesting: refinement first, then llm_wiki + Neo4j run in PARALLEL ---
    const llmwikiTodo = task.stages.ingesting_llmwiki.status !== "done";
    const neo4jTodo = task.stages.ingesting_neo4j.status !== "done";

    // --- refinement (G4.S1.T4): the Athena single full-doc LLM pass between
    // parsing and the parallel ingest stages. Best-effort: when it fails (or no
    // refiner is configured) the raw docling markdown is used — never worse
    // than today. The type/topic it emits feeds BOTH systems (folds llm_wiki
    // classify); entities/keywords are injected for G4.S2 RAG self-build.
    if (task.stages.refinement.status !== "done") {
      if (this.refiner) {
        this.patch(id, (t) => {
          t.status = "refining";
          t.progress = 35;
          t.stages.refinement = { name: "refinement", status: "running", steps: t.stages.refinement.steps };
        });
        this.setStep(id, "refinement", "refine_document", "running");
        try {
          console.log(`[tasks:${id}] refinement start`);
          const result = await this.refiner(markdown!, undefined, fileName, task.outline);
          refinedMarkdown = result.markdown;
          ragMarkdown = result.ragMarkdown;
          refinementRef = result.ref;
          console.log(
            `[tasks:${id}] refinement done (${refinedMarkdown?.length ?? 0} chars, ${result.ref.chunk_count} chunks, type=${result.ref.frontmatter.type}, topic=${result.ref.frontmatter.topic})`,
          );
          const review = result.ref.quality?.action === "review_required";
          if (review) {
            const issues = result.ref.quality?.issues ?? [];
            console.warn(
              `[tasks:${id}] refinement REVIEW REQUIRED for operator: ${issues.join("; ") || "quality below auto-accept threshold"}`,
            );
          }
          this.patch(id, (t) => {
            t.refinedMarkdown = refinedMarkdown;
            t.ragMarkdown = ragMarkdown;
            t.refinement = refinementRef;
            t.reviewRequired = review || undefined;
            t.stages.refinement = { name: "refinement", status: "done", steps: t.stages.refinement.steps };
          });
          this.setStep(id, "refinement", "refine_document", "done");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[tasks:${id}] refinement FAILED (using raw docling): ${message}`);
          this.patch(id, (t) => {
            t.stages.refinement = { name: "refinement", status: "failed", error: message, steps: t.stages.refinement.steps };
            // Fallback to the raw docling output — never worse than today, but
            // the doc skipped the quality check → flag it for operator review.
            t.reviewRequired = true;
          });
          this.markStageSteps(id, "refinement", "failed", message);
        }
      } else {
        // No refiner configured → mark the stage done and use raw docling.
        this.patch(id, (t) => {
          t.stages.refinement = { name: "refinement", status: "done", steps: t.stages.refinement.steps };
        });
      }
    }

    // Classify/feed content once for the llm_wiki stage. Priority:
    //   1. Athena refinement output (type/topic from the single LLM pass) — folds llm_wiki classify.
    //   2. Fallback: llm_wiki classifier (existing behavior).
    if (llmwikiTodo) {
      const title = extractPageTitle(refinedMarkdown ?? markdown!) ?? stemTitle(fileName!);
      if (refinementRef) {
        preclassified = classificationFromRefinement(refinementRef.frontmatter, title, refinedMarkdown ?? markdown!);
      } else if (!preclassified) {
        const prepared = await this.safePrepare(() =>
          this.ingest.prepareForIngest({ title: extractPageTitle(markdown!) ?? stemTitle(fileName!), content: markdown! }),
        );
        if (prepared) {
          preclassified = prepared.classification;
        }
      }
    }

    const [llmwiki] = await Promise.all([
      (async () => {
        if (!llmwikiTodo) return;
        this.patch(id, (t) => {
          t.status = "ingesting";
          t.stages.ingesting_llmwiki = { name: "ingesting_llmwiki", status: "running", steps: t.stages.ingesting_llmwiki.steps };
          t.progress = 85;
        });
        // G4.S8.T17: a review_required refinement stamps the wiki page's
        // frontmatter gate (review: required + review_count) so WikiView can
        // render the review banner + inline annotations for the fresh page.
        const reviewGate =
          refinementRef && refinementRef.quality.action === "review_required"
            ? { state: "required" as const, count: countQualityIssues(refinementRef.quality) }
            : undefined;
        const res = await this.safeIngest(() =>
          this.ingest.ingestLlmWiki(fileName!, refinedMarkdown ?? markdown!, (step, status) => {
            this.setStep(id, "ingesting_llmwiki", step, status);
          }, preclassified, task.images, refinementRef?.summary, reviewGate),
        );
        console.log(`[tasks:${id}] llm_wiki ingest: ${res.ok ? "ok" : "FAILED " + (res.error ?? "")}`);
        this.patch(id, (t) => {
          t.stages.ingesting_llmwiki = { name: "ingesting_llmwiki", status: res.ok ? "done" : "failed", ...(res.ok ? {} : { error: res.error }), steps: t.stages.ingesting_llmwiki.steps };
        });
        this.updateProgress(id);
        this.markStageSteps(id, "ingesting_llmwiki", res.ok ? "done" : "failed", res.error);
      })(),
      (async () => {
        if (!neo4jTodo) return;
        this.patch(id, (t) => {
          t.status = "ingesting";
          t.stages.ingesting_neo4j = { name: "ingesting_neo4j", status: "running", steps: t.stages.ingesting_neo4j.steps };
          t.progress = 50;
        });
        this.markStageSteps(id, "ingesting_neo4j", "running");

        // G4.S2.T4: embed + index the Athena refinement output into Neo4j — no
        // LLM extraction here. Requires a Neo4j store AND the refinement output
        // (no ref = nothing to store); otherwise the stage is a no-op marked done.
        // G4.S3.T8: the store streams chunk progress via onProgress → the stage
        // exposes chunksStored/chunksTotal/progress so the API returns X/Y.
        // G4.S3.T9: per-chunk progress also drives the embed_store step's "X/Y"
        // progress text, the processed/total aliases, and a rolling etaMs.
        const res = this.neo4j && refinementRef
          ? await this.safeIngest(() => {
              const title = extractPageTitle(refinedMarkdown ?? markdown!) ?? stemTitle(fileName!);
              const documentId = task.documentId ?? documentIdFrom(source, source);
              const wikiPath = wikiPathFor(fileName!, preclassified);
              if (wikiPath) this.patch(id, (t) => { t.wikiPath = wikiPath; });
              return this.neo4j!.ingest({
                ref: refinementRef!,
                documentId,
                title,
                ...(wikiPath ? { wikiPath } : {}),
                onProgress: (p) => {
                  // Anchor the ETA's ms-per-chunk baseline on the first stored chunk.
                  if (p.chunksStored > 0 && !this.etaStartAt.has(id)) {
                    this.etaStartAt.set(id, Date.now());
                  }
                  this.patch(id, (t) => {
                    const stage = t.stages.ingesting_neo4j;
                    stage.chunksStored = p.chunksStored;
                    stage.chunksTotal = p.chunksTotal;
                    stage.progress = p.progress;
                    stage.processed = p.chunksStored;
                    stage.total = p.chunksTotal;
                    if (p.chunksTotal > 0) {
                      const step = stage.steps.find((s) => s.name === "embed_store");
                      if (step) step.progress = `${p.chunksStored}/${p.chunksTotal}`;
                    }
                    const anchor = this.etaStartAt.get(id);
                    if (anchor !== undefined) {
                      const etaMs = rollingEtaMs(p.chunksStored, p.chunksTotal, anchor, Date.now());
                      if (etaMs !== undefined) stage.etaMs = etaMs;
                    }
                  });
                },
              }).then((r) => {
                // G4.S9.T1: graph content changed → community refresh (async, non-blocking).
                this.refreshCommunities({
                  kind: "ingest",
                  entitiesStored: r.entitiesStored,
                  relationsStored: r.relationsStored,
                  touchedEntityNames: touchedEntityNames(refinementRef),
                });
                return { ok: true, count: r.chunksStored };
              });
            })
          : { ok: true };
        const skipReason = neo4jIngestSkipReason(Boolean(this.neo4j), Boolean(refinementRef));
        console.log(
          `[tasks:${id}] neo4j ingest: ${res.ok ? (skipReason ? `SKIPPED — ${skipReason}` : "ok") : "FAILED " + (res.error ?? "")}` +
            (res.ok && "count" in res ? ` (${res.count} chunks embedded)` : ""),
        );
        this.patch(id, (t) => {
          t.stages.ingesting_neo4j = {
            ...t.stages.ingesting_neo4j,
            status: res.ok ? "done" : "failed",
            ...(res.ok ? {} : { error: res.error }),
          };
          // Only a real store write counts as a success for the finalize decision;
          // a no-op (no store configured / no refinement output) must not alone
          // mark the task done when every other system failed.
          if (res.ok && this.neo4j && refinementRef) t.neo4jStored = true;
        });
        this.updateProgress(id);
        this.markStageSteps(id, "ingesting_neo4j", res.ok ? "done" : "failed", res.error);
      })(),
    ]);

    // --- finalize ---
    this.patch(id, (t) => {
      const llmwikiOk = t.stages.ingesting_llmwiki.status === "done";
      const neo4jOk = t.neo4jStored === true;
      // Surface the first failed stage's reason on the top-level task.error so the
      // UI shows WHY a stage failed instead of a silent green "done" / generic
      // message. Keep done even if one system failed.
      // Refinement is best-effort: it may fail and fall back to raw docling while
      // the task still completes (G4.S1 Spec: never worse than today).
      const failedStage = t.stages.parsing.status === "failed"
        ? t.stages.parsing
        : t.stages.refinement.status === "failed"
          ? t.stages.refinement
          : t.stages.ingesting_llmwiki.status === "failed"
            ? t.stages.ingesting_llmwiki
            : t.stages.ingesting_neo4j.status === "failed"
              ? t.stages.ingesting_neo4j
              : undefined;
      if (llmwikiOk || neo4jOk) {
        t.status = "done";
        t.progress = 100;
        if (failedStage?.error) t.error = failedStage.error;
      } else {
        t.status = "failed";
        t.progress = 100;
        t.error = failedStage?.error ?? "All knowledge systems failed";
      }
    });

    // Record the newly stored content so future uploads of it are detected.
    if (this.dedup) {
      const task = this.tasks.get(id);
      if (task && task.stages.ingesting_llmwiki.status === "done") {
        try {
          // Source key MUST match the delete-cascade purge key
          // (kb/ingest.ts deleteDocument: basename(wikiPath) minus .md).
          // Record from the same wikiPath, not the raw fileName stem —
          // otherwise removeBySource on delete finds nothing and a re-upload
          // of the same file gets short-circuited as a duplicate
          // (observed: delete → re-upload of Sommerseminar docs stopped at
          //  parsing with stages stuck pending via markDedup).
          const wp = wikiPathFor(fileName!, preclassified);
          const dedupSource = wp ? basename(wp).replace(/\.md$/i, "") : fileName;
          await this.dedup.record(markdown, dedupSource);
        } catch {
          // dedup recording is best-effort; never fail a successful ingest
        }
      }
    }
    // G4.S1.T6: ingestion is done → delete the File B RAG working copy (text-only
    // md). The durable File A′ (refined headers + image refs) at md_ref stays for
    // llm_wiki. Best-effort; the in-memory task.ragMarkdown is retained for retries.
    await this.deleteWorkingCopy(refinementRef);

    const finalTask = this.tasks.get(id);
    console.log(`[tasks:${id}] FINAL status=${finalTask?.status} progress=${finalTask?.progress} parsing=${finalTask?.stages.parsing.status} llmwiki=${finalTask?.stages.ingesting_llmwiki.status} neo4j=${finalTask?.stages.ingesting_neo4j.status}`);
  }

  /**
   * Wiki-edit save pipeline (G4.S3.T10): the edit was already persisted to the
   * wiki file synchronously (saveWikiPage) — parsing is skipped and the
   * llm_wiki stage is already done. This drives the diff-aware incremental
   * refine (corrected markdown + diff) then the RAG overwrite via the wikiPath
   * (locate Document → delete stale chunks/sections → re-embed → merge).
   */
  private async runWikiSave(id: string): Promise<void> {
    const task = this.tasks.get(id);
    const save = task?.wikiSave;
    if (!task || !save) return;

    task.input = save.path;

    // Parsing + llm_wiki are already done: the corrected page is on disk.
    this.patch(id, (t) => {
      t.stages.parsing = { name: "parsing", status: "done", steps: t.stages.parsing.steps };
      t.stages.ingesting_llmwiki = { name: "ingesting_llmwiki", status: "done", steps: t.stages.ingesting_llmwiki.steps };
    });
    this.markStageSteps(id, "parsing", "done");
    this.markStageSteps(id, "ingesting_llmwiki", "done");
    this.updateProgress(id);

    // --- refinement: incremental diff-aware refine (G4.S3.T10) ---
    if (task.stages.refinement.status !== "done") {
      if (this.wikiRefiner) {
        this.patch(id, (t) => {
          t.status = "refining";
          t.progress = 35;
          t.stages.refinement = { name: "refinement", status: "running", steps: t.stages.refinement.steps };
        });
        this.setStep(id, "refinement", "refine_document", "running");
        try {
          console.log(`[tasks:${id}] wiki-edit refine start (${save.path})`);
          // G4.S10.T4: surface the wiki path so the uploads badge can be cleared
        this.patch(id, (t) => { t.wikiPath = save.path; });
        const result = await this.wikiRefiner({
            markdown: save.afterRag,
            before: save.beforeRag,
            diff: save.diff,
            structural: save.structural,
            ...(save.type ? { type: save.type } : {}),
            ...(save.topic ? { topic: save.topic } : {}),
            // G4.S10.T4: the refiner reads the page's current graph entities
            // (KNOWN ENTITIES baseline) for the delta-grounded refine.
            wikiPath: save.path,
          });
          this.patch(id, (t) => {
            t.refinedMarkdown = result.markdown;
            t.refinement = result.ref;
            t.wikiEdit = {
              newEntities: result.newEntities,
              newRelations: result.newRelations,
              rechunked: result.rechunked,
            };
            t.reviewRequired = result.ref.quality?.action === "review_required" || undefined;
            t.stages.refinement = { name: "refinement", status: "done", steps: t.stages.refinement.steps };
          });
          this.setStep(id, "refinement", "refine_document", "done");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[tasks:${id}] wiki-edit refine FAILED (mechanical fallback): ${message}`);
          // Never worse than today: the corrected text + heading chunks still
          // reach RAG; the missing entity/relation re-derivation is flagged.
          await this.mechanicalWikiEditRefine(id, save, err);
          this.markStageSteps(id, "refinement", "failed", message);
        }
      } else {
        await this.mechanicalWikiEditRefine(id, save, new Error("no wiki edit refiner configured"));
      }
    }

    // --- ingesting_neo4j: overwrite the old RAG version via the wikiPath ---
    if (task.stages.ingesting_neo4j.status !== "done") {
      this.patch(id, (t) => {
        t.status = "ingesting";
        t.stages.ingesting_neo4j = { name: "ingesting_neo4j", status: "running", steps: t.stages.ingesting_neo4j.steps };
        t.progress = 50;
      });
      this.markStageSteps(id, "ingesting_neo4j", "running");

      const res = this.neo4j && task.refinement
        ? await this.safeIngest(() => {
            const title = extractPageTitle(save.afterRag) ?? stemTitle(save.path);
            const documentId = documentIdFrom(title, save.path);
            return this.neo4j!.overwrite({
              ref: task.refinement!,
              documentId,
              title,
              wikiPath: save.path,
              onProgress: (p) => {
                if (p.chunksStored > 0 && !this.etaStartAt.has(id)) {
                  this.etaStartAt.set(id, Date.now());
                }
                this.patch(id, (t) => {
                  const stage = t.stages.ingesting_neo4j;
                  stage.chunksStored = p.chunksStored;
                  stage.chunksTotal = p.chunksTotal;
                  stage.progress = p.progress;
                  stage.processed = p.chunksStored;
                  stage.total = p.chunksTotal;
                  if (p.chunksTotal > 0) {
                    const step = stage.steps.find((s) => s.name === "embed_store");
                    if (step) step.progress = `${p.chunksStored}/${p.chunksTotal}`;
                  }
                  const anchor = this.etaStartAt.get(id);
                  if (anchor !== undefined) {
                    const etaMs = rollingEtaMs(p.chunksStored, p.chunksTotal, anchor, Date.now());
                    if (etaMs !== undefined) stage.etaMs = etaMs;
                  }
                });
              },
            }).then((r) => {
              // G4.S9.T1: wiki-edit overwrite → community refresh (async, non-blocking).
              const touched = task.wikiEdit
                ? [
                    ...task.wikiEdit.newEntities.map((e) => e.name),
                    ...task.wikiEdit.newRelations.flatMap((rel) => [rel.source, rel.target]),
                  ].filter((n) => n && n.trim())
                : touchedEntityNames(task.refinement);
              this.refreshCommunities({
                kind: "wiki-edit",
                touchedEntityNames: touched as string[],
              });
              return { ok: true, count: r.chunksStored, documentId: r.documentId };
            });
          })
        : { ok: true };
      console.log(
        `[tasks:${id}] wiki save neo4j overwrite: ${res.ok ? "ok" : "FAILED " + (res.error ?? "")}` +
          (res.ok && "count" in res ? ` (${res.count} chunks re-embedded)` : ""),
      );
      this.patch(id, (t) => {
        t.stages.ingesting_neo4j = {
          ...t.stages.ingesting_neo4j,
          status: res.ok ? "done" : "failed",
          ...(res.ok ? {} : { error: res.error }),
        };
        if (res.ok && this.neo4j && task.refinement) t.neo4jStored = true;
        if (res.ok && "documentId" in res && typeof res.documentId === "string") {
          t.documentId = res.documentId;
        }
      });
      this.updateProgress(id);
      this.markStageSteps(id, "ingesting_neo4j", res.ok ? "done" : "failed", res.error);
    }

    // --- finalize (same shape as a regular ingest) ---
    this.patch(id, (t) => {
      const llmwikiOk = t.stages.ingesting_llmwiki.status === "done";
      const neo4jOk = t.neo4jStored === true;
      const failedStage = t.stages.parsing.status === "failed"
        ? t.stages.parsing
        : t.stages.refinement.status === "failed"
          ? t.stages.refinement
          : t.stages.ingesting_llmwiki.status === "failed"
            ? t.stages.ingesting_llmwiki
            : t.stages.ingesting_neo4j.status === "failed"
              ? t.stages.ingesting_neo4j
              : undefined;
      if (llmwikiOk || neo4jOk) {
        t.status = "done";
        t.progress = 100;
        if (failedStage?.error) t.error = failedStage.error;
      } else {
        t.status = "failed";
        t.progress = 100;
        t.error = failedStage?.error ?? "All knowledge systems failed";
      }
    });

    // --- G4.S8.T21: restamp the review gate from the wiki-edit quality ---
    await this.syncWikiReviewGate(id, save);

    const finalTask = this.tasks.get(id);
    console.log(
      `[tasks:${id}] wiki save FINAL status=${finalTask?.status} progress=${finalTask?.progress} refinement=${finalTask?.stages.refinement.status} neo4j=${finalTask?.stages.ingesting_neo4j.status}`,
    );
  }

  /**
   * G4.S8.T21: after a wiki save completes, restamp the page's frontmatter
   * review gate keyed on the WIKI-EDIT refinement quality — upload-path parity
   * (the ingest path stamps via ingestLlmWiki's reviewGate, tasks.ts). Both
   * directions so neither stale banners nor new review items go missing:
   *   - edit quality action=review_required → review: required + unresolved
   *     issue count (fresh items are surfaced);
   *   - otherwise (auto_accept), a previously required gate is cleared with
   *     count 0: the edit's own quality.json becomes the authoritative issue
   *     list (review-state resolves it first), so keeping `required` would
   *     serve a banner pointing at issues no longer displayed.
   * Always through the canonical WikiFrontmatterSyncer so the Neo4j Document
   * mirror stays consistent. Best-effort: never fails the save task.
   */
  private async syncWikiReviewGate(id: string, save: WikiSaveContext): Promise<void> {
    const ref = this.tasks.get(id)?.refinement;
    if (!ref || !this.frontmatter) return;
    try {
      if (ref.quality.action === "review_required") {
        await this.frontmatter.update(save.path, {
          review: "required",
          review_count: countQualityIssues(ref.quality),
        });
        return;
      }
      const lifecycle = await this.frontmatter.readLifecycle(save.path);
      if (lifecycle.review === "required") {
        await this.frontmatter.update(save.path, { review: "clear", review_count: 0 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[tasks:${id}] wiki-edit review-gate sync failed: ${message}`);
    }
  }

  /**
   * CDS code-intake pipeline (G4.S8.T3): parse the CDS DDL LOCALLY (no docling, no
   * LLM — chunk boundaries are syntax-guaranteed), persist the code ref (markdown +
   * per-view chunks) then drive the SAME llm_wiki + Neo4j ingest stages as a normal
   * doc. Retry re-runs from the retained source.
   */
  private async runCode(id: string): Promise<void> {
    const task = this.tasks.get(id);
    const input = task?.codeSource;
    if (!task || !input) return;

    task.input = input.content;
    const provenance: CodeProvenance = {
      system: input.system,
      devclass: input.devclass,
      transport: input.transport,
    };

    // --- parsing: local CDS parse (the code channel; NOT docling) ---
    if (task.stages.parsing.status !== "done") {
      this.patch(id, (t) => {
        t.status = "parsing";
        t.progress = 15;
        t.stages.parsing = { name: "parsing", status: "running", steps: t.stages.parsing.steps };
      });
      this.setStep(id, "parsing", "read_file", "running");
      try {
        const views = parseCdsViews(input.content);
        if (views.length === 0) {
          throw new Error("CDS source contains no `define view ... }` blocks");
        }
        const stem = slugify(views[0]!.technicalName);
        const fileName = `${stem}.md`;
        const documentId = documentIdFrom(sourceName(input), sourceName(input));
        const stored = await storeCodeOutput(input.content, views, { provenance, stem });
        const markdown = renderCodeMarkdown(views, provenance);
        this.patch(id, (t) => {
          t.stages.parsing = { name: "parsing", status: "done", steps: t.stages.parsing.steps };
          t.cdsViews = views;
          t.documentId = documentId;
          t.markdown = markdown;
          t.fileName = fileName;
          t.progress = 35;
        });
        this.setStep(id, "parsing", "read_file", "done");
        this.setStep(id, "parsing", "parse_ocr_image_desc", "done");

        // --- refinement: no LLM — the local parse IS the code ref ---
        this.patch(id, (t) => {
          t.refinedMarkdown = markdown;
          t.ragMarkdown = markdown;
          t.refinement = stored.ref;
          t.stages.refinement = { name: "refinement", status: "done", steps: t.stages.refinement.steps };
        });
        this.setStep(id, "refinement", "refine_document", "done");
      } catch (err) {
        console.error(`[tasks:${id}] CDS parse FAILED:`, err);
        return this.fail(id, err, "parsing");
      }
    }

    const taskNow = this.tasks.get(id);
    if (!taskNow || !taskNow.fileName || !taskNow.refinement) {
      return this.fail(id, new Error("missing CDS parse output"), "parsing");
    }
    const fileName = taskNow.fileName;
    const markdown = taskNow.markdown!;
    const refinementRef = taskNow.refinement;
    const views = taskNow.cdsViews ?? [];
    const documentId = taskNow.documentId ?? documentIdFrom(sourceName(input), sourceName(input));

    // Classification comes from the stored code ref frontmatter (type=code, topic=code/<system>).
    const preclassified = codePreclassified(refinementRef, fileName);

    const llmwikiTodo = taskNow.stages.ingesting_llmwiki.status !== "done";
    const neo4jTodo = taskNow.stages.ingesting_neo4j.status !== "done";

    await Promise.all([
      (async () => {
        if (!llmwikiTodo) return;
        this.patch(id, (t) => {
          t.status = "ingesting";
          t.stages.ingesting_llmwiki = { name: "ingesting_llmwiki", status: "running", steps: t.stages.ingesting_llmwiki.steps };
          t.progress = 85;
        });
        const res = await this.safeIngest(() =>
          this.ingest.ingestLlmWiki(fileName, markdown, (step, status) => {
            this.setStep(id, "ingesting_llmwiki", step, status);
          }, preclassified, undefined, refinementRef.summary),
        );
        console.log(`[tasks:${id}] llm_wiki ingest (cds): ${res.ok ? "ok" : "FAILED " + (res.error ?? "")}`);
        this.patch(id, (t) => {
          t.stages.ingesting_llmwiki = { name: "ingesting_llmwiki", status: res.ok ? "done" : "failed", ...(res.ok ? {} : { error: res.error }), steps: t.stages.ingesting_llmwiki.steps };
        });
        this.updateProgress(id);
        this.markStageSteps(id, "ingesting_llmwiki", res.ok ? "done" : "failed", res.error);
      })(),
      (async () => {
        if (!neo4jTodo) return;
        this.patch(id, (t) => {
          t.status = "ingesting";
          t.stages.ingesting_neo4j = { name: "ingesting_neo4j", status: "running", steps: t.stages.ingesting_neo4j.steps };
          t.progress = 50;
        });
        this.markStageSteps(id, "ingesting_neo4j", "running");

        const title = views[0]?.technicalName ?? stemTitle(fileName);
        const res = this.neo4j
          ? await this.safeIngest(() => {
              const wikiPath = wikiPathFor(fileName, preclassified);
              return this.neo4j!.ingest({
                ref: refinementRef,
                documentId,
                title,
                ...(wikiPath ? { wikiPath } : {}),
                onProgress: (p) => {
                  if (p.chunksStored > 0 && !this.etaStartAt.has(id)) {
                    this.etaStartAt.set(id, Date.now());
                  }
                  this.patch(id, (t) => {
                    const stage = t.stages.ingesting_neo4j;
                    stage.chunksStored = p.chunksStored;
                    stage.chunksTotal = p.chunksTotal;
                    stage.progress = p.progress;
                    stage.processed = p.chunksStored;
                    stage.total = p.chunksTotal;
                  });
                },
              }).then((r) => {
                // G4.S9.T1: graph content changed → community refresh (async, non-blocking).
                this.refreshCommunities({
                  kind: "ingest",
                  entitiesStored: r.entitiesStored,
                  relationsStored: r.relationsStored,
                  touchedEntityNames: touchedEntityNames(refinementRef),
                });
                return { ok: true, count: r.chunksStored };
              });
            })
          : { ok: true };
        console.log(
          `[tasks:${id}] neo4j ingest (cds): ${res.ok ? "ok" : "FAILED " + (res.error ?? "")}` +
            (res.ok && "count" in res ? ` (${res.count} chunks embedded)` : ""),
        );
        this.patch(id, (t) => {
          t.stages.ingesting_neo4j = {
            ...t.stages.ingesting_neo4j,
            status: res.ok ? "done" : "failed",
            ...(res.ok ? {} : { error: res.error }),
          };
          if (res.ok && this.neo4j) t.neo4jStored = true;
        });
        this.updateProgress(id);
        this.markStageSteps(id, "ingesting_neo4j", res.ok ? "done" : "failed", res.error);
      })(),
    ]);

    // --- finalize ---
    this.patch(id, (t) => {
      const llmwikiOk = t.stages.ingesting_llmwiki.status === "done";
      const neo4jOk = t.neo4jStored === true;
      const failedStage = t.stages.parsing.status === "failed"
        ? t.stages.parsing
        : t.stages.refinement.status === "failed"
          ? t.stages.refinement
          : t.stages.ingesting_llmwiki.status === "failed"
            ? t.stages.ingesting_llmwiki
            : t.stages.ingesting_neo4j.status === "failed"
              ? t.stages.ingesting_neo4j
              : undefined;
      if (llmwikiOk || neo4jOk) {
        t.status = "done";
        t.progress = 100;
        if (failedStage?.error) t.error = failedStage.error;
      } else {
        t.status = "failed";
        t.progress = 100;
        t.error = failedStage?.error ?? "All knowledge systems failed";
      }
    });

    const finalTask = this.tasks.get(id);
    console.log(
      `[tasks:${id}] cds FINAL status=${finalTask?.status} progress=${finalTask?.progress} views=${views.length} llmwiki=${finalTask?.stages.ingesting_llmwiki.status} neo4j=${finalTask?.stages.ingesting_neo4j.status}`,
    );
  }

  /**
   * ABAP code-intake pipeline (G4.S8.T4): parse the ABAP source LOCALLY (no
   * docling, no LLM — chunk boundaries are syntax-guaranteed), persist the code
   * ref (markdown + per-unit chunks) then drive the SAME llm_wiki + Neo4j ingest
   * stages as a normal doc. Retry re-runs from the retained source.
   */
  private async runAbap(id: string): Promise<void> {
    const task = this.tasks.get(id);
    const input = task?.abapSource;
    if (!task || !input) return;

    task.input = input.content;
    const provenance: CodeProvenance = {
      system: input.system,
      devclass: input.devclass,
      transport: input.transport,
    };

    // --- parsing: local ABAP parse (the code channel; NOT docling) ---
    if (task.stages.parsing.status !== "done") {
      this.patch(id, (t) => {
        t.status = "parsing";
        t.progress = 15;
        t.stages.parsing = { name: "parsing", status: "running", steps: t.stages.parsing.steps };
      });
      this.setStep(id, "parsing", "read_file", "running");
      try {
        const units = parseAbapUnits(input.content, {
          devclass: input.devclass ?? null,
          system: input.system ?? null,
        });
        if (units.length === 0) {
          throw new Error("ABAP source contains no CLASS/REPORT/FUNCTION/INCLUDE units");
        }
        const stem = slugify(units[0]!.devName);
        const fileName = `${stem}.md`;
        const documentId = documentIdFrom(abapSourceName(input), abapSourceName(input));
        const stored = await storeAbapOutput(units, { provenance, stem });
        const markdown = renderAbapMarkdown(units, provenance);
        this.patch(id, (t) => {
          t.stages.parsing = { name: "parsing", status: "done", steps: t.stages.parsing.steps };
          t.abapUnits = units;
          t.documentId = documentId;
          t.markdown = markdown;
          t.fileName = fileName;
          t.progress = 35;
        });
        this.setStep(id, "parsing", "read_file", "done");
        this.setStep(id, "parsing", "parse_ocr_image_desc", "done");

        // --- refinement: no LLM — the local parse IS the code ref ---
        this.patch(id, (t) => {
          t.refinedMarkdown = markdown;
          t.ragMarkdown = markdown;
          t.refinement = stored.ref;
          t.stages.refinement = { name: "refinement", status: "done", steps: t.stages.refinement.steps };
        });
        this.setStep(id, "refinement", "refine_document", "done");
      } catch (err) {
        console.error(`[tasks:${id}] ABAP parse FAILED:`, err);
        return this.fail(id, err, "parsing");
      }
    }

    const taskNow = this.tasks.get(id);
    if (!taskNow || !taskNow.fileName || !taskNow.refinement) {
      return this.fail(id, new Error("missing ABAP parse output"), "parsing");
    }
    const fileName = taskNow.fileName;
    const markdown = taskNow.markdown!;
    const refinementRef = taskNow.refinement;
    const units = taskNow.abapUnits ?? [];
    const documentId = taskNow.documentId ?? documentIdFrom(abapSourceName(input), abapSourceName(input));

    // Classification comes from the stored code ref frontmatter (type=code, topic=code/<system>).
    const preclassified = codePreclassified(refinementRef, fileName);

    const llmwikiTodo = taskNow.stages.ingesting_llmwiki.status !== "done";
    const neo4jTodo = taskNow.stages.ingesting_neo4j.status !== "done";

    await Promise.all([
      (async () => {
        if (!llmwikiTodo) return;
        this.patch(id, (t) => {
          t.status = "ingesting";
          t.stages.ingesting_llmwiki = { name: "ingesting_llmwiki", status: "running", steps: t.stages.ingesting_llmwiki.steps };
          t.progress = 85;
        });
        const res = await this.safeIngest(() =>
          this.ingest.ingestLlmWiki(fileName, markdown, (step, status) => {
            this.setStep(id, "ingesting_llmwiki", step, status);
          }, preclassified, undefined, refinementRef.summary),
        );
        console.log(`[tasks:${id}] llm_wiki ingest (abap): ${res.ok ? "ok" : "FAILED " + (res.error ?? "")}`);
        this.patch(id, (t) => {
          t.stages.ingesting_llmwiki = { name: "ingesting_llmwiki", status: res.ok ? "done" : "failed", ...(res.ok ? {} : { error: res.error }), steps: t.stages.ingesting_llmwiki.steps };
        });
        this.updateProgress(id);
        this.markStageSteps(id, "ingesting_llmwiki", res.ok ? "done" : "failed", res.error);
      })(),
      (async () => {
        if (!neo4jTodo) return;
        this.patch(id, (t) => {
          t.status = "ingesting";
          t.stages.ingesting_neo4j = { name: "ingesting_neo4j", status: "running", steps: t.stages.ingesting_neo4j.steps };
          t.progress = 50;
        });
        this.markStageSteps(id, "ingesting_neo4j", "running");

        const title = units[0]?.devName ?? stemTitle(fileName);
        const res = this.neo4j
          ? await this.safeIngest(() => {
              const wikiPath = wikiPathFor(fileName, preclassified);
              return this.neo4j!.ingest({
                ref: refinementRef,
                documentId,
                title,
                ...(wikiPath ? { wikiPath } : {}),
                onProgress: (p) => {
                  if (p.chunksStored > 0 && !this.etaStartAt.has(id)) {
                    this.etaStartAt.set(id, Date.now());
                  }
                  this.patch(id, (t) => {
                    const stage = t.stages.ingesting_neo4j;
                    stage.chunksStored = p.chunksStored;
                    stage.chunksTotal = p.chunksTotal;
                    stage.progress = p.progress;
                    stage.processed = p.chunksStored;
                    stage.total = p.chunksTotal;
                  });
                },
              }).then((r) => {
                // G4.S9.T1: graph content changed → community refresh (async, non-blocking).
                this.refreshCommunities({
                  kind: "ingest",
                  entitiesStored: r.entitiesStored,
                  relationsStored: r.relationsStored,
                  touchedEntityNames: touchedEntityNames(refinementRef),
                });
                return { ok: true, count: r.chunksStored };
              });
            })
          : { ok: true };
        console.log(
          `[tasks:${id}] neo4j ingest (abap): ${res.ok ? "ok" : "FAILED " + (res.error ?? "")}` +
            (res.ok && "count" in res ? ` (${res.count} chunks embedded)` : ""),
        );
        this.patch(id, (t) => {
          t.stages.ingesting_neo4j = {
            ...t.stages.ingesting_neo4j,
            status: res.ok ? "done" : "failed",
            ...(res.ok ? {} : { error: res.error }),
          };
          if (res.ok && this.neo4j) t.neo4jStored = true;
        });
        this.updateProgress(id);
        this.markStageSteps(id, "ingesting_neo4j", res.ok ? "done" : "failed", res.error);
      })(),
    ]);

    // --- finalize ---
    this.patch(id, (t) => {
      const llmwikiOk = t.stages.ingesting_llmwiki.status === "done";
      const neo4jOk = t.neo4jStored === true;
      const failedStage = t.stages.parsing.status === "failed"
        ? t.stages.parsing
        : t.stages.refinement.status === "failed"
          ? t.stages.refinement
          : t.stages.ingesting_llmwiki.status === "failed"
            ? t.stages.ingesting_llmwiki
            : t.stages.ingesting_neo4j.status === "failed"
              ? t.stages.ingesting_neo4j
              : undefined;
      if (llmwikiOk || neo4jOk) {
        t.status = "done";
        t.progress = 100;
        if (failedStage?.error) t.error = failedStage.error;
      } else {
        t.status = "failed";
        t.progress = 100;
        t.error = failedStage?.error ?? "All knowledge systems failed";
      }
    });

    const finalTask = this.tasks.get(id);
    console.log(
      `[tasks:${id}] abap FINAL status=${finalTask?.status} progress=${finalTask?.progress} units=${units.length} llmwiki=${finalTask?.stages.ingesting_llmwiki.status} neo4j=${finalTask?.stages.ingesting_neo4j.status}`,
    );
  }

  /**
   * UI5 code-intake pipeline (G4.S8.T5): parse the UI5 app's business files
   * LOCALLY (no docling, no LLM — boundaries are file/method-guaranteed),
   * persist the code ref (markdown + per-file/per-method chunks) then drive the
   * SAME llm_wiki + Neo4j ingest stages as a normal doc. node_modules/dist are
   * excluded so only business code (webapp/) reaches the KB. Retry re-runs from
   * the retained file map.
   */
  private async runUi5(id: string): Promise<void> {
    const task = this.tasks.get(id);
    const input = task?.ui5Source;
    if (!task || !input) return;

    task.input = JSON.stringify(input.files).slice(0, 200) || "";
    const provenance: CodeProvenance = {
      system: input.system,
      devclass: input.devclass,
      transport: input.transport,
      // G4.S8.T11: UI5 pages group in the topic tree by their app component
      // namespace — carry it into the wiki frontmatter.
      component: input.component,
    };

    // --- parsing: local UI5 parse (the code channel; NOT docling) ---
    if (task.stages.parsing.status !== "done") {
      this.patch(id, (t) => {
        t.status = "parsing";
        t.progress = 15;
        t.stages.parsing = { name: "parsing", status: "running", steps: t.stages.parsing.steps };
      });
      this.setStep(id, "parsing", "read_file", "running");
      try {
        const units = parseUi5Units(input.files, { component: input.component ?? "app" });
        if (units.length === 0) {
          throw new Error("UI5 source contains no business files (controllers/views/manifest) under webapp/");
        }
        const stem = slugify(units[0]!.name);
        const fileName = `${stem}.md`;
        const documentId = documentIdFrom(ui5SourceName(input), ui5SourceName(input));
        const stored = await storeUi5Output(units, { provenance, stem });
        const markdown = renderUi5Markdown(units, provenance);
        this.patch(id, (t) => {
          t.stages.parsing = { name: "parsing", status: "done", steps: t.stages.parsing.steps };
          t.ui5Units = units;
          t.documentId = documentId;
          t.markdown = markdown;
          t.fileName = fileName;
          t.progress = 35;
        });
        this.setStep(id, "parsing", "read_file", "done");
        this.setStep(id, "parsing", "parse_ocr_image_desc", "done");

        // --- refinement: no LLM — the local parse IS the code ref ---
        this.patch(id, (t) => {
          t.refinedMarkdown = markdown;
          t.ragMarkdown = markdown;
          t.refinement = stored.ref;
          t.stages.refinement = { name: "refinement", status: "done", steps: t.stages.refinement.steps };
        });
        this.setStep(id, "refinement", "refine_document", "done");
      } catch (err) {
        console.error(`[tasks:${id}] UI5 parse FAILED:`, err);
        return this.fail(id, err, "parsing");
      }
    }

    const taskNow = this.tasks.get(id);
    if (!taskNow || !taskNow.fileName || !taskNow.refinement) {
      return this.fail(id, new Error("missing UI5 parse output"), "parsing");
    }
    const fileName = taskNow.fileName;
    const markdown = taskNow.markdown!;
    const refinementRef = taskNow.refinement;
    const units = taskNow.ui5Units ?? [];
    const documentId = taskNow.documentId ?? documentIdFrom(ui5SourceName(input), ui5SourceName(input));

    // Classification comes from the stored code ref frontmatter (type=code, topic=code/<system>).
    const preclassified = codePreclassified(refinementRef, fileName);

    const llmwikiTodo = taskNow.stages.ingesting_llmwiki.status !== "done";
    const neo4jTodo = taskNow.stages.ingesting_neo4j.status !== "done";

    await Promise.all([
      (async () => {
        if (!llmwikiTodo) return;
        this.patch(id, (t) => {
          t.status = "ingesting";
          t.stages.ingesting_llmwiki = { name: "ingesting_llmwiki", status: "running", steps: t.stages.ingesting_llmwiki.steps };
          t.progress = 85;
        });
        const res = await this.safeIngest(() =>
          this.ingest.ingestLlmWiki(fileName, markdown, (step, status) => {
            this.setStep(id, "ingesting_llmwiki", step, status);
          }, preclassified, undefined, refinementRef.summary),
        );
        console.log(`[tasks:${id}] llm_wiki ingest (ui5): ${res.ok ? "ok" : "FAILED " + (res.error ?? "")}`);
        this.patch(id, (t) => {
          t.stages.ingesting_llmwiki = { name: "ingesting_llmwiki", status: res.ok ? "done" : "failed", ...(res.ok ? {} : { error: res.error }), steps: t.stages.ingesting_llmwiki.steps };
        });
        this.updateProgress(id);
        this.markStageSteps(id, "ingesting_llmwiki", res.ok ? "done" : "failed", res.error);
      })(),
      (async () => {
        if (!neo4jTodo) return;
        this.patch(id, (t) => {
          t.status = "ingesting";
          t.stages.ingesting_neo4j = { name: "ingesting_neo4j", status: "running", steps: t.stages.ingesting_neo4j.steps };
          t.progress = 50;
        });
        this.markStageSteps(id, "ingesting_neo4j", "running");

        const title = units[0]?.name ?? stemTitle(fileName);
        const res = this.neo4j
          ? await this.safeIngest(() => {
              const wikiPath = wikiPathFor(fileName, preclassified);
              return this.neo4j!.ingest({
                ref: refinementRef,
                documentId,
                title,
                ...(wikiPath ? { wikiPath } : {}),
                onProgress: (p) => {
                  if (p.chunksStored > 0 && !this.etaStartAt.has(id)) {
                    this.etaStartAt.set(id, Date.now());
                  }
                  this.patch(id, (t) => {
                    const stage = t.stages.ingesting_neo4j;
                    stage.chunksStored = p.chunksStored;
                    stage.chunksTotal = p.chunksTotal;
                    stage.progress = p.progress;
                    stage.processed = p.chunksStored;
                    stage.total = p.chunksTotal;
                  });
                },
              }).then((r) => {
                // G4.S9.T1: graph content changed → community refresh (async, non-blocking).
                this.refreshCommunities({
                  kind: "ingest",
                  entitiesStored: r.entitiesStored,
                  relationsStored: r.relationsStored,
                  touchedEntityNames: touchedEntityNames(refinementRef),
                });
                return { ok: true, count: r.chunksStored };
              });
            })
          : { ok: true };
        console.log(
          `[tasks:${id}] neo4j ingest (ui5): ${res.ok ? "ok" : "FAILED " + (res.error ?? "")}` +
            (res.ok && "count" in res ? ` (${res.count} chunks embedded)` : ""),
        );
        this.patch(id, (t) => {
          t.stages.ingesting_neo4j = {
            ...t.stages.ingesting_neo4j,
            status: res.ok ? "done" : "failed",
            ...(res.ok ? {} : { error: res.error }),
          };
          if (res.ok && this.neo4j) t.neo4jStored = true;
        });
        this.updateProgress(id);
        this.markStageSteps(id, "ingesting_neo4j", res.ok ? "done" : "failed", res.error);
      })(),
    ]);

    // --- finalize ---
    this.patch(id, (t) => {
      const llmwikiOk = t.stages.ingesting_llmwiki.status === "done";
      const neo4jOk = t.neo4jStored === true;
      const failedStage = t.stages.parsing.status === "failed"
        ? t.stages.parsing
        : t.stages.refinement.status === "failed"
          ? t.stages.refinement
          : t.stages.ingesting_llmwiki.status === "failed"
            ? t.stages.ingesting_llmwiki
            : t.stages.ingesting_neo4j.status === "failed"
              ? t.stages.ingesting_neo4j
              : undefined;
      if (llmwikiOk || neo4jOk) {
        t.status = "done";
        t.progress = 100;
        if (failedStage?.error) t.error = failedStage.error;
      } else {
        t.status = "failed";
        t.progress = 100;
        t.error = failedStage?.error ?? "All knowledge systems failed";
      }
    });

    const finalTask = this.tasks.get(id);
    console.log(
      `[tasks:${id}] ui5 FINAL status=${finalTask?.status} progress=${finalTask?.progress} units=${units.length} llmwiki=${finalTask?.stages.ingesting_llmwiki.status} neo4j=${finalTask?.stages.ingesting_neo4j.status}`,
    );
  }

  /**
   * DDIC table-structure intake pipeline (G4.S8.T9): parse the JSON table
   * descriptors LOCALLY (no docling, no LLM — chunk boundaries are
   * table/field-group-guaranteed), persist the code ref (markdown + header +
   * field-group chunks) then drive the SAME llm_wiki + Neo4j ingest stages as a
   * normal doc. Table entities + foreign-key REFERENCES edges (external targets
   * included) flow into the graph. Retry re-runs from the retained source.
   */
  private async runDdic(id: string): Promise<void> {
    const task = this.tasks.get(id);
    const input = task?.ddicSource;
    if (!task || !input) return;

    task.input = input.content;
    const provenance: CodeProvenance = {
      system: input.system,
      devclass: input.devclass,
      transport: input.transport,
    };

    // --- parsing: local DDIC parse (the code channel; NOT docling) ---
    if (task.stages.parsing.status !== "done") {
      this.patch(id, (t) => {
        t.status = "parsing";
        t.progress = 15;
        t.stages.parsing = { name: "parsing", status: "running", steps: t.stages.parsing.steps };
      });
      this.setStep(id, "parsing", "read_file", "running");
      try {
        const tables = parseDdicTables(input.content);
        if (tables.length === 0) {
          throw new Error("DDIC source contains no table descriptors");
        }
        const stem = slugify(tables[0]!.name);
        const fileName = `${stem}.md`;
        const documentId = documentIdFrom(ddicSourceName(input), ddicSourceName(input));
        const stored = await storeDdicOutput(tables, { provenance, stem });
        const markdown = renderDdicMarkdown(tables, provenance);
        this.patch(id, (t) => {
          t.stages.parsing = { name: "parsing", status: "done", steps: t.stages.parsing.steps };
          t.ddicTables = tables;
          t.documentId = documentId;
          t.markdown = markdown;
          t.fileName = fileName;
          t.progress = 35;
        });
        this.setStep(id, "parsing", "read_file", "done");
        this.setStep(id, "parsing", "parse_ocr_image_desc", "done");

        // --- refinement: no LLM — the local parse IS the code ref ---
        this.patch(id, (t) => {
          t.refinedMarkdown = markdown;
          t.ragMarkdown = markdown;
          t.refinement = stored.ref;
          t.stages.refinement = { name: "refinement", status: "done", steps: t.stages.refinement.steps };
        });
        this.setStep(id, "refinement", "refine_document", "done");
      } catch (err) {
        console.error(`[tasks:${id}] DDIC parse FAILED:`, err);
        return this.fail(id, err, "parsing");
      }
    }

    const taskNow = this.tasks.get(id);
    if (!taskNow || !taskNow.fileName || !taskNow.refinement) {
      return this.fail(id, new Error("missing DDIC parse output"), "parsing");
    }
    const fileName = taskNow.fileName;
    const markdown = taskNow.markdown!;
    const refinementRef = taskNow.refinement;
    const tables = taskNow.ddicTables ?? [];
    const documentId = taskNow.documentId ?? documentIdFrom(ddicSourceName(input), ddicSourceName(input));

    // Classification comes from the stored code ref frontmatter (type=code, topic=code/<system>).
    const preclassified = codePreclassified(refinementRef, fileName);

    const llmwikiTodo = taskNow.stages.ingesting_llmwiki.status !== "done";
    const neo4jTodo = taskNow.stages.ingesting_neo4j.status !== "done";

    await Promise.all([
      (async () => {
        if (!llmwikiTodo) return;
        this.patch(id, (t) => {
          t.status = "ingesting";
          t.stages.ingesting_llmwiki = { name: "ingesting_llmwiki", status: "running", steps: t.stages.ingesting_llmwiki.steps };
          t.progress = 85;
        });
        const res = await this.safeIngest(() =>
          this.ingest.ingestLlmWiki(fileName, markdown, (step, status) => {
            this.setStep(id, "ingesting_llmwiki", step, status);
          }, preclassified, undefined, refinementRef.summary),
        );
        console.log(`[tasks:${id}] llm_wiki ingest (ddic): ${res.ok ? "ok" : "FAILED " + (res.error ?? "")}`);
        this.patch(id, (t) => {
          t.stages.ingesting_llmwiki = { name: "ingesting_llmwiki", status: res.ok ? "done" : "failed", ...(res.ok ? {} : { error: res.error }), steps: t.stages.ingesting_llmwiki.steps };
        });
        this.updateProgress(id);
        this.markStageSteps(id, "ingesting_llmwiki", res.ok ? "done" : "failed", res.error);
      })(),
      (async () => {
        if (!neo4jTodo) return;
        this.patch(id, (t) => {
          t.status = "ingesting";
          t.stages.ingesting_neo4j = { name: "ingesting_neo4j", status: "running", steps: t.stages.ingesting_neo4j.steps };
          t.progress = 50;
        });
        this.markStageSteps(id, "ingesting_neo4j", "running");

        const title = tables[0]?.name ?? stemTitle(fileName);
        const res = this.neo4j
          ? await this.safeIngest(() => {
              const wikiPath = wikiPathFor(fileName, preclassified);
              return this.neo4j!.ingest({
                ref: refinementRef,
                documentId,
                title,
                ...(wikiPath ? { wikiPath } : {}),
                onProgress: (p) => {
                  if (p.chunksStored > 0 && !this.etaStartAt.has(id)) {
                    this.etaStartAt.set(id, Date.now());
                  }
                  this.patch(id, (t) => {
                    const stage = t.stages.ingesting_neo4j;
                    stage.chunksStored = p.chunksStored;
                    stage.chunksTotal = p.chunksTotal;
                    stage.progress = p.progress;
                    stage.processed = p.chunksStored;
                    stage.total = p.chunksTotal;
                  });
                },
              }).then((r) => {
                // G4.S9.T1: graph content changed → community refresh (async, non-blocking).
                this.refreshCommunities({
                  kind: "ingest",
                  entitiesStored: r.entitiesStored,
                  relationsStored: r.relationsStored,
                  touchedEntityNames: touchedEntityNames(refinementRef),
                });
                return { ok: true, count: r.chunksStored };
              });
            })
          : { ok: true };
        console.log(
          `[tasks:${id}] neo4j ingest (ddic): ${res.ok ? "ok" : "FAILED " + (res.error ?? "")}` +
            (res.ok && "count" in res ? ` (${res.count} chunks embedded)` : ""),
        );
        this.patch(id, (t) => {
          t.stages.ingesting_neo4j = {
            ...t.stages.ingesting_neo4j,
            status: res.ok ? "done" : "failed",
            ...(res.ok ? {} : { error: res.error }),
          };
          if (res.ok && this.neo4j) t.neo4jStored = true;
        });
        this.updateProgress(id);
        this.markStageSteps(id, "ingesting_neo4j", res.ok ? "done" : "failed", res.error);
      })(),
    ]);

    // --- finalize ---
    this.patch(id, (t) => {
      const llmwikiOk = t.stages.ingesting_llmwiki.status === "done";
      const neo4jOk = t.neo4jStored === true;
      const failedStage = t.stages.parsing.status === "failed"
        ? t.stages.parsing
        : t.stages.refinement.status === "failed"
          ? t.stages.refinement
          : t.stages.ingesting_llmwiki.status === "failed"
            ? t.stages.ingesting_llmwiki
            : t.stages.ingesting_neo4j.status === "failed"
              ? t.stages.ingesting_neo4j
              : undefined;
      if (llmwikiOk || neo4jOk) {
        t.status = "done";
        t.progress = 100;
        if (failedStage?.error) t.error = failedStage.error;
      } else {
        t.status = "failed";
        t.progress = 100;
        t.error = failedStage?.error ?? "All knowledge systems failed";
      }
    });

    const finalTask = this.tasks.get(id);
    console.log(
      `[tasks:${id}] ddic FINAL status=${finalTask?.status} progress=${finalTask?.progress} tables=${tables.length} llmwiki=${finalTask?.stages.ingesting_llmwiki.status} neo4j=${finalTask?.stages.ingesting_neo4j.status}`,
    );
  }

  /**
   * Mechanical wiki-edit refine (G4.S3.T10): store the corrected text verbatim
   * with heading-derived chunks (no fabricated entities/relations) and flag the
   * task review_required — used when the diff-refine LLM is unavailable/failed.
   */
  private async mechanicalWikiEditRefine(id: string, save: WikiSaveContext, error: unknown): Promise<void> {
    const fallback = fallbackWikiEditRefinement(
      { markdown: save.afterRag, before: save.beforeRag, diff: save.diff, structural: save.structural },
      { ...(save.type ? { type: save.type } : {}), ...(save.topic ? { topic: save.topic } : {}) },
      error,
    );
    const ref = await storeRefinementOutput(fallback, this.wikiRefineStorageDir, {
      stem: deriveStemWithFileName(save.afterRag, save.path),
    });
    this.patch(id, (t) => {
      t.refinedMarkdown = fallback.markdown;
      t.refinement = ref;
      t.wikiEdit = { newEntities: [], newRelations: [], rechunked: fallback.rechunked };
      t.reviewRequired = true;
      t.stages.refinement = { name: "refinement", status: "done", steps: t.stages.refinement.steps };
    });
    this.setStep(id, "refinement", "refine_document", "done");
  }

  /** Mark a task as done because its content is a duplicate of an existing doc. */
  private markDedup(id: string, method: "hash" | "chunks" | undefined, existingSource: string | undefined): void {
    this.patch(id, (t) => {
      t.status = "done";
      t.progress = 100;
      t.dedup = { duplicate: true, ...(method ? { method } : {}), ...(existingSource ? { existingSource } : {}) };
      t.error = undefined;
      // Parsing succeeded; the two ingest stages were skipped (not failed).
      t.stages.parsing = { ...t.stages.parsing, status: "done" };
    });
    this.markStageSteps(id, "parsing", "done");
  }

  /**
   * Re-run only the failed stages of a finished task. Successful stages are
   * left untouched. Starts the retry asynchronously and returns the task,
   * which already reflects the running state (progress/stages) by the time
   * this returns; callers poll GET /api/kb/task/:id for the final result.
   *
   * @throws TaskNotFoundError when no such task exists
   * @throws TaskBusyError when the task is still running
   * @throws NothingToRetryError when no stage is failed (or input is missing)
   */
  retry(taskId: string): IngestTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new TaskNotFoundError(`task not found: ${taskId}`);
    if (task.status === "pending" || task.status === "parsing" || task.status === "ingesting") {
      throw new TaskBusyError(`task is still running: ${taskId}`);
    }
    if (!task.input && !task.wikiSave) throw new NothingToRetryError(`task has no parse input to retry: ${taskId}`);
    const failedStages = (["parsing", "refinement", "ingesting_llmwiki", "ingesting_neo4j"] as const).filter(
      (name) => task.stages[name].status === "failed",
    );
    if (failedStages.length === 0) {
      throw new NothingToRetryError(`task has no failed stages to retry: ${taskId}`);
    }
    this.patch(taskId, (t) => {
      t.error = undefined;
      // Reset the top-level status to a running state NOW (synchronously) so
      // callers polling right after retry() see the task as in-progress, not
      // the old terminal state. run() will refine it to parsing/refining/ingesting.
      const reRunParsing = failedStages.includes("parsing");
      const reRunRefinement = failedStages.includes("refinement");
      t.status = reRunParsing ? "parsing" : reRunRefinement ? "refining" : "ingesting";
      for (const name of failedStages) {
        t.stages[name] = initialStage(name);
        // A re-run Neo4j stage restarts its per-chunk ETA baseline (G4.S3.T9).
        if (name === "ingesting_neo4j") this.etaStartAt.delete(taskId);
      }
    });
    if (task.wikiSave) {
      void this.runWikiSave(taskId);
    } else if (task.codeSource) {
      void this.runCode(taskId);
    } else if (task.abapSource) {
      void this.runAbap(taskId);
    } else if (task.ui5Source) {
      void this.runUi5(taskId);
    } else if (task.ddicSource) {
      void this.runDdic(taskId);
    } else {
      void this.run(taskId, task.input!, task.source);
    }
    return task;
  }

  private async safeIngest(fn: () => Promise<SystemIngestStatus>): Promise<SystemIngestStatus> {
    try {
      return await fn();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** G4.S1.T6: delete the File B RAG working copy once RAG ingestion is done. Best-effort
   *  (the in-memory `task.ragMarkdown` is retained for retries). Never touches File A′. */
  private async deleteWorkingCopy(ref: RefineOutputRef | undefined): Promise<void> {
    if (!ref?.rag_md_ref || ref.rag_md_ref === ref.md_ref) return;
    try {
      await unlink(ref.rag_md_ref);
      console.log(`[tasks] deleted File B RAG working copy: ${ref.rag_md_ref}`);
    } catch {
      // best-effort cleanup — a missing/already-deleted file is fine
    }
  }

  /** Classify-and-wrap is best-effort: if it fails, ingestion falls back to the
   *  raw markdown (no frontmatter). */
  private async safePrepare(fn: () => Promise<{ classification: WikiClassification; frontmatterContent: string }>): Promise<
    { classification: WikiClassification; frontmatterContent: string } | undefined
  > {
    try {
      return await fn();
    } catch {
      return undefined;
    }
  }

  private fail(id: string, err: unknown, stage: TaskStageName): void {
    const message = err instanceof Error ? err.message : String(err);
    this.patch(id, (t) => {
      t.status = "failed";
      t.error = message;
      t.stages[stage] = { name: stage, status: "failed", error: message, steps: t.stages[stage].steps };
    });
    this.markStageSteps(id, stage, "failed", message);
  }
}
