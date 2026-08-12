/**
 * Agentic RAG (G4.S3.T7) — query transformation / compression / retriever picker /
 * topic convergence / multi-hop graph reasoning / not-found → web fallback.
 *
 * This module deviates from S2's pure-storage lean design: it needs an LLM in the
 * retrieval path. The LLM is injected through the `AgenticJudge` seam, so:
 *   - it is fully unit-testable without a live model;
 *   - when NO judge is injected the service falls back to non-agentic retrieval
 *     (plain `search`), so the pipeline never regresses S2 behaviour.
 *
 * The orchestrator wraps an injectable `search` function (usually
 * `KnowledgeRetrievalService.search`) plus optional graph + topics providers and
 * an optional web-search provider for the not-found fallback (G4.S3.T7.6).
 */
import type { KnowledgeGraph, KnowledgeSearchResponse, KnowledgeSearchResult } from "./retrieval.js";

/** Retriever names the agentic picker can choose (mirrors store RetrieverName). */
export type AgenticRetriever = "vector" | "bm25" | "graph" | "hybrid";

/** A single web-search result (G4.S3.T7.6). */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** The injectable web-search provider seam (G4.S3.T7.6). */
export interface WebSearchProvider {
  search(query: string): Promise<WebSearchResult[]>;
}

/** Query-transformation plan produced by the LLM (G4.S3.T7.1). */
export interface QueryPlan {
  /** clarify: ask the user for detail; decompose: run sub-queries in parallel; direct: run as-is. */
  action: "clarify" | "decompose" | "direct";
  /** The clarifying question to ask back (action "clarify"). */
  clarification?: string;
  /** Concrete options the user can pick from (action "clarify", G4.S3.T13). */
  options?: string[];
  /** Sub-queries to run in parallel (action "decompose"). */
  subQueries?: string[];
  /** Retriever the picker chose (G4.S3.T7.3). Default "hybrid". */
  retriever?: AgenticRetriever;
  /** Topic subtree to converge to (G4.S3.T7.4). Omit for whole-corpus (cross-domain). */
  topic?: string;
}

/** Result of the LLM relevance judgement (G4.S3.T7.6). */
export interface RelevanceJudgement {
  relevant: boolean;
  reason?: string;
}

/** Multi-hop graph walk plan produced by the LLM (G4.S3.T7.5). */
export interface MultiHopPlan {
  /** Follow-up graph-retriever queries to run (the discovered indirect associations). */
  followUps: string[];
  /** Human-readable trace of the walk, e.g. "ZOB → MVV". */
  trace: string;
}

/**
 * The LLM seam: every agentic decision is injectable so tests script it directly
 * and the production implementation (Pi/ModelRuntime) can be swapped in without
 * touching the orchestrator.
 */
export interface AgenticJudge {
  /** Query transformation + retriever picker + topic convergence in ONE plan step. */
  transformQuery(query: string, topics: string[]): Promise<QueryPlan>;
  /** Judge whether the retrieved KB hits answer the question (not-found handling). */
  judgeRelevance(query: string, hits: KnowledgeSearchResult[]): Promise<RelevanceJudgement>;
  /** Compression: distill the retrieved chunks into a concise answer (G4.S3.T7.2). */
  compress(query: string, hits: KnowledgeSearchResult[]): Promise<string>;
  /** Multi-hop graph reasoning: decide follow-up graph queries + a walk trace (G4.S3.T7.5). */
  multiHop(query: string, hits: KnowledgeSearchResult[], graph: KnowledgeGraph): Promise<MultiHopPlan>;
  /** Tell the user what knowledge the KB is missing vs the web result (G4.S3.T7.6). */
  suggestKbUpdate(query: string, kbHits: KnowledgeSearchResult[], webResults: WebSearchResult[]): Promise<string>;
}

/** The final answer of the agentic pipeline. */
export interface AgenticAnswer {
  query: string;
  /** The final (compressed / not-found / web-fallback) answer text. */
  answer: string;
  /** Fused KB hits that supported the answer. */
  hits: KnowledgeSearchResult[];
  /** True when the KB was judged not to answer the question (G4.S3.T7.6). */
  notFound: boolean;
  /** Web-search results used for the fallback (empty when none / no provider). */
  webResults: WebSearchResult[];
  /** What to add/update in the KB (set only when the web fallback ran). */
  kbUpdateSuggestion?: string;
  /**
   * G4.S3.T13: true when the plan chose `clarify` — a REAL question for the
   * user, not a final answer. `answer` holds the clarifying question text and
   * `clarificationOptions` the choices to offer. Callers must surface this as
   * a user follow-up (front-end clarification interaction) instead of showing
   * the plain text as the answer.
   */
  needsClarification?: boolean;
  /** Concrete options for the clarification (G4.S3.T13). Empty when the judge
   *  emitted none — the UI falls back to a free-text answer. */
  clarificationOptions?: string[];
}

export interface AgenticRetrievalServiceOptions {
  /** The underlying KB search (usually KnowledgeRetrievalService.search). */
  search: (query: string, options?: { topic?: string; retriever?: AgenticRetriever }) => Promise<KnowledgeSearchResponse>;
  /** Known topic subtrees (G4.S3.T4) for the picker to converge on. */
  topics?: () => Promise<string[]>;
  /** Entity-relation graph provider for multi-hop reasoning (G4.S3.T7.5). */
  graph?: () => Promise<KnowledgeGraph>;
  /** Optional LLM judge. When omitted, retrieval is non-agentic (S2 fallback). */
  judge?: AgenticJudge;
  /** Optional web-search provider for the not-found fallback (G4.S3.T7.6). */
  webSearch?: WebSearchProvider;
}

