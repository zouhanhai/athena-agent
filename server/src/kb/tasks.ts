/**
 * IngestTaskQueue + IngestCoordinator - async ingestion task tracking (G2.S5.T2).
 *
 * In-memory queue (POC) that drives the full pipeline for one source:
 *   docling parsing → LightRAG ingesting → llm_wiki ingesting → done / failed.
 * Per-system stage status is tracked independently, so a task can finish with
 * LightRAG ok but llm_wiki failed (and vice versa).
 */
import { randomUUID } from "node:crypto";
import type { DoclingParser } from "./docling.js";
import type { KnowledgeIngestService, SystemIngestStatus } from "./ingest.js";
import type { LlmWikiStepName } from "./ingest.js";
import { documentIdFrom, extractPageTitle, stemTitle } from "./ingest.js";
import type { WikiClassification } from "./llmwiki.js";
import type { ContentDedupStore } from "./dedup.js";
import {
  LightRagTrackPoller,
  type LightRagTrackOutcome,
  type LightRagTrackProgress,
} from "./lightrag-track.js";
import type { LightRagPipelineStatus, LightRagTrackStatus } from "./lightrag.js";

export type TaskStageName = "parsing" | "ingesting_lightrag" | "ingesting_llmwiki";
export type StageStatus = "pending" | "running" | "done" | "failed";
export type TaskStatus = "pending" | "parsing" | "ingesting" | "done" | "failed";

/** Per-system sub-step name (G3.S5.T2). */
export type DoclingStepName = "read_file" | "parse_ocr_image_desc";
export type LightRagStepName = "chunking" | "entity_extraction" | "graph_build" | "embedding";
export type StepName = DoclingStepName | LightRagStepName | LlmWikiStepName;

export interface TaskStep {
  name: StepName;
  status: StageStatus;
  error?: string;
}

export interface TaskStage {
  name: TaskStageName;
  status: StageStatus;
  error?: string;
  steps: TaskStep[];
}

const LIGHTRAG_STEPS: LightRagStepName[] = ["chunking", "entity_extraction", "graph_build", "embedding"];

