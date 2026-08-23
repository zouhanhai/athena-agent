import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { AgentManager } from "./agents/manager.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerKbRoutes } from "./routes/kb.js";
import { registerKbMcpRoutes } from "./routes/kb-mcp.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerLogoRoutes } from "./routes/logos.js";
import { registerEmployeeRoutes } from "./routes/employees.js";
import { registerGithubRoutes } from "./routes/github.js";
import { registerKanbanRoutes } from "./routes/kanban.js";
import { registerInvitationRoutes } from "./routes/invitations.js";
import { defaultSecretCipher, type SecretCipher } from "./employees/crypto.js";
import { GithubRestClient, type GitHubApi } from "./github/client.js";
import { MemoryGithubOpStore, type GithubOpStore } from "./github/ops.js";
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
import { WikiFrontmatterSyncer } from "./kb/wiki-frontmatter.js";
import { WikiReviewStateService } from "./kb/review-state.js";
import { defaultRefinementOutputDir } from "./agents/refine-document.js";
import { defaultCodeOutputDir } from "./kb/store/code.js";
import { KbReviewService, scheduleKbReview } from "./kb/review.js";
import { KbAuditScheduler, KbAuditService } from "./kb/audit.js";
import {
  defaultKbAuditRunsStore,
  type KbAuditRunsStore,
} from "./kb/audit-runs.js";
import { KbCommunityMaintenanceService } from "./kb/community-maintenance.js";
import { WikiReCurator } from "./kb/recurate.js";
import { FeedbackService } from "./kb/feedback.js";
import { MemoryQaPairStore, PostgresQaPairStore } from "./kb/qa-pairs.js";
import { Neo4jQaEmbeddingIndex } from "./kb/qa-index.js";
import {
  MemorySemanticMappingStore,
  PostgresSemanticMappingStore,
  type SemanticMappingStore,
} from "./kb/semantic-mappings.js";
import {
  MemoryChatHistoryStore,
  PostgresChatHistoryStore,
  type ChatHistoryStore,
} from "./agents/chat-history.js";
import { DoclingParser } from "./kb/docling.js";
import { IngestTaskQueue } from "./kb/tasks.js";
import { createAthenaRefiner, createAthenaWikiEditRefiner } from "./kb/refiner.js";
import { ContentDedupStore } from "./kb/dedup.js";
import { LlmWikiClient } from "./kb/llmwiki.js";
import { OpenRouterEmbedder } from "./kb/embedding.js";
import { Neo4jIngestService } from "./kb/store/ingest.js";
import { Neo4jCommunityService } from "./kb/store/community.js";
import { Neo4jCommunitySummaryService } from "./kb/store/community-summary.js";
import { Neo4jRetrievalService, type Reranker } from "./kb/store/retrieval.js";
import { EntityGraphService } from "./kb/store/graph.js";
import { LlamaCppReranker } from "./kb/store/rerank.js";
import { createNeo4jDriver, neo4jConfigFromEnv } from "./kb/store/driver.js";
import { DOCUMENT_LABEL, IS_DOCUMENT_TYPE, WIKIPAGE_LABEL, type Neo4jDriverLike } from "./kb/store/schema.js";
import { AgentWsGateway } from "./ws/agent.js";
import {
  createSharedAthenaSummarizer,
  type Summarizer,
} from "./agents/chat-context.js";