/** Fuse multiple search result lists, deduplicating by wikiPath/path/title. */
export function fuseHits(lists: KnowledgeSearchResult[][]): KnowledgeSearchResult[] {
  const seen = new Set<string>();
  const fused: KnowledgeSearchResult[] = [];
  for (const list of lists) {
    for (const hit of list) {
      const key = hit.wikiPath ?? hit.path ?? hit.title;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      fused.push(hit);
    }
  }
  return fused;
}

/** Join hits into a plain-text fallback answer (non-agentic path + empty-hit compression). */
export function plainAnswer(query: string, hits: KnowledgeSearchResult[]): string {
  if (hits.length === 0) {
    return `Not found in the knowledge base for "${query}".`;
  }
  return hits
    .map((h) => `- ${h.title}${h.snippet ? `: ${h.snippet}` : ""}`)
    .join("\n");
}

/**
 * Agentic RAG orchestrator. Runs the full pipeline:
 *   transform → (clarify | decompose/parallel | direct) → picker+topic → recall →
 *   multi-hop → relevance judge → (answer | not-found → web fallback + KB update suggestion) → compress.
 */
export class AgenticRetrievalService {
  private readonly search: AgenticRetrievalServiceOptions["search"];
  private readonly topics?: () => Promise<string[]>;
  private readonly graph?: () => Promise<KnowledgeGraph>;
  private readonly judge?: AgenticJudge;
  private readonly webSearch?: WebSearchProvider;

  constructor(options: AgenticRetrievalServiceOptions) {
    this.search = options.search;
    this.topics = options.topics;
    this.graph = options.graph;
    this.judge = options.judge;
    this.webSearch = options.webSearch;
  }

  /** Whether the pipeline is agentic (has an LLM judge) or plain S2 fallback. */
  get isAgentic(): boolean {
    return this.judge !== undefined;
  }

  async answer(query: string): Promise<AgenticAnswer> {
    if (!this.judge) {
      const response = await this.search(query);
      return {
        query,
        answer: plainAnswer(query, response.results),
        hits: response.results,
        notFound: false,
        webResults: [],
      };
    }

    const topics = this.topics ? await this.topics() : [];
    const plan = await this.judge.transformQuery(query, topics);

    if (plan.action === "clarify") {
      return {
        query,
        answer: plan.clarification ?? `Could you give more detail on "${query}"?`,
        hits: [],
        notFound: false,
        webResults: [],
        needsClarification: true,
        clarificationOptions: plan.options ?? [],
      };
    }

    const retriever = plan.retriever ?? "hybrid";
    const searchOptions = {
      ...(plan.topic ? { topic: plan.topic } : {}),
      ...(retriever !== "hybrid" ? { retriever } : {}),
    };

    // Decompose → run sub-queries in parallel and fuse; otherwise a single search.
    const queries = plan.action === "decompose" && plan.subQueries && plan.subQueries.length > 0
      ? plan.subQueries
      : [query];
    const responses = await Promise.all(queries.map((q) => this.search(q, searchOptions)));
    let hits = fuseHits(responses.map((r) => r.results));

    // Include any matching stored Q&A pair (G4.S3.T6) as a first-class hit so the
    // relevance judge and the compressor actually see it (previously qaReference
    // was dropped, so a saved answer like "what is CALEO" was never reused and the
    // agent fell back to web). It stays a reference hit — the RAG search still runs.
    const qaHits: KnowledgeSearchResult[] = responses
      .map((r) => r.qaReference)
      .filter((q): q is NonNullable<typeof q> => Boolean(q))
      .map((qa) => ({
        title: `QA: ${qa.question}`,
        snippet: qa.answer,
        source: "llmwiki" as const,
        path: `qa-pairs/${qa.id}`,
      }));
    if (qaHits.length > 0) {
      hits = fuseHits([qaHits, hits]);
    }

    // Multi-hop graph reasoning: let the LLM walk the Entity/Relation graph and
    // run its follow-up queries through the graph retriever, then fuse.
    if (this.graph) {
      try {
        const graph = await this.graph();
        const multiHop = await this.judge.multiHop(query, hits, graph);
        if (multiHop.followUps.length > 0) {
          const followUpResponses = await Promise.all(
            multiHop.followUps.map((fq) =>
              this.search(fq, {
                ...(plan.topic ? { topic: plan.topic } : {}),
                retriever: "graph",
              }),
            ),
          );
          hits = fuseHits([hits, ...followUpResponses.map((r) => r.results)]);
        }
      } catch {
        // multi-hop is best-effort — never fail the answer on a graph/provider error.
      }
    }

    const judgement = await this.judge.judgeRelevance(query, hits);

    if (!judgement.relevant) {
      const webResults = this.webSearch ? await this.webSearch.search(query) : [];
      const kbUpdateSuggestion =
        webResults.length > 0
          ? await this.judge.suggestKbUpdate(query, hits, webResults).catch(() => undefined)
          : undefined;
      const webNote =
        webResults.length > 0
          ? `\n\nFrom the web: ${webResults.map((w) => `${w.title} — ${w.snippet}`).join(" | ")}`
          : "";
      return {
        query,
        answer: `Not found in the knowledge base.${judgement.reason ? ` ${judgement.reason}` : ""}${webNote}`,
        hits,
        notFound: true,
        webResults,
        ...(kbUpdateSuggestion ? { kbUpdateSuggestion } : {}),
      };
    }

    const answer = await this.judge.compress(query, hits);
    return { query, answer, hits, notFound: false, webResults: [] };
  }
}
