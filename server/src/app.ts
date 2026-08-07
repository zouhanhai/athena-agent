import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { AgentManager } from "./agents/manager.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerKbRoutes } from "./routes/kb.js";
import { KnowledgeIngestService } from "./kb/ingest.js";
import { KnowledgeRetrievalService } from "./kb/retrieval.js";
import { DoclingParser } from "./kb/docling.js";
import { IngestTaskQueue } from "./kb/tasks.js";
import { ContentDedupStore } from "./kb/dedup.js";
import { LightRagClient } from "./kb/lightrag.js";
import { LlmWikiClient } from "./kb/llmwiki.js";

export interface BuildAppOptions {
  manager?: AgentManager;
  ingest?: KnowledgeIngestService;
  retrieval?: KnowledgeRetrievalService;
  taskQueue?: IngestTaskQueue;
  /** Max multipart upload size (bytes). Default: 50 MiB. */
  maxFileSize?: number;
}

export function defaultIngestService(): KnowledgeIngestService {
  return new KnowledgeIngestService({
    lightrag: new LightRagClient(),
    llmwiki: new LlmWikiClient(),
    wikiDir: process.env.LLM_WIKI_WIKI_DIR ?? undefined,
    projectId: process.env.LLM_WIKI_PROJECT_ID ?? undefined,
  });
}

export function defaultRetrievalService(): KnowledgeRetrievalService {
  return new KnowledgeRetrievalService({
    lightrag: new LightRagClient(),
    llmwiki: new LlmWikiClient(),
    projectId: process.env.LLM_WIKI_PROJECT_ID ?? undefined,
  });
}

export function defaultTaskQueue(): IngestTaskQueue {
  const ingest = defaultIngestService();
  return new IngestTaskQueue({
    parser: new DoclingParser(),
    ingest,
    dedup: new ContentDedupStore({
      loadExisting: async () => ingest.existingWikiContent(),
    }),
  });
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: true });
  const manager = options.manager ?? new AgentManager();

  app.register(multipart, {
    limits: { fileSize: options.maxFileSize ?? 50 * 1024 * 1024 },
  });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  registerChatRoutes(app, { manager });
  registerKbRoutes(app, {
    ingest: options.ingest ?? defaultIngestService(),
    retrieval: options.retrieval ?? defaultRetrievalService(),
    taskQueue: options.taskQueue ?? defaultTaskQueue(),
    maxFileSize: options.maxFileSize,
  });

  return app;
}