export interface BuildAppOptions {
  manager?: AgentManager;
  ingest?: KnowledgeIngestService;
  retrieval?: KnowledgeRetrievalService;
  /** Athena KB review pass (G4.S3.T2). Default: defaultReviewService(). */
  review?: KbReviewService;
  /**
   * G4.S8.T15: the weekly knowledge-base audit service (3-stage pipeline).
   * Default: built from the review service + Neo4j ingest + runs store.
   */
  audit?: KbAuditService;
  /** G4.S8.T15: audit report persistence. Default: Postgres when DATABASE_URL
   *  is set, else in-memory. */
  auditRunsStore?: KbAuditRunsStore;
  /** G4.S9.T4 admin community maintenance (manual full recompute + weekly
   *  community-quality snapshot). Default: wired from the Neo4j driver when
   *  available, undefined otherwise (endpoint then reports 500). */
  communityMaintenance?: KbCommunityMaintenanceService;
  /**
   * G4.S8.T15: start the in-server weekly audit scheduler on ready. Only the
   * real server entry opts in (default false) so the test suite's buildApp()
   * calls never trigger catch-up audits; the scheduler itself still honors
   * KB_AUDIT_ENABLED/DAY/HOUR.
   */
  auditScheduler?: boolean;
  /** Incremental re-curation tool (G4.S3.T3). Default: defaultReCurator(). */
  recurator?: WikiReCurator;
  /** Feedback loop service (G4.S3.T5). Default: defaultFeedbackService(). */
  feedback?: FeedbackService;
  /** Custom semantic mappings (G4.S3.T6). Default: defaultSemanticMappings(). */
  mappings?: SemanticMappingStore;
  /** G4.S7.T11-followup: per-user chat history persistence. Default:
   *  defaultChatHistoryStore() (Postgres when DATABASE_URL is set). */
  historyStore?: ChatHistoryStore;
  taskQueue?: IngestTaskQueue;
  /** G4.S8.T17: per-page wiki review workflow (GET/POST review-state).
   *  Default: built from the retrieval service + the canonical syncer. */
  reviewState?: WikiReviewStateService;
  registry?: AgentRegistry;
  logos?: LogoStore;
  employees?: EmployeeRegistry;
  auth?: AuthService;
  github?: GitHubApi;
  ops?: GithubOpStore;
  cipher?: SecretCipher;
  invitations?: InvitationService;
  /** Max multipart upload size (bytes). Default: 50 MiB. */
  maxFileSize?: number;
  /** G4.S7.T4: reverse-WS gateway (remote agents connect INTO the platform). */
  hub?: AgentWsGateway;
  /** G4.S7.T4: idle window before an unresponsive pushed task auto-errors (ms). */
  agentWsIdleTimeoutMs?: number;
  /**
   * G4.S7.T10: LLM seam that summarizes old remote-chat history above the token
   * threshold. Default: a lazy shared athena-channel summarizer (ModelRuntime is
   * only built on first use). Inject a fake to keep tests off the network.
   */
  summarizer?: Summarizer;
}

export function defaultIngestService(
  neo4j?: Neo4jIngestService,
  community?: Neo4jCommunityService,
  communitySummaries?: Neo4jCommunitySummaryService,
): KnowledgeIngestService {
  return new KnowledgeIngestService({
    llmwiki: new LlmWikiClient(),
    wikiDir: process.env.LLM_WIKI_WIKI_DIR ?? undefined,
    projectId: process.env.LLM_WIKI_PROJECT_ID ?? undefined,
    // G4.S8.T14: wiki page delete → full knowledge-graph cascade (subtree +
    // orphan entities + refinement dirs). Absent when NEO4J_PASSWORD is unset.
    ...(neo4j ? { graph: neo4j } : {}),
    // G4.S9.T1: delete cascade → async full community re-run (fire-and-forget).
    ...(community ? { community } : {}),
    // G4.S9.T2: summaries re-synced after the delete-triggered clustering.
    ...(communitySummaries ? { communitySummaries } : {}),
  });
}

