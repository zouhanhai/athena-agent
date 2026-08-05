import type { FastifyInstance } from "fastify";
import type { KnowledgeIngestService } from "../kb/ingest.js";
import type { KnowledgeRetrievalService } from "../kb/retrieval.js";

export interface KbRequestBody {
  title?: unknown;
  content?: unknown;
  source?: unknown;
}

export interface KbSearchBody {
  query?: unknown;
}

export interface KbRouteOptions {
  ingest: KnowledgeIngestService;
  retrieval?: KnowledgeRetrievalService;
}

function invalidField(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

/**
 * Knowledge ingestion endpoint:
 * - POST /api/kb/ingest { title, content, source? } → dual-pipeline ingest result.
 *
 * Retrieval endpoints (registered when a KnowledgeRetrievalService is provided):
 * - GET /api/kb/graph?label= → LightRAG entity-relation graph {nodes, edges}
 * - GET /api/kb/wiki → llm_wiki wiki page tree {files}
 * - GET /api/kb/wiki/page?path= → wiki page markdown {path, content}
 * - POST /api/kb/search { query } → fused LightRAG + llm_wiki results
 */
export function registerKbRoutes(app: FastifyInstance, options: KbRouteOptions): void {
  app.post("/api/kb/ingest", async (request, reply) => {
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