/** Fresh pending sub-steps for a stage, e.g. `["read_file", "parse_ocr_image_desc"]`. */
export function initialSteps(stage: TaskStageName): TaskStep[] {
  switch (stage) {
    case "parsing":
      return [
        { name: "read_file", status: "pending" },
        { name: "parse_ocr_image_desc", status: "pending" },
      ];
    case "ingesting_lightrag":
      return LIGHTRAG_STEPS.map((name) => ({ name, status: "pending" }));
    case "ingesting_llmwiki":
      return [
        { name: "classify", status: "pending" },
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
  /** Parse input (file path or URL) retained so retry can re-run docling. */
  input?: string;
  /** Parsed markdown retained so retry can re-run ingest stages without re-parsing. */
  markdown?: string;
  /** Derived ingest filename (`<documentId>.md`) retained for retry. */
  fileName?: string;
  status: TaskStatus;
  /** Overall progress 0-100. */
  progress: number;
  stages: {
    parsing: TaskStage;
    ingesting_lightrag: TaskStage;
    ingesting_llmwiki: TaskStage;
  };
  documentId?: string;
  error?: string;
  /** Content dedup outcome (G2.S5.T14). Present when the doc was skipped as a
   *  duplicate: exact normalized-hash match or long-doc chunk-sequence match. */
  dedup?: {
    duplicate: boolean;
    method?: "hash" | "chunks";
    existingSource?: string;
  };
  /** Layer-2 semantic near-duplicate notice (G2.S5.T14): file path of an
   *  existing doc that LightRAG found highly similar. Best-effort. */
  nearDuplicate?: string;
  /** Real LightRAG backend state + chunk progress (G3.S5.T3). Set once the
   *  LightRAG stage starts; reflects the actual /documents status, never a
   *  false "done" at submit time. */
  lightrag?: LightRagTrackProgress & {
    /** LightRAG submission track id, used to poll /documents/track_status. */
    trackId?: string;
    error?: string;
  };
  createdAt: number;
  updatedAt: number;
}

/** Thrown when retry() is asked to re-run an unknown task. */
export class TaskNotFoundError extends Error {}
/** Thrown when retry() is asked to re-run a task that is still running. */
export class TaskBusyError extends Error {}
/** Thrown when retry() finds no failed stage worth re-running. */
export class NothingToRetryError extends Error {}

export interface IngestTaskQueueOptions {
  parser: DoclingParser;
  ingest: KnowledgeIngestService;
  /** Optional content-dedup store (G2.S5.T14). When set, identical content is
   *  skipped before the pipelines run; newly stored content is recorded. */
  dedup?: ContentDedupStore;
  /** Poll interval (ms) between LightRAG track-status checks. Default: 1500. */
  lightragPollIntervalMs?: number;
  /** Max time (ms) to wait for LightRAG to process before failing. Default: 10 min. */
  lightragWaitTimeoutMs?: number;
  /** Injectable sleep for the LightRAG poll loop (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export interface IngestSubmitResult {
  taskId: string;
}

function initialStages(): IngestTask["stages"] {
  return {
    parsing: initialStage("parsing"),
    ingesting_lightrag: initialStage("ingesting_lightrag"),
    ingesting_llmwiki: initialStage("ingesting_llmwiki"),
  };
}

export class IngestTaskQueue {
  private readonly parser: DoclingParser;
  private readonly ingest: KnowledgeIngestService;
  private readonly dedup?: ContentDedupStore;
  private readonly tasks = new Map<string, IngestTask>();
  private readonly lightragPoller: LightRagTrackPoller;

  constructor(options: IngestTaskQueueOptions) {
    this.parser = options.parser;
    this.ingest = options.ingest;
    this.dedup = options.dedup;
    // The poller reads real status through the ingest service (which owns the
    // LightRAG client); tests inject fakes that resolve it directly.
    const service = this.ingest as KnowledgeIngestService & {
      getLightRagTrackStatus?: (trackId: string) => Promise<LightRagTrackStatus>;
      getLightRagPipelineStatus?: () => Promise<LightRagPipelineStatus>;
    };
    this.lightragPoller = new LightRagTrackPoller({
      getTrackStatus: (trackId) =>
        service.getLightRagTrackStatus?.(trackId) ??
        Promise.resolve({ track_id: trackId, documents: [], total_count: 0 }),
      getPipelineStatus: () => service.getLightRagPipelineStatus?.(),
      pollIntervalMs: options.lightragPollIntervalMs,
      timeoutMs: options.lightragWaitTimeoutMs,
      sleep: options.sleep,
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

  private patch(id: string, mutator: (task: IngestTask) => void): void {
    const task = this.tasks.get(id);
    if (!task) return;
    mutator(task);
    task.updatedAt = Date.now();
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

  /** Reflect one LightRAG poll outcome on the task (G3.S5.T3). Called on every
   *  poll tick so the task tracks the REAL backend status while it processes. */
  private applyLightRagProgress(id: string, outcome: LightRagTrackOutcome): void {
    this.patch(id, (t) => {
      t.lightrag = {
        ...t.lightrag,
        backendStatus: outcome.backendStatus,
        chunksProcessed: outcome.chunksProcessed,
        chunksCount: outcome.chunksCount,
      };
    });
    // Chunking is finished once the chunk total is known (LightRAG sets
    // chunks_count when it transitions into PROCESSING).
    if (typeof outcome.chunksCount === "number" && outcome.chunksCount > 0) {
      this.setStep(id, "ingesting_lightrag", "chunking", "done");
    }
  }

  private async run(id: string, input: string, source: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) return;
    task.input = input;

    let markdown = task.markdown;
    let fileName = task.fileName;
    // G3.S8.T2: classification computed once before the LightRAG stage so both
    // systems receive the SAME type+topic (LightRAG via frontmatter, llm_wiki
    // via the preclassified result). Undefined when only the llm_wiki stage is
    // re-run on retry (then it classifies internally as before).
    let preclassified: WikiClassification | undefined;
    // G3.S8.T2: frontmatter-wrapped content computed during classify-first,
    // reused by the parallel LightRAG stage. Declared at run() scope so the
    // parallel async branch can read it.
    let preparedContent: string | undefined;

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

    // --- Ingesting: classify once, then LightRAG + llm_wiki run in PARALLEL ---
    const lightragTodo = task.stages.ingesting_lightrag.status !== "done";
    const llmwikiTodo = task.stages.ingesting_llmwiki.status !== "done";

    // Classify FIRST (shared by both systems) so LightRAG gets content WITH
    // frontmatter (type + topic). Only needed when either stage still runs.
    if ((lightragTodo || llmwikiTodo) && !preclassified) {
      this.patch(id, (t) => {
        t.status = "ingesting";
        if (lightragTodo) t.stages.ingesting_lightrag = { name: "ingesting_lightrag", status: "running", steps: t.stages.ingesting_lightrag.steps };
        if (llmwikiTodo) t.stages.ingesting_llmwiki = { name: "ingesting_llmwiki", status: "running", steps: t.stages.ingesting_llmwiki.steps };
        t.progress = 50;
      });
      this.markStageSteps(id, "ingesting_lightrag", "running");
      const prepared = await this.safePrepare(() =>
        this.ingest.prepareForIngest({ title: extractPageTitle(markdown!) ?? stemTitle(fileName!), content: markdown! }),
      );
      if (prepared) {
        preclassified = prepared.classification;
        preparedContent = prepared.frontmatterContent;
      }
    }

    const [, llmwiki] = await Promise.all([
      (async () => {
        if (!lightragTodo) return;
        this.patch(id, (t) => {
          t.status = "ingesting";
          t.stages.ingesting_lightrag = { name: "ingesting_lightrag", status: "running", steps: t.stages.ingesting_lightrag.steps };
          t.progress = 50;
        });
        this.markStageSteps(id, "ingesting_lightrag", "running");

        // The 202 submit only means LightRAG queued the doc. Submit, then poll
        // /documents/track_status until the backend actually processed (or failed).
        const submitted = await this.safeIngest(() =>
          this.ingest.ingestLightRag(preparedContent ?? markdown!, fileName!),
        );
        if (!submitted.ok || !submitted.trackId) {
          const message = submitted.error ?? "LightRAG rejected the document";
          console.error(`[tasks:${id}] lightrag submit FAILED: ${message}`);
          this.patch(id, (t) => {
            t.stages.ingesting_lightrag = { name: "ingesting_lightrag", status: "failed", error: message, steps: t.stages.ingesting_lightrag.steps };
            t.progress = 72;
          });
          this.markStageSteps(id, "ingesting_lightrag", "failed", message);
          return;
        }
        const trackId = submitted.trackId;
        this.patch(id, (t) => {
          t.lightrag = { trackId, backendStatus: "pending" };
        });
        const outcome = await this.lightragPoller.wait(trackId, (o) => this.applyLightRagProgress(id, o));
        console.log(
          `[tasks:${id}] lightrag track ${trackId} -> ${outcome.state}` +
            (typeof outcome.chunksCount === "number" ? ` (${outcome.chunksProcessed ?? 0}/${outcome.chunksCount} chunks)` : ""),
        );
        this.patch(id, (t) => {
          const done = outcome.state === "done";
          t.stages.ingesting_lightrag = { name: "ingesting_lightrag", status: done ? "done" : "failed", ...(done ? {} : { error: outcome.error }), steps: t.stages.ingesting_lightrag.steps };
          t.progress = 72;
          t.lightrag = { ...t.lightrag, ...(outcome.error ? { error: outcome.error } : {}) };
        });
        this.markStageSteps(id, "ingesting_lightrag", outcome.state === "done" ? "done" : "failed", outcome.error);
      })(),
      (async () => {
        if (!llmwikiTodo) return;
        this.patch(id, (t) => {
          t.status = "ingesting";
          t.stages.ingesting_llmwiki = { name: "ingesting_llmwiki", status: "running", steps: t.stages.ingesting_llmwiki.steps };
          t.progress = 85;
        });
        const res = await this.safeIngest(() =>
          this.ingest.ingestLlmWiki(fileName!, markdown!, (step, status) => {
            this.setStep(id, "ingesting_llmwiki", step, status);
          }, preclassified),
        );
        console.log(`[tasks:${id}] llm_wiki ingest: ${res.ok ? "ok" : "FAILED " + (res.error ?? "")}`);
        this.patch(id, (t) => {
          t.stages.ingesting_llmwiki = { name: "ingesting_llmwiki", status: res.ok ? "done" : "failed", ...(res.ok ? {} : { error: res.error }), steps: t.stages.ingesting_llmwiki.steps };
          t.progress = 100;
        });
        this.markStageSteps(id, "ingesting_llmwiki", res.ok ? "done" : "failed", res.error);
      })(),
    ]);

    // --- finalize ---
    this.patch(id, (t) => {
      const lightragOk = t.stages.ingesting_lightrag.status === "done";
      const llmwikiOk = t.stages.ingesting_llmwiki.status === "done";
      // Surface the first failed stage's reason on the top-level task.error so the
      // UI shows WHY a stage failed (e.g. LightRAG 409 duplicate-name) instead of
      // a silent green "done" / generic message. Keep done even if one system failed.
      const failedStage = t.stages.parsing.status === "failed"
        ? t.stages.parsing
        : t.stages.ingesting_lightrag.status === "failed"
          ? t.stages.ingesting_lightrag
          : t.stages.ingesting_llmwiki.status === "failed"
            ? t.stages.ingesting_llmwiki
            : undefined;
      if (lightragOk || llmwikiOk) {
        t.status = "done";
        t.progress = 100;
        if (failedStage?.error) t.error = failedStage.error;
      } else {
        t.status = "failed";
        t.progress = 100;
        t.error = failedStage?.error ?? "Both knowledge systems failed";
      }
    });

    // Record the newly stored content so future uploads of it are detected.
    if (this.dedup) {
      const task = this.tasks.get(id);
      if (task && (task.stages.ingesting_lightrag.status === "done" || task.stages.ingesting_llmwiki.status === "done")) {
        try {
          await this.dedup.record(markdown, fileName);
        } catch {
          // dedup recording is best-effort; never fail a successful ingest
        }
      }
    }
    const finalTask = this.tasks.get(id);
    console.log(`[tasks:${id}] FINAL status=${finalTask?.status} progress=${finalTask?.progress} parsing=${finalTask?.stages.parsing.status} lightrag=${finalTask?.stages.ingesting_lightrag.status} llmwiki=${finalTask?.stages.ingesting_llmwiki.status}`);

    // Layer 2: semantic near-duplicate notice via LightRAG (best-effort).
    const finished = this.tasks.get(id);
    const findNear = (this.ingest as { findNearDuplicate?: (c: string, f: string) => Promise<string | undefined> }).findNearDuplicate;
    if (finished && finished.status === "done" && !finished.dedup?.duplicate && finished.stages.ingesting_lightrag.status === "done" && findNear) {
      try {
        const near = await findNear(markdown, fileName);
        if (near) {
          this.patch(id, (t) => {
            t.nearDuplicate = near;
          });
        }
      } catch {
        // semantic check is best-effort; never fail a successful ingest
      }
    }
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
    if (!task.input) throw new NothingToRetryError(`task has no parse input to retry: ${taskId}`);
    const failedStages = (["parsing", "ingesting_lightrag", "ingesting_llmwiki"] as const).filter(
      (name) => task.stages[name].status === "failed",
    );
    if (failedStages.length === 0) {
      throw new NothingToRetryError(`task has no failed stages to retry: ${taskId}`);
    }
    this.patch(taskId, (t) => {
      t.error = undefined;
      // Reset the top-level status to a running state NOW (synchronously) so
      // callers polling right after retry() see the task as in-progress, not
      // the old terminal state. run() will refine it to parsing/ingesting.
      const reRunParsing = failedStages.includes("parsing");
      t.status = reRunParsing ? "parsing" : "ingesting";
      for (const name of failedStages) {
        t.stages[name] = initialStage(name);
      }
    });
    void this.run(taskId, task.input!, task.source);
    return task;
  }

  private async safeIngest(fn: () => Promise<SystemIngestStatus>): Promise<SystemIngestStatus> {
    try {
      return await fn();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Classify-and-wrap is best-effort: if it fails, ingestion falls back to
   *  feeding LightRAG the raw markdown (no frontmatter). */
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
