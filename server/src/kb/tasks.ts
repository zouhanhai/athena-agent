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
import { documentIdFrom } from "./ingest.js";
import type { ContentDedupStore } from "./dedup.js";

export type TaskStageName = "parsing" | "ingesting_lightrag" | "ingesting_llmwiki";
export type StageStatus = "pending" | "running" | "done" | "failed";
export type TaskStatus = "pending" | "parsing" | "ingesting" | "done" | "failed";

export interface TaskStage {
  name: TaskStageName;
  status: StageStatus;
  error?: string;
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
}

export interface IngestSubmitResult {
  taskId: string;
}

function initialStages(): IngestTask["stages"] {
  return {
    parsing: { name: "parsing", status: "pending" },
    ingesting_lightrag: { name: "ingesting_lightrag", status: "pending" },
    ingesting_llmwiki: { name: "ingesting_llmwiki", status: "pending" },
  };
}

export class IngestTaskQueue {
  private readonly parser: DoclingParser;
  private readonly ingest: KnowledgeIngestService;
  private readonly dedup?: ContentDedupStore;
  private readonly tasks = new Map<string, IngestTask>();

  constructor(options: IngestTaskQueueOptions) {
    this.parser = options.parser;
    this.ingest = options.ingest;
    this.dedup = options.dedup;
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

  private async run(id: string, input: string, source: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) return;
    task.input = input;

    let markdown = task.markdown;
    let fileName = task.fileName;

    // --- parsing (docling) ---
    if (task.stages.parsing.status !== "done") {
      this.patch(id, (t) => {
        t.status = "parsing";
        t.progress = 15;
        t.stages.parsing = { name: "parsing", status: "running" };
      });
      try {
        const parsed = await this.parser.parse(input);
        markdown = parsed.markdown;
        fileName = `${parsed.stem || documentIdFrom(source, source)}.md`;
        this.patch(id, (t) => {
          t.stages.parsing = { name: "parsing", status: "done" };
          t.documentId = parsed.stem || documentIdFrom(source, source);
          t.markdown = markdown;
          t.fileName = fileName;
          t.progress = 35;
        });
      } catch (err) {
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

    // --- LightRAG ingesting ---
    if (task.stages.ingesting_lightrag.status !== "done") {
      this.patch(id, (t) => {
        t.status = "ingesting";
        t.stages.ingesting_lightrag = { name: "ingesting_lightrag", status: "running" };
        t.progress = 50;
      });
      const lightrag = await this.safeIngest(() => this.ingest.ingestLightRag(markdown!, fileName!));
      this.patch(id, (t) => {
        t.stages.ingesting_lightrag = {
          name: "ingesting_lightrag",
          status: lightrag.ok ? "done" : "failed",
          ...(lightrag.ok ? {} : { error: lightrag.error }),
        };
        t.progress = 72;
      });
    }

    // --- llm_wiki ingesting ---
    if (task.stages.ingesting_llmwiki.status !== "done") {
      this.patch(id, (t) => {
        t.status = "ingesting";
        t.stages.ingesting_llmwiki = { name: "ingesting_llmwiki", status: "running" };
        t.progress = 85;
      });
      const llmwiki = await this.safeIngest(() => this.ingest.ingestLlmWiki(fileName!, markdown!));
      this.patch(id, (t) => {
        t.stages.ingesting_llmwiki = {
          name: "ingesting_llmwiki",
          status: llmwiki.ok ? "done" : "failed",
          ...(llmwiki.ok ? {} : { error: llmwiki.error }),
        };
        t.progress = 100;
      });
    }

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
        if (failedStage?.error) t.error = failedStage.error;
      } else {
        t.status = "failed";
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
  }

  /** Mark a task as done because its content is a duplicate of an existing doc. */
  private markDedup(id: string, method: "hash" | "chunks" | undefined, existingSource: string | undefined): void {
    this.patch(id, (t) => {
      t.status = "done";
      t.progress = 100;
      t.dedup = { duplicate: true, ...(method ? { method } : {}), ...(existingSource ? { existingSource } : {}) };
      t.error = undefined;
      // Parsing succeeded; the two ingest stages were skipped (not failed).
      t.stages.parsing = { name: "parsing", status: "done" };
    });
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
        t.stages[name] = { name, status: "pending" };
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

  private fail(id: string, err: unknown, stage: TaskStageName): void {
    const message = err instanceof Error ? err.message : String(err);
    this.patch(id, (t) => {
      t.status = "failed";
      t.error = message;
      t.stages[stage] = { name: stage, status: "failed", error: message };
    });
  }
}
