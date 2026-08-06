import type { FastifyInstance } from "fastify";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { KnowledgeIngestService } from "../kb/ingest.js";
import type { KnowledgeRetrievalService } from "../kb/retrieval.js";
import type { IngestTaskQueue } from "../kb/tasks.js";

export interface KbRequestBody {
  title?: unknown;
  content?: unknown;
  source?: unknown;
}

export interface KbSearchBody {
  query?: unknown;
}

export interface KbUrlBody {
  url?: unknown;
}

export interface KbRouteOptions {
  ingest: KnowledgeIngestService;
  retrieval?: KnowledgeRetrievalService;
  taskQueue?: IngestTaskQueue;
  /** Directory to stage uploaded files before docling parsing. Default: os.tmpdir(). */
  uploadDir?: string;
  /** Max multipart upload size. Default: 50 MiB. */
  maxFileSize?: number;
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

/**
 * Knowledge ingestion endpoints:
 * - POST /api/kb/ingest (JSON { title, content, source? }) → dual-pipeline ingest
 *   result (legacy, synchronous). With multipart upload (file field) → task queue.
 * - POST /api/kb/ingest-url { url } → docling fetch → dual pipeline (async, task).
 * - GET /api/kb/task/:id → poll task status { id, source, status, progress, stages }.
 *
 * Retrieval endpoints (registered when a KnowledgeRetrievalService is provided):
 * - GET /api/kb/graph?label= → LightRAG entity-relation graph {nodes, edges}
 * - GET /api/kb/wiki → llm_wiki wiki page tree {files}
 * - GET /api/kb/wiki/page?path= → wiki page markdown {path, content}
 * - POST /api/kb/search { query } → fused LightRAG + llm_wiki results
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

    const body = (request.body ?? {}) as KbRequestBody;

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
      const anyOk = result.systems.lightrag.ok || result.systems.llmwiki.ok;
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

  if (!options.retrieval) return;

  app.get("/api/kb/graph", async (request, reply) => {
    try {
      const { label } = request.query as { label?: string };
      const graph = await options.retrieval!.getGraph(
        typeof label === "string" && label.trim() ? label : undefined,
      );
      return graph;
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

  app.post("/api/kb/search", async (request, reply) => {
    const body = (request.body ?? {}) as KbSearchBody;
    if (typeof body.query !== "string" || body.query.trim().length === 0) {
      return reply.code(400).send({ error: "query is required" });
    }
    try {
      return await options.retrieval!.search(body.query.trim());
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
