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
import { dirname, relative } from "node:path";
import type { DoclingParser } from "./docling.js";
import type { KnowledgeIngestService, SystemIngestStatus } from "./ingest.js";
import type { LlmWikiStepName } from "./ingest.js";
import { documentIdFrom, classificationFromRefinement, extractPageTitle, stemTitle, categoryDir } from "./ingest.js";
import type { WikiClassification } from "./llmwiki.js";
import { isValidTopic } from "./llmwiki.js";
import type { RefineOutputRef } from "../agents/refine-output.js";
import type { ContentDedupStore } from "./dedup.js";
import type { Neo4jIngestService } from "./store/ingest.js";

/** Athena refinement runner (G4.S1.T4): one full-doc LLM pass, returns the small
 *  big-output ref + the full re-leveled markdown for downstream consumption.
 *  Injected so tests can fake the LLM pass; the default uses refine_document.
 *  `markdown` is File A′ (refined headers + image refs — llm_wiki); `ragMarkdown`
 *  is File B (refined text-only — the RAG working copy, G4.S1.T6). */
export type Refiner = (markdown: string, topicHint?: string) => Promise<{
  ref: RefineOutputRef;
  markdown: string;
  ragMarkdown: string;
}>;

export type TaskStageName = "parsing" | "refinement" | "ingesting_llmwiki" | "ingesting_neo4j";
export type StageStatus = "pending" | "running" | "done" | "failed";
export type TaskStatus = "pending" | "parsing" | "refining" | "ingesting" | "done" | "failed";

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
}

export interface TaskStage {
  name: TaskStageName;
  status: StageStatus;
  error?: string;
  steps: TaskStep[];
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
  /** Athena refinement runner (G4.S1.T4). When unset, the refinement stage is
   *  skipped and the raw docling markdown is used (never worse than today). */
  refiner?: Refiner;
  /** Neo4j lean RAG store ingest (G4.S2.T4). When unset, the ingesting_neo4j
   *  stage is a no-op marked done — the store is not wired. */
  neo4j?: Neo4jIngestService;
  /** Optional content-dedup store (G2.S5.T14). When set, identical content is
   *  skipped before the pipelines run; newly stored content is recorded. */
  dedup?: ContentDedupStore;
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
  private readonly ingest: KnowledgeIngestService;
  private readonly refiner?: Refiner;
  private readonly neo4j?: Neo4jIngestService;
  private readonly dedup?: ContentDedupStore;
  private readonly tasks = new Map<string, IngestTask>();

  constructor(options: IngestTaskQueueOptions) {
    this.parser = options.parser;
    this.ingest = options.ingest;
    this.refiner = options.refiner;
    this.neo4j = options.neo4j;
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
          const result = await this.refiner(markdown!);
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
        const res = await this.safeIngest(() =>
          this.ingest.ingestLlmWiki(fileName!, refinedMarkdown ?? markdown!, (step, status) => {
            this.setStep(id, "ingesting_llmwiki", step, status);
          }, preclassified, task.images),
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
        const res = this.neo4j && refinementRef
          ? await this.safeIngest(() => {
              const title = extractPageTitle(refinedMarkdown ?? markdown!) ?? stemTitle(fileName!);
              const documentId = task.documentId ?? documentIdFrom(source, source);
              const wikiPath = wikiPathFor(fileName!, preclassified);
              return this.neo4j!.ingest({
                ref: refinementRef!,
                documentId,
                title,
                ...(wikiPath ? { wikiPath } : {}),
              }).then((r) => ({ ok: true, count: r.chunksStored }));
            })
          : { ok: true };
        console.log(
          `[tasks:${id}] neo4j ingest: ${res.ok ? "ok" : "FAILED " + (res.error ?? "")}` +
            (res.ok && "count" in res ? ` (${res.count} chunks embedded)` : ""),
        );
        this.patch(id, (t) => {
          t.stages.ingesting_neo4j = { name: "ingesting_neo4j", status: res.ok ? "done" : "failed", ...(res.ok ? {} : { error: res.error }), steps: t.stages.ingesting_neo4j.steps };
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
          await this.dedup.record(markdown, fileName);
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
