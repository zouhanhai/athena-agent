import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { KnowledgeIngestService } from "../kb/ingest.js";
import type { KnowledgeRetrievalService } from "../kb/retrieval.js";
import type { IngestTaskQueue } from "../kb/tasks.js";
import type { KbReviewService } from "../kb/review.js";
import type { WikiReCurator } from "../kb/recurate.js";
import type { FeedbackService } from "../kb/feedback.js";
import type { ManualQaMode } from "../kb/feedback.js";
import type { SemanticMappingStore } from "../kb/semantic-mappings.js";
import { isFeedbackDirection, toSources } from "../kb/qa-pairs.js";
import { computeWikiDiff } from "../kb/diff.js";
import { PermissionDeniedError, assertEmployeePermission } from "../employees/rbac.js";
import type { AuthService } from "../employees/auth.js";
import { currentEmployee } from "./helpers.js";
import {
  NothingToRetryError,
  TaskBusyError,
  TaskNotFoundError,
} from "../kb/tasks.js";

export interface KbRequestBody {
  title?: unknown;
  content?: unknown;
  source?: unknown;
}

export interface KbSearchBody {
  query?: unknown;
  /** Optional topic scope: converges retrieval to a document domain (G4.S2.T5). */
  topic?: unknown;
}

export interface KbUrlBody {
  url?: unknown;
}

export interface KbRouteOptions {
  ingest: KnowledgeIngestService;
  retrieval?: KnowledgeRetrievalService;
  taskQueue?: IngestTaskQueue;
  /** Athena KB review pass (G4.S3.T2): POST /api/kb/review. */
  review?: KbReviewService;
  /** Incremental re-curation tool (G4.S3.T3): POST /api/kb/wiki/retopic. */
  recurator?: WikiReCurator;
  /** Feedback loop (G4.S3.T5): POST /api/kb/feedback + GET /api/kb/qa. */
  feedback?: FeedbackService;
  /** Custom semantic mappings (G4.S3.T6): GET/POST/DELETE /api/kb/mappings. */
  mappings?: SemanticMappingStore;
  /** Auth service for the RBAC-gated wiki-edit save (G4.S3.T10): PUT /api/kb/wiki/page. */
  auth?: AuthService;
  /** Directory to stage uploaded files before docling parsing. Default: os.tmpdir(). */
  uploadDir?: string;
  /** Max multipart upload size. Default: 50 MiB. */
  maxFileSize?: number;
}

const MANUAL_QA_MODES: readonly ManualQaMode[] = ["merge", "overwrite", "add-anyway"];

function isManualQaMode(value: unknown): value is ManualQaMode {
  return typeof value === "string" && (MANUAL_QA_MODES as readonly string[]).includes(value);
}

function invalidField(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

function isUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  const trimmed = value.trim();
  return trimmed.startsWith("http://") || trimmed.startsWith("https://");
}

function safeFilename(filename: string): string {
  const base = filename.split("/").pop() ?? filename;
  const sanitized = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || `upload-${Date.now()}`;
}

/** Validate a wiki page path like "wiki/concepts/foo.md" (no traversal). */
function isSafeWikiPath(value: string): boolean {
  if (!value.startsWith("wiki/") || !value.endsWith(".md")) return false;
  if (value.includes("..") || value.includes("\\")) return false;
  return true;
}

/** Validate a wiki image path like "wiki/concepts/images/foo.png" (no traversal). */
function isSafeWikiImagePath(value: string): boolean {
  if (!value.startsWith("wiki/")) return false;
  if (value.includes("..") || value.includes("\\")) return false;
  return true;
}

/**
 * Knowledge ingestion endpoints:
 * - POST /api/kb/ingest (JSON { title, content, source? }) → dual-pipeline ingest
 *   result (legacy, synchronous). With multipart upload (file field) → task queue.
 * - POST /api/kb/ingest-url { url } → docling fetch → dual pipeline (async, task).
 * - GET /api/kb/task/:id → poll task status { id, source, status, progress, stages }.
 *
 * Retrieval endpoints (registered when a KnowledgeRetrievalService is provided):
 * - GET /api/kb/graph?label= → Neo4j entity-relation graph {nodes, edges}
 * - GET /api/kb/wiki → llm_wiki wiki page tree {files}
 * - GET /api/kb/wiki/page?path= → wiki page markdown {path, content}
 * - POST /api/kb/search { query } → fused Neo4j + llm_wiki results
 */
