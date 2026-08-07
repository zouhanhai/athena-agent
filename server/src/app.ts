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
import { registerEmployeeRoutes } from "./routes/employees.js";
import { registerGithubRoutes } from "./routes/github.js";
import { registerInvitationRoutes } from "./routes/invitations.js";
import { createSecretCipher, type SecretCipher } from "./employees/crypto.js";
import { GithubRestClient, type GitHubApi } from "./github/client.js";
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
import {
  ConsoleMailer,
  MagicLinkAuthService,
  MemoryAuthTokenStore,
  PostgresAuthTokenStore,
  ResendMailer,
  type AuthService,
  type AuthTokenStore,
} from "./employees/auth.js";
import {
  ConsoleInvitationMailer,
  InvitationService,
  MemoryInvitationStore,
  PostgresInvitationStore,
  ResendInvitationMailer,
  type InvitationMailer,
} from "./employees/invitations.js";
import {
  MemoryEmployeeRegistry,
  PostgresEmployeeRegistry,
  type EmployeeRegistry,
} from "./employees/employees.js";
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
  employees?: EmployeeRegistry;
  auth?: AuthService;
  github?: GitHubApi;
  cipher?: SecretCipher;
  invitations?: InvitationService;
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

/** Default employee registry: Postgres when DATABASE_URL is set, else in-memory. */
export function defaultEmployeeRegistry(cipher: SecretCipher): EmployeeRegistry {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString) {
    return new PostgresEmployeeRegistry({ connectionString, cipher });
  }
  return new MemoryEmployeeRegistry([], { cipher });
}

/**
 * Default SecretCipher: AES-256-GCM keyed by ENCRYPTION_KEY (64 hex chars).
 * A dev-only fallback key keeps local runs working, mirroring the
 * ConsoleMailer/memory-store fallbacks used elsewhere in the auth stack.
 */
export function defaultSecretCipher(): SecretCipher {
  const key = process.env.ENCRYPTION_KEY ?? DEV_ONLY_ENCRYPTION_KEY;
  return createSecretCipher(key);
}

const DEV_ONLY_ENCRYPTION_KEY =
  "d3d1e5d0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6";

/** Default GitHub client: REST API against api.github.com. */
export function defaultGithubClient(): GitHubApi {
  return new GithubRestClient();
}

/** Default auth token store: Postgres when DATABASE_URL is set, else in-memory. */
export function defaultAuthTokenStore(): AuthTokenStore {
  const connectionString = process.env.DATABASE_URL;
  return connectionString
    ? new PostgresAuthTokenStore({ connectionString })
    : new MemoryAuthTokenStore();
}

/**
 * Default auth: email magic link via Resend when RESEND_API_KEY is set, else
 * console logs. When a token store is shared (e.g. with the invitation
 * service) pass it in so sessions resolve across services.
 */
export function defaultAuthService(
  employees: EmployeeRegistry,
  tokens: AuthTokenStore = defaultAuthTokenStore(),
): AuthService {
  const mailer = process.env.RESEND_API_KEY ? new ResendMailer() : new ConsoleMailer();
  return new MagicLinkAuthService({
    registry: employees,
    tokens,
    mailer,
    appBaseUrl: process.env.APP_BASE_URL,
  });
}

/** Default invitation mailer: Resend when RESEND_API_KEY is set, else console logs. */
export function defaultInvitationMailer(): InvitationMailer {
  return process.env.RESEND_API_KEY ? new ResendInvitationMailer() : new ConsoleInvitationMailer();
}

/**
 * Default invitation service: invitation tokens stored in Postgres when
 * DATABASE_URL is set (else in-memory); sessions share the auth token store so
 * the registration-time session resolves through the auth service.
 */
export function defaultInvitationService(
  employees: EmployeeRegistry,
  tokens: AuthTokenStore,
): InvitationService {
  const connectionString = process.env.DATABASE_URL;
  return new InvitationService({
    registry: employees,
    tokens,
    store: connectionString
      ? new PostgresInvitationStore({ connectionString })
      : new MemoryInvitationStore(),
    mailer: defaultInvitationMailer(),
    appBaseUrl: process.env.APP_BASE_URL,
  });
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
  const cipher = options.cipher ?? defaultSecretCipher();
  const employees = options.employees ?? defaultEmployeeRegistry(cipher);
  const tokens = !options.auth || !options.invitations ? defaultAuthTokenStore() : undefined;
  const auth = options.auth ?? defaultAuthService(employees, tokens);
  const github = options.github ?? defaultGithubClient();
  const invitations = options.invitations ?? defaultInvitationService(employees, tokens!);

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
    if (!options.employees) {
      await employees.seed();
    }
  });

  app.addHook("onClose", async () => {
    await registry.close();
    await logos.close();
    await employees.close();
    await auth.close();
    await invitations.close();
    if (options.auth && !options.invitations) {
      // The default invitation service owns the token store auth didn't consume;
      // close it so a Postgres-backed pool is not leaked on shutdown.
      await tokens?.close();
    }
  });

  registerAgentRoutes(app, { registry });
  registerLogoRoutes(app, { logoStore: logos, registry });
  registerChatRoutes(app, { manager });
  registerEmployeeRoutes(app, { employees, auth, agents: registry });
  registerGithubRoutes(app, { employees, auth, github });
  registerInvitationRoutes(app, { invitations, auth });
  registerKbRoutes(app, {
    ingest: options.ingest ?? defaultIngestService(),
    retrieval: options.retrieval ?? defaultRetrievalService(),
    taskQueue: options.taskQueue ?? defaultTaskQueue(),
    maxFileSize: options.maxFileSize,
  });

  return app;
}
