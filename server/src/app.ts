import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { AgentManager } from "./agents/manager.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerKbRoutes } from "./routes/kb.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerLogoRoutes } from "./routes/logos.js";
import {
  MemoryAgentRegistry,
  PostgresAgentRegistry,
  DEFAULT_ATHENA,
  type AgentRegistry,
} from "./agents/registry.js";
import {
  FileLogoStore,
  OpenRouterLogoClient,
  type LogoStore,
} from "./agents/logos.js";
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
  registry?: AgentRegistry;
  logos?: LogoStore;
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

export function defaultAgentRegistry(): AgentRegistry {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString) {
    return new PostgresAgentRegistry({ connectionString });
  }
  return new MemoryAgentRegistry([DEFAULT_ATHENA]);
}

/** Default file-backed logo store rooted at web/public/logos with the owl as style reference. */
export function defaultLogoStore(): LogoStore {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  return new FileLogoStore({
    dir: path.join(repoRoot, "web", "public", "logos"),
    client: new OpenRouterLogoClient(),
    referenceImage: readFileSync(path.join(repoRoot, "web", "public", "athena-logo-ai.png")),
  });
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: true });
  const manager = options.manager ?? new AgentManager();
  const registry = options.registry ?? defaultAgentRegistry();
  const logos = options.logos ?? defaultLogoStore();

  app.register(multipart, {
    limits: { fileSize: options.maxFileSize ?? 50 * 1024 * 1024 },
  });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  app.addHook("onReady", async () => {
    if (!options.registry) {
      await registry.seed();
    }
  });

  app.addHook("onClose", async () => {
    await registry.close();
    await logos.close();
  });

  registerAgentRoutes(app, { registry });
  registerLogoRoutes(app, { logoStore: logos, registry });
  registerChatRoutes(app, { manager });
  registerKbRoutes(app, {
    ingest: options.ingest ?? defaultIngestService(),
    retrieval: options.retrieval ?? defaultRetrievalService(),
    taskQueue: options.taskQueue ?? defaultTaskQueue(),
    maxFileSize: options.maxFileSize,
  });

  return app;
}
