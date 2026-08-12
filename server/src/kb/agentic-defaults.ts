/**
 * Default AgenticRAG wiring (G4.S3.T12) — the production
 * `AgenticRetrievalService` for the Athena chat agent.
 *
 * Before this module, `AgenticRetrievalService` was only constructed in tests
 * and `createSearchKnowledgeTool` was only registered when a caller passed
 * `agenticRetrieval` — and no production caller did. This module builds the
 * default wiring so every `createAgent` session exposes `search_knowledge`:
 *
 *   - KB retrieval: a `KnowledgeRetrievalService` matching `buildApp()`'s
 *     default wiring (app.ts) — Neo4j lean store driver from env + llm_wiki +
 *     the custom semantic mappings store (term expansion) + the feedback
 *     service's Q&A store as the reference provider (stored-QA reuse);
 *   - judge: the per-session `modelRuntime` via `createAgenticJudge` (the
 *     `athena` provider channel, same one the refinement tools use);
 *   - webSearch: keyless DuckDuckGo fallback for not-found questions.
 *
 * All stores/drivers are lazy (no I/O at construction) and every dependency is
 * injectable so tests drive the wiring offline. No Neo4j password is ever
 * hard-coded — connection config comes from `NEO4J_URI` / `NEO4J_USER` /
 * `NEO4J_PASSWORD` env (see `neo4jConfigFromEnv`).
 */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  AgenticRetrievalService,
  type AgenticJudge,
  type WebSearchProvider,
} from "./agentic-rag.js";
import { createAgenticJudge } from "./agentic-llm.js";
import { DuckDuckGoWebSearchProvider } from "./web-search.js";
import {
  KnowledgeRetrievalService,
  type QaReferenceProvider,
} from "./retrieval.js";
import { LlmWikiClient } from "./llmwiki.js";
import { WikiFrontmatterSyncer } from "./wiki-frontmatter.js";
import { createNeo4jDriver, neo4jConfigFromEnv } from "./store/driver.js";
import type { Neo4jDriverLike } from "./store/schema.js";
import { LlamaCppReranker } from "./store/rerank.js";
import { Neo4jRetrievalService } from "./store/retrieval.js";
import { OpenRouterEmbedder } from "./embedding.js";
import {
  MemorySemanticMappingStore,
  PostgresSemanticMappingStore,
  type SemanticMappingStore,
} from "./semantic-mappings.js";
import { FeedbackService } from "./feedback.js";
import { MemoryQaPairStore, PostgresQaPairStore } from "./qa-pairs.js";
import { Neo4jQaEmbeddingIndex } from "./qa-index.js";

export interface DefaultAgenticRetrievalOptions {
  /** llm_wiki client. Default: a live `new LlmWikiClient()`. */
  llmwiki?: LlmWikiClient;
  /** Neo4j lean RAG store retrieval. Default: env-wired driver when
   *  `NEO4J_PASSWORD` is set, else none (keyword-only retrieval). */
  neo4j?: Neo4jRetrievalService;
  /** Semantic-mappings store (term expansion, G4.S3.T6). Default: Postgres
   *  when `DATABASE_URL` is set, else in-memory. */
  mappings?: SemanticMappingStore;
  /** Stored Q&A reference provider (G4.S3.T6). Default: the feedback service
   *  sharing the same Q&A store/vector index as the app. */
  qa?: QaReferenceProvider;
  /** llm_wiki project id. Default: `LLM_WIKI_PROJECT_ID` env. */
  projectId?: string;
  /** llm_wiki wiki pages directory. Default: `LLM_WIKI_WIKI_DIR` env. */
  wikiDir?: string;
  /** LLM judge. Default: `createAgenticJudge(modelRuntime)`. */
  judge?: AgenticJudge;
  /** Web-search fallback provider. Default: `DuckDuckGoWebSearchProvider`. */
  webSearch?: WebSearchProvider;
}

export interface DefaultAgenticRetrieval {
  /** The agentic RAG service driving the `search_knowledge` tool. */
  service: AgenticRetrievalService;
  /** The underlying KB retrieval (exposed for callers/tests to inspect). */
  retrieval: KnowledgeRetrievalService;
}

/** Neo4j lean RAG store retrieval from an env-wired driver (mirrors
 *  `defaultNeo4jRetrieval()` in app.ts, incl. the optional RERANK_URL
 *  cross-encoder reranker). */
function envNeo4jRetrieval(driver: Neo4jDriverLike): Neo4jRetrievalService {
  const rerankUrl = process.env.RERANK_URL;
  return new Neo4jRetrievalService({
    driver,
    embedder: new OpenRouterEmbedder(),
    ...(rerankUrl ? { reranker: new LlamaCppReranker({ baseUrl: rerankUrl }) } : {}),
  });
}

/** The default Q&A reference provider — the app's feedback service (G4.S3.T5/6):
 *  Postgres Q&A store when `DATABASE_URL` is set, else memory; the Neo4j Q&A
 *  vector index (stored-QA dedup + reference lookup) only when the driver and
 *  an embedding key are both available (mirrors `defaultFeedbackService()`). */
function envFeedbackQa(
  wikiDir: string | undefined,
  driver: Neo4jDriverLike | undefined,
): QaReferenceProvider {
  const connectionString = process.env.DATABASE_URL;
  const store = connectionString
    ? new PostgresQaPairStore({ connectionString })
    : new MemoryQaPairStore();
  const syncer = new WikiFrontmatterSyncer({ wikiDir, driver });
  if (driver && process.env.EMBEDDING_OPENROUTER_KEY) {
    return new FeedbackService({
      store,
      syncer,
      index: new Neo4jQaEmbeddingIndex({ driver, embedder: new OpenRouterEmbedder() }),
    });
  }
  return new FeedbackService({ store, syncer });
}

/**
 * Build the default agentic RAG wiring for a chat agent session. All sources
 * are lazy — constructing it never touches the network — so it is safe to run
 * inside `createAgent` on every session.
 */
export function createDefaultAgenticRetrieval(
  modelRuntime: ModelRuntime,
  options: DefaultAgenticRetrievalOptions = {},
): DefaultAgenticRetrieval {
  const wikiDir = options.wikiDir ?? process.env.LLM_WIKI_WIKI_DIR ?? undefined;
  const projectId = options.projectId ?? process.env.LLM_WIKI_PROJECT_ID ?? undefined;
  const config = neo4jConfigFromEnv();
  const driver = config ? createNeo4jDriver(config) : undefined;

  const mappings =
    options.mappings ??
    (process.env.DATABASE_URL
      ? new PostgresSemanticMappingStore({ connectionString: process.env.DATABASE_URL })
      : new MemorySemanticMappingStore());

  const neo4j = options.neo4j ?? (driver ? envNeo4jRetrieval(driver) : undefined);

  const retrieval = new KnowledgeRetrievalService({
    llmwiki: options.llmwiki ?? new LlmWikiClient(),
    ...(neo4j ? { neo4j } : {}),
    projectId,
    wikiDir,
    frontmatter: new WikiFrontmatterSyncer({ wikiDir, driver }),
    mappings,
    qa: options.qa ?? envFeedbackQa(wikiDir, driver),
  });

  const service = new AgenticRetrievalService({
    search: (query, searchOptions) => retrieval.search(query, searchOptions),
    topics: () => retrieval.getGraphTopics(),
    graph: () => retrieval.getGraph(),
    judge: options.judge ?? createAgenticJudge(modelRuntime),
    webSearch: options.webSearch ?? new DuckDuckGoWebSearchProvider(),
  });

  return { service, retrieval };
}
