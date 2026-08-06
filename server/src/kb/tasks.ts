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
import { documentIdFrom, slugify } from "./ingest.js";

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
  createdAt: number;
  updatedAt: number;
}

export interface IngestTaskQueueOptions {
  parser: DoclingParser;
  ingest: KnowledgeIngestService;
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
  private readonly tasks = new Map<string, IngestTask>();

  constructor(options: IngestTaskQueueOptions) {
    this.parser = options.parser;
    this.ingest = options.ingest;
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
    // --- parsing (docling) ---
    this.patch(id, (t) => {
      t.status = "parsing";
      t.progress = 15;
      t.stages.parsing.status = "running";
    });
    let markdown: string;
    let documentId: string;
    try {
      const parsed = await this.parser.parse(input);
      markdown = parsed.markdown;
      documentId = parsed.stem || documentIdFrom(source, source);
    } catch (err) {
      return this.fail(id, err, "parsing");
    }
    this.patch(id, (t) => {
      t.stages.parsing.status = "done";
      t.documentId = documentId;
      t.progress = 35;
    });

    // --- LightRAG ingesting ---
    this.patch(id, (t) => {
      t.status = "ingesting";
      t.stages.ingesting_lightrag.status = "running";
      t.progress = 50;
    });
    const fileName = `${documentId || slugify(source)}.md`;
    const lightrag = await this.safeIngest(() => this.ingest.ingestLightRag(markdown, fileName));
    this.patch(id, (t) => {
      t.stages.ingesting_lightrag = {
        name: "ingesting_lightrag",
        status: lightrag.ok ? "done" : "failed",
        ...(lightrag.ok ? {} : { error: lightrag.error }),
      };
      t.progress = 72;
    });

    // --- llm_wiki ingesting ---
    this.patch(id, (t) => {
      t.stages.ingesting_llmwiki.status = "running";
      t.progress = 85;
    });
    const llmwiki = await this.safeIngest(() => this.ingest.ingestLlmWiki(fileName, markdown));
    this.patch(id, (t) => {
      t.stages.ingesting_llmwiki = {
        name: "ingesting_llmwiki",
        status: llmwiki.ok ? "done" : "failed",
        ...(llmwiki.ok ? {} : { error: llmwiki.error }),
      };
      t.progress = 100;
      if (lightrag.ok || llmwiki.ok) {
        t.status = "done";
      } else {
        t.status = "failed";
        t.error = "Both knowledge systems failed";
      }
    });
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