export function registerKbRoutes(app: FastifyInstance, options: KbRouteOptions): void {
  app.post("/api/kb/ingest", async (request, reply) => {
    const uploadDir = options.uploadDir ?? tmpdir();
    const maxFileSize = options.maxFileSize ?? 50 * 1024 * 1024;

    if (request.isMultipart()) {
      if (!options.taskQueue) {
        return reply.code(500).send({ error: "ingestion task queue not configured" });
      }
      await mkdir(uploadDir, { recursive: true });
      const data = await request.file({ limits: { fileSize: maxFileSize } });
      if (!data) {
        return reply.code(400).send({ error: "file is required" });
      }
      const target = join(uploadDir, safeFilename(data.filename));
      const stream = createWriteStream(target);
      try {
        await pipeline(data.file, stream);
      } catch (err) {
        return reply.code(413).send({
          error: err instanceof Error ? err.message : String(err),
        });
      }
      const { taskId } = options.taskQueue.submitFile(target, data.filename);
      return reply.code(202).send({ taskId });
    }

    const body = (request.body ?? {}) as KbRequestBody & {
      kind?: unknown;
      filename?: unknown;
      system?: unknown;
      devclass?: unknown;
      transport?: unknown;
      component?: unknown;
      files?: unknown;
    };
    const kind = typeof body.kind === "string" ? body.kind : undefined;

    // G4.S8.T3: CDS code channel — SAP CDS-view DDL is NOT prose, so it skips
    // docling/PDF parsing entirely. The source is submitted as an async ingest
    // task (task id + progress): the local CDS DDL parser splits it into per-view
    // chunks and the code-store façade writes them in the standard RefinementChunk
    // shape (path = dataCategory/technicalName), flowing into the same llm_wiki
    // + Neo4j stages as a normal doc. Optional lineage (system/devclass/transport)
    // is folded into the wiki frontmatter so answers distinguish active objects.
    if (kind === "cds") {
      if (!options.taskQueue) {
        return reply.code(500).send({ error: "ingestion task queue not configured" });
      }
      if (invalidField(body.content)) {
        return reply.code(400).send({ error: "content is required" });
      }
      const filename =
        typeof body.filename === "string" && body.filename.trim() ? body.filename.trim() : undefined;
      const system = typeof body.system === "string" && body.system.trim() ? body.system.trim() : undefined;
      const devclass =
        typeof body.devclass === "string" && body.devclass.trim() ? body.devclass.trim() : undefined;
      const transport =
        typeof body.transport === "string" && body.transport.trim() ? body.transport.trim() : undefined;
      const { taskId } = options.taskQueue.submitCds({
        content: body.content as string,
        ...(filename ? { filename } : {}),
        ...(system ? { system } : {}),
        ...(devclass ? { devclass } : {}),
        ...(transport ? { transport } : {}),
      });
      return reply.code(202).send({ taskId, kind: "cds" });
    }

    // G4.S8.T4: ABAP code channel — SAP ABAP source (class/report/function
    // group, incl. INCLUDEs) is NOT prose, so it skips docling/PDF parsing. The
    // source is submitted as an async ingest task: the local ABAP parser splits
    // it into per-unit chunks (one per METHOD/FORM/FUNCTION/INCLUDE) and the
    // code-store façade writes them in the standard RefinementChunk shape (path
    // = <devclass>/<devName>[/<method>]), flowing into the same llm_wiki + Neo4j
    // stages as a normal doc. Optional lineage (system/devclass/transport) is
    // folded into the wiki frontmatter.
    if (kind === "abap") {
      if (!options.taskQueue) {
        return reply.code(500).send({ error: "ingestion task queue not configured" });
      }
      if (invalidField(body.content)) {
        return reply.code(400).send({ error: "content is required" });
      }
      const filename =
        typeof body.filename === "string" && body.filename.trim() ? body.filename.trim() : undefined;
      const system = typeof body.system === "string" && body.system.trim() ? body.system.trim() : undefined;
      const devclass =
        typeof body.devclass === "string" && body.devclass.trim() ? body.devclass.trim() : undefined;
      const transport =
        typeof body.transport === "string" && body.transport.trim() ? body.transport.trim() : undefined;
      const { taskId } = options.taskQueue.submitAbap({
        content: body.content as string,
        ...(filename ? { filename } : {}),
        ...(system ? { system } : {}),
        ...(devclass ? { devclass } : {}),
        ...(transport ? { transport } : {}),
      });
      return reply.code(202).send({ taskId, kind: "abap" });
    }

    // G4.S8.T5: UI5 code channel — SAP UI5 business front-end (controllers,
    // XML views, manifest.json, .model.json) is NOT prose, so it skips
    // docling/PDF parsing entirely. The source is a map of business files under
    // webapp/ (node_modules/dist excluded): the local UI5 parser splits each
    // controller into per-method chunks (large controllers) and one chunk per
    // view/manifest/model, written in the standard RefinementChunk shape (path =
    // <component>/<modulePath>[/<method>]), flowing into the same llm_wiki +
    // Neo4j stages as a normal doc. Optional lineage folds into the wiki
    // frontmatter so answers carry the app/commit provenance.
    if (kind === "ui5") {
      if (!options.taskQueue) {
        return reply.code(500).send({ error: "ingestion task queue not configured" });
      }
      const files = body.files;
      if (!files || typeof files !== "object" || Object.keys(files as Record<string, unknown>).length === 0) {
        return reply.code(400).send({ error: "files (object of <app-path>: <source>) is required" });
      }
      const filename =
        typeof body.filename === "string" && body.filename.trim() ? body.filename.trim() : undefined;
      const component =
        typeof body.component === "string" && body.component.trim() ? body.component.trim() : undefined;
      const system = typeof body.system === "string" && body.system.trim() ? body.system.trim() : undefined;
      const devclass =
        typeof body.devclass === "string" && body.devclass.trim() ? body.devclass.trim() : undefined;
      const transport =
        typeof body.transport === "string" && body.transport.trim() ? body.transport.trim() : undefined;
      const { taskId } = options.taskQueue.submitUi5({
        files: files as Record<string, string>,
        ...(filename ? { filename } : {}),
        ...(component ? { component } : {}),
        ...(system ? { system } : {}),
        ...(devclass ? { devclass } : {}),
        ...(transport ? { transport } : {}),
      });
      return reply.code(202).send({ taskId, kind: "ui5" });
    }

    // G4.S8.T9: DDIC table-structure channel — SAP table structures arrive as a
    // JSON array of table descriptors (DD02L/DD03L/DD04T read or RFC
    // DDIF_FIELDINFO_GET — the platform does NOT call SAP, it only consumes the
    // JSON). The source is submitted as an async ingest task: the local parser
    // splits it into one header chunk per table + ~20-field group chunks,
    // written in the standard RefinementChunk shape (path = <TABLE>/_header or
    // <TABLE>/fields/<n>), flowing into the same llm_wiki + Neo4j stages as a
    // normal doc. Table entities + REFERENCES edges to (external) FK targets
    // flow into the graph. Optional lineage (system/devclass/transport) is
    // folded into the wiki frontmatter.
    if (kind === "ddic") {
      if (!options.taskQueue) {
        return reply.code(500).send({ error: "ingestion task queue not configured" });
      }
      if (invalidField(body.content)) {
        return reply.code(400).send({ error: "content is required" });
      }
      const filename =
        typeof body.filename === "string" && body.filename.trim() ? body.filename.trim() : undefined;
      const system = typeof body.system === "string" && body.system.trim() ? body.system.trim() : undefined;
      const devclass =
        typeof body.devclass === "string" && body.devclass.trim() ? body.devclass.trim() : undefined;
      const transport =
        typeof body.transport === "string" && body.transport.trim() ? body.transport.trim() : undefined;
      const { taskId } = options.taskQueue.submitDdic({
        content: body.content as string,
        ...(filename ? { filename } : {}),
        ...(system ? { system } : {}),
        ...(devclass ? { devclass } : {}),
        ...(transport ? { transport } : {}),
      });
      return reply.code(202).send({ taskId, kind: "ddic" });
    }

    if (invalidField(body.title)) {
      return reply.code(400).send({ error: "title is required" });
    }
    if (invalidField(body.content)) {
      return reply.code(400).send({ error: "content is required" });
    }

    try {
      const result = await options.ingest.ingestMarkdown({
        title: body.title as string,
        content: body.content as string,
        source: typeof body.source === "string" && body.source.trim() ? body.source : undefined,
      });
      const anyOk = result.systems.llmwiki.ok;
      return reply.code(anyOk ? 200 : 500).send(result);
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/kb/ingest-url", async (request, reply) => {
    if (!options.taskQueue) {
      return reply.code(500).send({ error: "ingestion task queue not configured" });
    }
    const body = (request.body ?? {}) as KbUrlBody;
    if (!isUrl(body.url)) {
      return reply.code(400).send({ error: "a valid http(s) url is required" });
    }
    const { taskId } = options.taskQueue.submitUrl(body.url.trim());
    return reply.code(202).send({ taskId });
  });

  app.get("/api/kb/task/:id", async (request, reply) => {
    if (!options.taskQueue) {
      return reply.code(500).send({ error: "ingestion task queue not configured" });
    }
    const { id } = request.params as { id?: string };
    const task = id ? options.taskQueue.getTask(id) : undefined;
    if (!task) {
      return reply.code(404).send({ error: "task not found" });
    }
    return task;
  });

  app.post("/api/kb/ingest/retry", async (request, reply) => {
    if (!options.taskQueue) {
      return reply.code(500).send({ error: "ingestion task queue not configured" });
    }
    const body = (request.body ?? {}) as { taskId?: unknown };
    if (typeof body.taskId !== "string" || body.taskId.trim().length === 0) {
      return reply.code(400).send({ error: "taskId is required" });
    }
    try {
      return options.taskQueue.retry(body.taskId.trim());
    } catch (err) {
      if (err instanceof TaskNotFoundError) {
        return reply.code(404).send({ error: err.message });
      }
      if (err instanceof TaskBusyError) {
        return reply.code(409).send({ error: err.message });
      }
      if (err instanceof NothingToRetryError) {
        return reply.code(400).send({ error: err.message });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Delete a wiki page from llm_wiki (G2.S5.T12). */
  const deleteDocHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { path?: unknown };
    if (typeof body.path !== "string" || !isSafeWikiPath(body.path.trim())) {
      return reply.code(400).send({ error: "a valid wiki page path (wiki/**/*.md) is required" });
    }
    try {
      const result = await options.ingest.deleteDocument(body.path.trim());
      return reply.code(result.ok ? 200 : 500).send(result);
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  };
  app.delete("/api/kb/doc", deleteDocHandler);
  app.post("/api/kb/doc/delete", deleteDocHandler);

  /** POST /api/kb/review → run the Athena KB review pass (G4.S3.T2): scan every
   *  wiki page's frontmatter and re-topic / re-classify / deprecate / reinforce.
   *  Body (all optional): { dryRun?, retopics?, reclassify?, reinforce? }. */
  const reviewHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!options.review) {
      return reply.code(500).send({ error: "KB review service not configured" });
    }
    const body = (request.body ?? {}) as {
      dryRun?: unknown;
      retopics?: unknown;
      reclassify?: unknown;
      reinforce?: unknown;
    };
    const retopics =
      typeof body.retopics === "object" && body.retopics !== null
        ? (body.retopics as Record<string, string>)
        : undefined;
    const reclassify =
      typeof body.reclassify === "object" && body.reclassify !== null
        ? (body.reclassify as Record<string, string>)
        : undefined;
    const reinforce = Array.isArray(body.reinforce)
      ? body.reinforce.filter((p): p is string => typeof p === "string")
      : undefined;
    try {
      return await options.review.reviewAll({
        ...(body.dryRun === true ? { dryRun: true } : {}),
        ...(retopics ? { retopics } : {}),
        ...(reclassify ? { reclassify } : {}),
        ...(reinforce && reinforce.length > 0 ? { reinforce } : {}),
      });
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  };
  app.post("/api/kb/review", reviewHandler);

  /** POST /api/kb/wiki/retopic → re-curate a wiki page into a deeper topic dir
   *  (G4.S3.T3): move the file, update topic + topic_history + last_reviewed,
   *  rebuild wiki/index.md + llm_wiki rescan. No Neo4j re-chunk / re-embed.
   *  Body: { path, topic }. */
  const retopicHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!options.recurator) {
      return reply.code(500).send({ error: "KB re-curation service not configured" });
    }
    const body = (request.body ?? {}) as { path?: unknown; topic?: unknown };
    if (typeof body.path !== "string" || body.path.trim().length === 0) {
      return reply.code(400).send({ error: "path is required" });
    }
    if (typeof body.topic !== "string" || body.topic.trim().length === 0) {
      return reply.code(400).send({ error: "topic is required" });
    }
    try {
      return await options.recurator.reTopic({ path: body.path.trim(), topic: body.topic.trim() });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  };
  app.post("/api/kb/wiki/retopic", retopicHandler);

  /** POST /api/kb/feedback → record a chat answer's thumbs up/down (G4.S3.T5).
   *  Body: { question, answer, sources?, feedback }. Stores the Q&A pair (deduped
   *  by vector similarity) and reinforces/fades the source pages' confidence
   *  through the canonical syncer (wiki + Document mirror). */
  const feedbackHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!options.feedback) {
      return reply.code(500).send({ error: "feedback service not configured" });
    }
    const body = (request.body ?? {}) as {
      question?: unknown;
      answer?: unknown;
      sources?: unknown;
      feedback?: unknown;
    };
    if (typeof body.question !== "string" || body.question.trim().length === 0) {
      return reply.code(400).send({ error: "question is required" });
    }
    if (typeof body.answer !== "string" || body.answer.trim().length === 0) {
      return reply.code(400).send({ error: "answer is required" });
    }
    if (!isFeedbackDirection(body.feedback)) {
      return reply.code(400).send({ error: "feedback must be 'up' or 'down'" });
    }
    try {
      return await options.feedback.record({
        question: body.question.trim(),
        answer: body.answer.trim(),
        sources: toSources(body.sources),
        feedback: body.feedback,
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  };
  app.post("/api/kb/feedback", feedbackHandler);

  /** GET /api/kb/qa → list the stored Q&A pairs (feedback loop + manual), for
   *  the "Terms & QA" tab (G4.S3.T6) and reuse checks. */
  app.get("/api/kb/qa", async (request, reply) => {
    if (!options.feedback) {
      return reply.code(500).send({ error: "feedback service not configured" });
    }
    try {
      const pairs = await options.feedback.qaStore.list();
      return { pairs };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** POST /api/kb/qa/manual → manual Q&A entry (G4.S3.T6): type a Q&A pair
   *  straight into the Terms & QA tab. Body: { question, answer, sources?,
   *  mode? }. Reuses the T5 vector-dedup — when a similar question exists and
   *  no mode is given, returns `needs_decision` + the similar pair so the
   *  front-end can offer merge / overwrite / add-anyway. */
  const manualQaHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!options.feedback) {
      return reply.code(500).send({ error: "feedback service not configured" });
    }
    const body = (request.body ?? {}) as {
      question?: unknown;
      answer?: unknown;
      sources?: unknown;
      mode?: unknown;
    };
    if (typeof body.question !== "string" || body.question.trim().length === 0) {
      return reply.code(400).send({ error: "question is required" });
    }
    if (typeof body.answer !== "string" || body.answer.trim().length === 0) {
      return reply.code(400).send({ error: "answer is required" });
    }
    const mode = body.mode;
    if (mode !== undefined && !isManualQaMode(mode)) {
      return reply.code(400).send({ error: "mode must be 'merge', 'overwrite' or 'add-anyway'" });
    }
    try {
      return await options.feedback.manualAdd(
        {
          question: body.question.trim(),
          answer: body.answer.trim(),
          sources: toSources(body.sources),
        },
        mode,
      );
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  };
  app.post("/api/kb/qa/manual", manualQaHandler);

  /** DELETE /api/kb/qa/:id → delete a stored Q&A pair (manual cleanup in the
   *  Terms & QA tab). Also drops its vector embedding. */
  const deleteQaHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!options.feedback) {
      return reply.code(500).send({ error: "feedback service not configured" });
    }
    const { id } = request.params as { id?: string };
    if (typeof id !== "string" || id.trim().length === 0) {
      return reply.code(400).send({ error: "id is required" });
    }
    try {
      const removed = await options.feedback.deletePair(id.trim());
      if (!removed) {
        return reply.code(404).send({ error: "Q&A pair not found" });
      }
      return { ok: true };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  };
  app.delete("/api/kb/qa/:id", deleteQaHandler);

  /** GET /api/kb/mappings → list the custom semantic mappings (G4.S3.T6). */
  const listMappingsHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!options.mappings) {
      return reply.code(500).send({ error: "semantic mappings store not configured" });
    }
    try {
      const mappings = await options.mappings.list();
      return { mappings };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  };
  app.get("/api/kb/mappings", listMappingsHandler);

  /** POST /api/kb/mappings { term, canonical | canonicals } → upsert a semantic
   *  mapping. `canonical` may be comma- or `/`-separated (one-to-many, G4.S3.T6);
   *  an explicit `canonicals` array is also accepted. */
  const addMappingHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!options.mappings) {
      return reply.code(500).send({ error: "semantic mappings store not configured" });
    }
    const body = (request.body ?? {}) as {
      term?: unknown;
      canonical?: unknown;
      canonicals?: unknown;
    };
    if (typeof body.term !== "string" || body.term.trim().length === 0) {
      return reply.code(400).send({ error: "term is required" });
    }
    const canonicalOk =
      (typeof body.canonical === "string" && body.canonical.trim().length > 0) ||
      (Array.isArray(body.canonicals) &&
        body.canonicals.length > 0 &&
        body.canonicals.every((c) => typeof c === "string" && c.trim().length > 0));
    if (!canonicalOk) {
      return reply.code(400).send({ error: "canonical is required" });
    }
    try {
      const mapping = await options.mappings.upsert({
        term: body.term.trim(),
        ...(typeof body.canonical === "string" ? { canonical: body.canonical.trim() } : {}),
        ...(Array.isArray(body.canonicals)
          ? { canonicals: (body.canonicals as string[]).map((c) => c.trim()) }
          : {}),
      });
      return { mapping };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  };
  app.post("/api/kb/mappings", addMappingHandler);

  /** DELETE /api/kb/mappings/:id → remove a semantic mapping. */
  const deleteMappingHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!options.mappings) {
      return reply.code(500).send({ error: "semantic mappings store not configured" });
    }
    const { id } = request.params as { id?: string };
    if (typeof id !== "string" || id.trim().length === 0) {
      return reply.code(400).send({ error: "id is required" });
    }
    try {
      const removed = await options.mappings.remove(id.trim());
      if (!removed) {
        return reply.code(404).send({ error: "mapping not found" });
      }
      return { ok: true };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  };
  app.delete("/api/kb/mappings/:id", deleteMappingHandler);

  /** PUT /api/kb/wiki/page — save a corrected wiki page (G4.S3.T10), RBAC-gated
   *  behind `kb.edit` (admin default; grantable to a member). Body: { path,
   *  content } where `content` is the FULL corrected page markdown (frontmatter
   *  + body + image refs — File A). The route persists the edit to the wiki file
   *  (rebuild index + rescan), computes the before/after diff on the ragMarkdown
   *  forms (image refs stripped, VLM alt-text kept), then submits a background
   *  task that runs the Athena diff-refine + the RAG overwrite via the wikiPath.
   *  Returns { taskId } — poll GET /api/kb/task/:id for progress. */
  const saveWikiPageHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!options.auth) {
      return reply.code(500).send({ error: "wiki edit requires the auth service" });
    }
    if (!options.taskQueue) {
      return reply.code(500).send({ error: "ingestion task queue not configured" });
    }
    const body = (request.body ?? {}) as { path?: unknown; content?: unknown };
    if (typeof body.path !== "string" || !isSafeWikiPath(body.path.trim())) {
      return reply.code(400).send({ error: "a valid wiki page path (wiki/**/*.md) is required" });
    }
    if (typeof body.content !== "string" || body.content.trim().length === 0) {
      return reply.code(400).send({ error: "content is required" });
    }
    const employee = await currentEmployee(request, options.auth);
    if (!employee) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    try {
      assertEmployeePermission(employee, "kb.edit");
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        return reply.code(403).send({ error: 'forbidden: requires permission "kb.edit"' });
      }
      throw err;
    }
    const path = body.path.trim();
    const content = body.content;
    try {
      const snapshot = await options.ingest.saveWikiPage(path, content);
      const diff = computeWikiDiff(snapshot.ragBefore, snapshot.ragAfter);
      const { taskId } = options.taskQueue!.submitWikiSave({
        path,
        beforeRag: snapshot.ragBefore,
        afterRag: snapshot.ragAfter,
        diff: diff.unified,
        structural: diff.structural,
        ...(snapshot.type ? { type: snapshot.type } : {}),
        ...(snapshot.topic ? { topic: snapshot.topic } : {}),
      });
      return {
        taskId,
        saved: true,
        diff: {
          changed: diff.changed,
          structural: diff.structural,
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return reply.code(404).send({ error: `wiki page not found: ${path}` });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  };
  app.put("/api/kb/wiki/page", saveWikiPageHandler);

  if (!options.retrieval) return;

  app.get("/api/kb/graph", async (request, reply) => {
    try {
      const graph = await options.retrieval!.getGraph();
      return graph;
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/kb/graph/topics", async (request, reply) => {
    try {
      const topics = await options.retrieval!.getGraphTopics();
      return { topics };
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/kb/wiki", async (request, reply) => {
    try {
      const files = await options.retrieval!.getWikiTree();
      return { files };
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/kb/wiki/page", async (request, reply) => {
    const { path } = request.query as { path?: unknown };
    if (typeof path !== "string" || path.trim().length === 0) {
      return reply.code(400).send({ error: "path is required" });
    }
    try {
      return await options.retrieval!.readWikiPage(path);
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** GET /api/kb/wiki/image?path= → stream a wiki page's source image bytes
   *  so WikiView can render <img src="/api/kb/wiki/image?path=..."> (G3.S5.T5).
   *  The path is validated with the same isSafeWikiPath-style guard. */
  app.get("/api/kb/wiki/image", async (request, reply) => {
    const { path } = request.query as { path?: unknown };
    if (typeof path !== "string" || path.trim().length === 0 || !isSafeWikiImagePath(path.trim())) {
      return reply.code(400).send({ error: "a valid wiki image path (wiki/**/*) is required" });
    }
    try {
      const { data, contentType } = await options.retrieval!.readWikiImage(path.trim());
      return reply.type(contentType).send(data);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return reply.code(404).send({ error: "image not found" });
      }
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/kb/search", async (request, reply) => {
    const body = (request.body ?? {}) as KbSearchBody;
    if (typeof body.query !== "string" || body.query.trim().length === 0) {
      return reply.code(400).send({ error: "query is required" });
    }
    try {
      const topic =
        typeof body.topic === "string" && body.topic.trim().length > 0 ? body.topic.trim() : undefined;
      return await options.retrieval!.search(body.query.trim(), { ...(topic ? { topic } : {}) });
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