export function defaultRetrievalService(): KnowledgeRetrievalService {
  const wikiDir = process.env.LLM_WIKI_WIKI_DIR ?? undefined;
  const driver = defaultNeo4jDriver();
  return new KnowledgeRetrievalService({
    llmwiki: new LlmWikiClient(),
    // G4.S2.T7/T10: the Neo4j lean RAG store is the sole semantic + graph path;
    // llm_wiki stays the BM25 source.
    neo4j: driver
      ? new Neo4jRetrievalService({
          driver,
          embedder: new OpenRouterEmbedder(),
          reranker: createDefaultReranker(),
        })
      : undefined,
    // G4.S8.T12: the SE80-style code-object browser graph-query service, built
    // from the same driver.
    entityGraph: driver ? new EntityGraphService({ driver }) : undefined,
    projectId: process.env.LLM_WIKI_PROJECT_ID ?? undefined,
    // Match the ingest side (defaultIngestService) so wiki image reads resolve
    // against the same on-disk wiki dir (G3.S5.T5).
    wikiDir,
    // G4.S3.T1: the canonical wiki-frontmatter syncer tracks read_count on the
    // wiki md + Neo4j Document node (write-through) when pages are surfaced.
    frontmatter: new WikiFrontmatterSyncer({ wikiDir, driver }),
    // G4.S3.T6: the search path consumes the semantic mappings (term query
    // expansion) + the stored Q&A (reference context). Default wiring happens
    // in buildApp() so retrieval shares the feedback service's QA store/index.
  });
}

/** Default custom semantic mappings store (G4.S3.T6): Postgres when DATABASE_URL
 *  is set, else in-memory. */
export function defaultSemanticMappings(): SemanticMappingStore {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString) {
    return new PostgresSemanticMappingStore({ connectionString });
  }
  return new MemorySemanticMappingStore();
}

/** G4.S7.T11-followup: per-user chat history persistence. Postgres when
 *  DATABASE_URL is set (F5 keeps the conversation), else in-memory. */
export function defaultChatHistoryStore(): ChatHistoryStore {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString) {
    return new PostgresChatHistoryStore({ connectionString });
  }
  return new MemoryChatHistoryStore();
}

/** Neo4j driver from env (NEO4J_PASSWORD set), else undefined. */
export function defaultNeo4jDriver(): Neo4jDriverLike | undefined {
  const config = neo4jConfigFromEnv();
  return config ? createNeo4jDriver(config) : undefined;
}

/** Default Athena KB review service (G4.S3.T2): scans wiki frontmatter and
 *  re-topics / re-classifies / deprecates / reinforces, writing every change
 *  through the canonical WikiFrontmatterSyncer (wiki md + Neo4j Document). */
export function defaultReviewService(): KbReviewService {
  const wikiDir = process.env.LLM_WIKI_WIKI_DIR ?? undefined;
  const driver = defaultNeo4jDriver();
  return new KbReviewService({
    llmwiki: new LlmWikiClient(),
    syncer: new WikiFrontmatterSyncer({ wikiDir, driver }),
    projectId: process.env.LLM_WIKI_PROJECT_ID ?? undefined,
  });
}

/** Default incremental re-curation tool (G4.S3.T3): moves a wiki page into a
 *  deeper topic dir + updates topic/topic_history/last_reviewed + rebuilds the
 *  wiki index + rescans llm_wiki. Wiki-only — no Neo4j re-chunk / re-embed. */
export function defaultReCurator(): WikiReCurator {
  return new WikiReCurator({
    wikiDir: process.env.LLM_WIKI_WIKI_DIR ?? undefined,
    llmwiki: new LlmWikiClient(),
    projectId: process.env.LLM_WIKI_PROJECT_ID ?? undefined,
  });
}

/** Default feedback loop service (G4.S3.T5): Q&A pairs in Postgres (memory when
 *  DATABASE_URL is unset), confidence changes through the canonical syncer.
 *  Q&A dedup (vector search for a semantically similar question before insert)
 *  is active when BOTH the Neo4j store and the embedding key are available —
 *  otherwise feedback stores insert-only. */
export function defaultFeedbackService(): FeedbackService {
  const wikiDir = process.env.LLM_WIKI_WIKI_DIR ?? undefined;
  const driver = defaultNeo4jDriver();
  const connectionString = process.env.DATABASE_URL;
  const store = connectionString
    ? new PostgresQaPairStore({ connectionString })
    : new MemoryQaPairStore();
  const syncer = new WikiFrontmatterSyncer({ wikiDir, driver });
  if (driver && process.env.EMBEDDING_OPENROUTER_KEY) {
    const embedder = new OpenRouterEmbedder();
    return new FeedbackService({
      store,
      syncer,
      index: new Neo4jQaEmbeddingIndex({ driver, embedder }),
    });
  }
  return new FeedbackService({ store, syncer });
}

