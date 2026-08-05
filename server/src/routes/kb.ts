import type { FastifyInstance } from "fastify";
import type { KnowledgeIngestService } from "../kb/ingest.js";

export interface KbRequestBody {
  title?: unknown;
  content?: unknown;
  source?: unknown;
}

export interface KbRouteOptions {
  ingest: KnowledgeIngestService;
}

function invalidField(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

/**
 * Knowledge ingestion endpoint:
 * - POST /api/kb/ingest { title, content, source? } → dual-pipeline ingest result.
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
}
