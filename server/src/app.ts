import Fastify, { type FastifyInstance } from "fastify";
import { AgentManager } from "./agents/manager.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerKbRoutes } from "./routes/kb.js";
import { KnowledgeIngestService } from "./kb/ingest.js";
import { KnowledgeRetrievalService } from "./kb/retrieval.js";
import { LightRagClient } from "./kb/lightrag.js";
import { LlmWikiClient } from "./kb/llmwiki.js";

export interface BuildAppOptions {
  manager?: AgentManager;
  ingest?: KnowledgeIngestService;
  retrieval?: KnowledgeRetrievalService;
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

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const manager = options.manager ?? new AgentManager();

  app.get("/health", async () => {
    return { status: "ok" };
  });

  registerChatRoutes(app, { manager });
  registerKbRoutes(app, {
    ingest: options.ingest ?? defaultIngestService(),
    retrieval: options.retrieval ?? defaultRetrievalService(),
  });

  return app;
}