/** Neo4j lean RAG store retrieval (G4.S2.T5): fused vector + BM25 + graph.
 *  Returns undefined when NEO4J_PASSWORD is unset (store not deployed). */
export function defaultNeo4jRetrieval(): Neo4jRetrievalService | undefined {
  const driver = defaultNeo4jDriver();
  if (!driver) return undefined;
  return new Neo4jRetrievalService({
    driver,
    embedder: new OpenRouterEmbedder(),
    // G4.S2.T14: optional local cross-encoder rerank after RRF fusion. Off by default.
    reranker: createDefaultReranker(),
  });
}

/** Local cross-encoder reranker (G4.S2.T14) from env: RERANK_URL points at a llama.cpp
 *  `/rerank` server (e.g. http://127.0.0.1:9632). Returns undefined when unset — pure
 *  RRF fusion, no reranking. */
export function createDefaultReranker(): Reranker | undefined {
  const url = process.env.RERANK_URL;
  if (!url) return undefined;
  return new LlamaCppReranker({ baseUrl: url });
}

export function defaultTaskQueue(): IngestTaskQueue {
  // G4.S8.T14: one shared Neo4j ingest service drives both the ingest stage and
  // the delete cascade (undefined when NEO4J_PASSWORD is unset → both no-op).
  const neo4j = defaultNeo4jIngest();
  // G4.S9.T1: community detection refreshes after ingest/wiki-edit/delete —
  // same undefined-when-unwired contract as the store itself.
  const community = defaultCommunityService();
  // G4.S9.T2: summaries synced after each clustering refresh (same contract).
  const communitySummaries = defaultCommunitySummaryService();
  const ingest = defaultIngestService(neo4j, community, communitySummaries);
  const dedup = new ContentDedupStore({
    loadExisting: async () => ingest.existingWikiContent(),
  });
  // Delete-cascade hook (G4.S8.T14 follow-up): purge dedup entries when a page
  // is deleted so the same file can be re-ingested afterwards.
  ingest.attachDedupStore(dedup);
  return new IngestTaskQueue({
    parser: new DoclingParser(),
    ingest,
    refiner: createAthenaRefiner(),
    // G4.S3.T10: wiki-edit diff-refine (corrected markdown + diff → RAG overwrite).
    wikiRefiner: createAthenaWikiEditRefiner(),
    dedup,
    // G4.S2.T4: the lean Neo4j RAG store is wired only when NEO4J_PASSWORD is
    // set (see .env.local / deployment). When absent the ingesting_neo4j stage
    // is a no-op and ingestion continues unchanged.
    neo4j,
    // G4.S9.T1: entity-graph community refresh triggers (ingest/wiki-edit).
    ...(community ? { community } : {}),
    // G4.S9.T2: community summaries chained after each refresh (fire-and-forget).
    ...(communitySummaries ? { communitySummaries } : {}),
    // G4.S8.T21: after a wiki save, restamp the page's review gate from the
    // wiki-edit refinement quality through the canonical syncer (wiki md +
    // Neo4j Document mirror), mirroring the upload path's reviewGate stamp.
    frontmatter: new WikiFrontmatterSyncer({
      resolveWikiDir: async () => (await ingest.resolveProject()).wikiDir,
      driver: defaultNeo4jDriver(),
    }),
  });
}

/** Neo4j lean RAG store ingest (G4.S2.T4): embed + index Athena output. Returns
 *  undefined when NEO4J_PASSWORD is unset (store not deployed → stage no-op). */
export function defaultNeo4jIngest(): Neo4jIngestService | undefined {
  const driver = defaultNeo4jDriver();
  if (!driver) return undefined;
  return new Neo4jIngestService({
    driver,
    embedder: new OpenRouterEmbedder(),
    // G4.S9.T3: weak CO_OCCURS edges default ON; KB_CO_OCCURS_ENABLED=false
    // disables derivation entirely (legacy graphs / opt-out).
    coOccurs: process.env.KB_CO_OCCURS_ENABLED !== "false",
  });
}

/**
 * G4.S9.T1: Leiden-class community detection over the entity graph, in-process
 * (the neo4j-spike container ships no GDS plugin). Returns undefined when the
 * store is not wired — refresh triggers then no-op.
 */
export function defaultCommunityService(): Neo4jCommunityService | undefined {
  const driver = defaultNeo4jDriver();
  if (!driver) return undefined;
  return new Neo4jCommunityService({ driver });
}

/**
 * G4.S9.T2: per-community LLM summaries over T1's memberships. Returns
 * undefined when the store is not wired — the sync trigger then no-ops.
 */
export function defaultCommunitySummaryService(): Neo4jCommunitySummaryService | undefined {
  const driver = defaultNeo4jDriver();
  if (!driver) return undefined;
  return new Neo4jCommunitySummaryService({
    driver,
    // G4.S9.T3: embed fresh summaries onto the Community nodes so the global
    // query path can vector-match them (BM25 works without embeddings).
    ...(process.env.EMBEDDING_OPENROUTER_KEY ? { embedder: new OpenRouterEmbedder() } : {}),
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
export { defaultSecretCipher };

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

/** G4.S8.T15: the weekly knowledge-base audit — review pass (existing
 *  reviewAll) + WikiPage-vs-disk file re-check (T14 cascade repairs) + orphan
 *  refinement sweep + G4.S9.T4 community-quality snapshot, persisted one
 *  report row per run. */
export function defaultKbAuditService(
  review: KbReviewService,
  runsStore: KbAuditRunsStore,
  communities?: KbCommunityMaintenanceService,
): KbAuditService {
  return new KbAuditService({
    review,
    runsStore,
    graph: defaultNeo4jIngest(),
    ...(communities ? { communities } : {}),
    wikiDir: process.env.LLM_WIKI_WIKI_DIR || undefined,
  });
}

/**
 * G4.S9.T4: admin community maintenance over the SAME T1/T2 services the
 * ingest hooks use (one clustering engine, one summarizer). Undefined when no
 * Neo4j driver is available — the recompute endpoint then answers 500.
 */
export function defaultCommunityMaintenance(): KbCommunityMaintenanceService | undefined {
  const driver = defaultNeo4jDriver();
  if (!driver) return undefined;
  return new KbCommunityMaintenanceService({
    driver,
    community: defaultCommunityService(),
    communitySummaries: defaultCommunitySummaryService(),
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
  const ops = options.ops ?? new MemoryGithubOpStore();
  const invitations = options.invitations ?? defaultInvitationService(employees, tokens!);
  const review = options.review ?? defaultReviewService();
  const feedback = options.feedback ?? defaultFeedbackService();
  const mappings = options.mappings ?? defaultSemanticMappings();
  const historyStore = options.historyStore ?? defaultChatHistoryStore();
  // G4.S3.T6: the default retrieval shares the feedback service's QA store/index
  // as the search-path reference provider + the semantic mappings store for term
  // query expansion. An injected retrieval keeps its own wiring.
  const retrieval =
    options.retrieval ??
    (() => {
      const wikiDir = process.env.LLM_WIKI_WIKI_DIR ?? undefined;
      const driver = defaultNeo4jDriver();
      return new KnowledgeRetrievalService({
        llmwiki: new LlmWikiClient(),
        neo4j: driver
          ? new Neo4jRetrievalService({
              driver,
              embedder: new OpenRouterEmbedder(),
              reranker: createDefaultReranker(),
            })
          : undefined,
        entityGraph: driver ? new EntityGraphService({ driver }) : undefined,
        projectId: process.env.LLM_WIKI_PROJECT_ID ?? undefined,
        wikiDir,
        frontmatter: new WikiFrontmatterSyncer({ wikiDir, driver }),
        mappings,
        qa: feedback,
      });
    })();

  app.register(multipart, {
    limits: { fileSize: options.maxFileSize ?? 50 * 1024 * 1024 },
  });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  // G4.S8.T15: the weekly knowledge-base audit (3 stages, one persisted
  // report row per run) + manual trigger endpoints in registerKbRoutes.
  const auditRunsStore = options.auditRunsStore ?? defaultKbAuditRunsStore();
  // G4.S9.T4: admin community maintenance (manual recompute endpoint + the
  // weekly audit's community-quality section share this one instance).
  const communityMaintenance =
    options.communityMaintenance ?? defaultCommunityMaintenance();
  const audit =
    options.audit ??
    defaultKbAuditService(options.review ?? review, auditRunsStore, communityMaintenance);
  let auditScheduler: KbAuditScheduler | undefined;

  app.addHook("onReady", async () => {
    if (!options.registry) {
      await registry.seed();
    }
    if (!options.employees) {
      await employees.seed();
    }
    // G4.S3.T2: scheduled Athena KB review (KB_REVIEW_INTERVAL_MS set → run
    // every N ms on demand). Best-effort; a failing run never crashes the server.
    const interval = Number(process.env.KB_REVIEW_INTERVAL_MS);
    if (Number.isFinite(interval) && interval > 0) {
      scheduledReview = scheduleKbReview(review, interval);
    }
    // G4.S8.T15: weekly KB audit scheduler — ONLY the real server entry opts
    // in via auditScheduler: true; tests construct buildApp() hundreds of
    // times and must never fire catch-up audits. Env-configurable cadence:
    // KB_AUDIT_ENABLED (default true) / KB_AUDIT_DAY / KB_AUDIT_HOUR.
    if (options.auditScheduler) {
      auditScheduler = new KbAuditScheduler({ service: audit, runsStore: auditRunsStore });
      await auditScheduler.start();
    }
  });

  // G4.S7.T1/T4: reverse-WebSocket gateway for remote agents (connect INTO the
  // platform via /ws/agent; register {agent_id, token}; platform drives them
  // back through the live tunnel). Built eagerly — app.server exists from
  // construction — so the chat + agents routes can use it at request time.
  const hub =
    options.hub ??
    new AgentWsGateway(app.server, { registry, idleTimeoutMs: options.agentWsIdleTimeoutMs });

  let scheduledReview: ReturnType<typeof scheduleKbReview> | undefined;

  app.addHook("onClose", async () => {
    hub.close();
    scheduledReview?.stop();
    auditScheduler?.stop();
    await auditRunsStore.close();
    await registry.close();
    await logos.close();
    await employees.close();
    await auth.close();
    await invitations.close();
    await feedback.close();
    if (options.auth && !options.invitations) {
      // The default invitation service owns the token store auth didn't consume;
      // close it so a Postgres-backed pool is not leaked on shutdown.
      await tokens?.close();
    }
  });

  registerAgentRoutes(app, { registry, auth, hub, employees });
  registerLogoRoutes(app, { logoStore: logos, registry, employees });
  registerChatRoutes(app, {
    manager,
    hub,
    registry,
    historyStore,
    summarizer: options.summarizer ?? createSharedAthenaSummarizer(),
  });
  // G4.S7.T4: expose the reverse-WS gateway so consumers (and tests) can inspect
  // live tunnels / reachability without a second server instance.
  app.decorate("agentHub", hub);
  registerEmployeeRoutes(app, { employees, auth, agents: registry });
  registerGithubRoutes(app, { employees, auth, github, ops });
  registerKanbanRoutes(app, { auth, employees, github });
  registerInvitationRoutes(app, { invitations, auth });
  // Shared graph-wired ingest instance: the delete cascade (T14) AND the
  // review-state syncer's wiki-dir resolution (T17) both need Neo4j access.
  // ONE shared ingest instance end-to-end: the task queue's ingest carries the
  // dedup store (attachDedupStore) — a SECOND defaultIngestService() here had no
  // dedup, so doc/delete silently skipped the dedup purge and a delete followed
  // by re-upload short-circuited as a hash duplicate.
  const kbQueue = options.taskQueue ?? defaultTaskQueue();
  const kbIngest = options.ingest ?? kbQueue.ingest;
  registerKbRoutes(app, {
    ingest: kbIngest,
    retrieval,
    review: options.review ?? defaultReviewService(),
    recurator: options.recurator ?? defaultReCurator(),
    feedback,
    mappings,
    taskQueue: kbQueue,
    maxFileSize: options.maxFileSize,
    // G4.S8.T15: manual audit trigger + report history (admin-gated).
    audit,
    auditRunsStore,
    // G4.S9.T4: admin community recompute endpoint (admin-gated).
    communityMaintenance,
    // G4.S3.T10: the wiki-edit save endpoint is RBAC-gated behind `kb.edit`.
    auth,
    // G4.S8.T10: code-intake channels authenticate agent invitation tokens
    // against the same registry the WS `register` frame uses.
    registry,
    // G4.S8.T17: per-page review workflow — quality.json under the refinement
    // AND code output roots (both write `<stem>/quality.json`), gate state
    // written through the canonical syncer (wiki md + Neo4j Document mirror).
    reviewState:
      options.reviewState ??
      new WikiReviewStateService({
        readPage: (path) => retrieval.readWikiPageRaw(path),
        refinementRoots: [defaultRefinementOutputDir(), defaultCodeOutputDir()],
        // G4.S8.T18: resolve quality.json via the page's Neo4j Document.md_ref
        // FIRST (exact refinement dir); basename matching stays as fallback.
        resolveMdRef: async (wikiPath) => {
          const driver = defaultNeo4jDriver();
          if (!driver) return null;
          const session = driver.session();
          try {
            const result = (await session.run(
              `MATCH (wp:${WIKIPAGE_LABEL} {id: $wikiPath})<-[:${IS_DOCUMENT_TYPE}]-(d:${DOCUMENT_LABEL})
               RETURN d.md_ref AS mdRef LIMIT 1`,
              { wikiPath },
            )) as { records: Array<{ get(key: string): unknown }> };
            const mdRef = result.records[0]?.get("mdRef");
            return typeof mdRef === "string" && mdRef.length > 0 ? mdRef : null;
          } catch {
            return null;
          } finally {
            await session.close();
          }
        },
        // G4.S8.T21: the wiki-edit refinement dir persisted by overwrite() —
        // its quality.json wins over the original md_ref dir so the review UI
        // serves POST-edit issues.
        resolveLastEditRef: async (wikiPath) => {
          const driver = defaultNeo4jDriver();
          if (!driver) return null;
          const session = driver.session();
          try {
            const result = (await session.run(
              `MATCH (wp:${WIKIPAGE_LABEL} {id: $wikiPath})<-[:${IS_DOCUMENT_TYPE}]-(d:${DOCUMENT_LABEL})
               RETURN d.last_edit_ref AS lastEditRef LIMIT 1`,
              { wikiPath },
            )) as { records: Array<{ get(key: string): unknown }> };
            const lastEditRef = result.records[0]?.get("lastEditRef");
            return typeof lastEditRef === "string" && lastEditRef.length > 0 ? lastEditRef : null;
          } catch {
            return null;
          } finally {
            await session.close();
          }
        },
        syncer: new WikiFrontmatterSyncer({
          // LLM_WIKI_WIKI_DIR is not set in deployments — resolve the wiki dir
          // lazily through the ingest project lookup instead (same source the
          // ingest pipeline uses). Without this, syncer.update throws
          // "wiki dir could not be resolved" → review actions 500.
          resolveWikiDir: async () => (await kbIngest.resolveProject()).wikiDir,
          driver: defaultNeo4jDriver(),
        }),
      }),
  });

  // G4.S7.T3: KB-as-MCP — wrap KnowledgeRetrievalService into the 5 retrieval
  // MCP tools over Streamable HTTP (search_knowledge / get_wiki_page /
  // get_graph / get_kb_topics / get_wiki_tree), auth'd with the platform's
  // per-employee session token, reachable from any external agent over the
  // public URL (athenakb.com). A2A (answer()) is deferred to M6.
  registerKbMcpRoutes(app, { retrieval, auth });

  return app;
}
