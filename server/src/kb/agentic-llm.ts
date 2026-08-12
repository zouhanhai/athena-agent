/**
 * Pi/ModelRuntime-backed AgenticJudge (G4.S3.T7) — the production LLM seam for
 * the agentic RAG pipeline. Each decision (query transform / relevance judge /
 * multi-hop / compression / KB-update) is a single constrained `completeSimple`
 * call with an emit tool whose JSON schema IS the output contract — the model
 * cannot drift into free-text JSON (same pattern as refine-document.ts).
 *
 * The judge is fully injectable: tests drive it with a fake ModelRuntime that
 * returns canned emit tool calls; the orchestrator (agentic-rag.ts) only sees
 * the `AgenticJudge` interface.
 */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import type {
  AgenticJudge,
  MultiHopPlan,
  QueryPlan,
  RelevanceJudgement,
  WebSearchResult,
} from "./agentic-rag.js";
import type { KnowledgeGraph, KnowledgeSearchResult } from "./retrieval.js";

/** Name of the constrained emit tool for the query-transformation plan. */
export const EMIT_AGENTIC_PLAN_TOOL = "emit_agentic_plan";
/** Emit tool for the relevance judgement. */
export const EMIT_AGENTIC_JUDGEMENT_TOOL = "emit_agentic_judgement";
/** Emit tool for the multi-hop graph walk. */
export const EMIT_AGENTIC_MULTIHOP_TOOL = "emit_agentic_multihop";
/** Emit tool for the compressed answer. */
export const EMIT_AGENTIC_ANSWER_TOOL = "emit_agentic_answer";
/** Emit tool for the KB-update suggestion. */
export const EMIT_AGENTIC_UPDATE_TOOL = "emit_agentic_update";

/** Default provider/model for the judge (same dedicated Athena channel as refinement). */
export const AGENTIC_PROVIDER = "athena";
export const AGENTIC_MODEL = "~deepseek/deepseek-v4-flash-latest";

const PLAN_SCHEMA = Type.Object({
  action: Type.Union([Type.Literal("clarify"), Type.Literal("decompose"), Type.Literal("direct")]),
  clarification: Type.Optional(Type.String()),
  options: Type.Optional(Type.Array(Type.String())),
  subQueries: Type.Optional(Type.Array(Type.String())),
  retriever: Type.Optional(Type.Union([
    Type.Literal("vector"),
    Type.Literal("bm25"),
    Type.Literal("graph"),
    Type.Literal("hybrid"),
  ])),
  topic: Type.Optional(Type.String()),
});

const JUDGEMENT_SCHEMA = Type.Object({
  relevant: Type.Boolean(),
  reason: Type.Optional(Type.String()),
});

const MULTIHOP_SCHEMA = Type.Object({
  followUps: Type.Array(Type.String()),
  trace: Type.String(),
});

const ANSWER_SCHEMA = Type.Object({
  answer: Type.String(),
});

const UPDATE_SCHEMA = Type.Object({
  suggestion: Type.String(),
});

interface AssistantTextPart {
  type: "text";
  text: string;
}

interface AssistantToolCallPart {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
}

export interface AssistantMessageLike {
  role: string;
  content: (AssistantTextPart | AssistantToolCallPart | { type: string })[];
}

/** Extract the emit-tool call args (or a plain-text JSON object) for a tool name. */
function extractEmitArgs(message: AssistantMessageLike, toolName: string): unknown | undefined {
  for (const part of message.content ?? []) {
    if (
      part.type === "toolCall" &&
      "name" in part &&
      (part as AssistantToolCallPart).name === toolName &&
      "arguments" in part
    ) {
      return (part as AssistantToolCallPart).arguments;
    }
  }
  const text = (message.content ?? [])
    .filter((part): part is AssistantTextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Lenient object coercion of a raw parsed payload. */
function asRecord(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw === "string") {
    try {
      return asRecord(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : undefined;
}

/** Parse the query-transformation plan from a constrained emit response. */
export function extractPlan(message: AssistantMessageLike): QueryPlan {
  const raw = asRecord(extractEmitArgs(message, EMIT_AGENTIC_PLAN_TOOL));
  const action = raw?.action;
  if (action !== "clarify" && action !== "decompose" && action !== "direct") {
    return { action: "direct" };
  }
  const plan: QueryPlan = { action };
  if (typeof raw?.clarification === "string" && raw.clarification.trim()) {
    plan.clarification = raw.clarification.trim();
  }
  const options = asStringArray(raw?.options);
  if (options && options.length > 0) plan.options = options;
  const subQueries = asStringArray(raw?.subQueries);
  if (subQueries && subQueries.length > 0) plan.subQueries = subQueries;
  const retriever = raw?.retriever;
  if (retriever === "vector" || retriever === "bm25" || retriever === "graph" || retriever === "hybrid") {
    plan.retriever = retriever;
  }
  if (typeof raw?.topic === "string" && raw.topic.trim()) {
    plan.topic = raw.topic.trim();
  }
  return plan;
}

/** Parse the relevance judgement from a constrained emit response. */
export function extractJudgement(message: AssistantMessageLike): RelevanceJudgement {
  const raw = asRecord(extractEmitArgs(message, EMIT_AGENTIC_JUDGEMENT_TOOL));
  const judgement: RelevanceJudgement = { relevant: raw?.relevant === true };
  if (typeof raw?.reason === "string" && raw.reason.trim()) {
    judgement.reason = raw.reason.trim();
  }
  return judgement;
}

/** Parse the multi-hop walk plan from a constrained emit response. */
export function extractMultiHop(message: AssistantMessageLike): MultiHopPlan {
  const raw = asRecord(extractEmitArgs(message, EMIT_AGENTIC_MULTIHOP_TOOL));
  return {
    followUps: asStringArray(raw?.followUps) ?? [],
    trace: typeof raw?.trace === "string" ? raw.trace : "",
  };
}

/** Parse the compressed answer text from a constrained emit response. */
export function extractCompression(message: AssistantMessageLike): string {
  const raw = asRecord(extractEmitArgs(message, EMIT_AGENTIC_ANSWER_TOOL));
  return typeof raw?.answer === "string" ? raw.answer.trim() : "";
}

/** Parse the KB-update suggestion text from a constrained emit response. */
export function extractUpdate(message: AssistantMessageLike): string {
  const raw = asRecord(extractEmitArgs(message, EMIT_AGENTIC_UPDATE_TOOL));
  return typeof raw?.suggestion === "string" ? raw.suggestion.trim() : "";
}

/** Build a constrained emit tool (structural shape for completeSimple's tools array). */
function emitTool(name: string, description: string, schema: TSchema) {
  return {
    name,
    description,
    parameters: schema,
    constrainedSampling: { type: "json_schema" as const, strict: "require" as const },
  };
}

export interface AgenticJudgeOptions {
  providerId?: string;
  modelId?: string;
}

/** System prompt for the query-transformation + retriever-picker + topic-convergence plan. */
export const AGENTIC_PLAN_SYSTEM_PROMPT = `You plan a knowledge-base query for the Athena agentic RAG pipeline.
Given the user question and the known topic subtrees, decide:
- "clarify": ONLY when the question has NO extractable subject or object — nothing to look up in the
  knowledge base, e.g. "help me with something", "what should I do about this". Give ONE clarifying
  question (clarification) and 2-4 concrete options the user can pick from.
- "decompose": the question has distinct facets — split it into sub-queries run in parallel.
- "direct": search the question as-is.

IMPORTANT — definitional / entity questions are NEVER "clarify":
"What is X", "who is X", "what is caleo", "what is RAG", "define X", "what is the X department" — even
when X could match a person, a company, a product, a concept, etc. A user asking "what is X" is BY
DEFINITION unfamiliar with X and cannot answer a clarifying question. Choose "direct" and search the
knowledge base as-is. If X is ambiguous, answer with the most-likely interpretation and optionally note
the ambiguity alongside the answer — never ask the user to disambiguate. A stored Q&A pair (e.g. qa_pairs
"what is CALEO?") is reused automatically when one matches the question.

Also pick the retriever (vector | bm25 | graph | hybrid) that best fits the question, and the topic
subtree to converge to (topic convergence: determine topic -> converge document domain -> search within
it). OMIT the topic for whole-corpus when the question is cross-domain or ambiguous.
Emit the plan via the emit_agentic_plan tool.`;

/** System prompt for the relevance judge (not-found handling, G4.S3.T7.6). */
export const AGENTIC_JUDGEMENT_SYSTEM_PROMPT = `You judge whether the retrieved knowledge-base hits actually answer the user
question. Be strict: if the hits are off-topic / empty / do not contain the answer, mark relevant=false
with a short reason. This drives the not-found -> web-search fallback, so do NOT fabricate an answer.
Emit via the emit_agentic_judgement tool.`;

/** System prompt for multi-hop graph reasoning (G4.S3.T7.5). */
export const AGENTIC_MULTIHOP_SYSTEM_PROMPT = `You walk the entity-relation graph to discover INDIRECT associations a single-hop
retriever misses. Given the user question, the current hits and the graph, decide follow-up
graph-retriever queries (entity names / short phrases) that would surface those indirect associations,
and a short human-readable trace (e.g. "ZOB -> MVV"). Emit via the emit_agentic_multihop tool.`;

/** System prompt for compression (G4.S3.T7.2). */
export const AGENTIC_ANSWER_SYSTEM_PROMPT = `You are Athena. Distill the retrieved knowledge-base chunks into a CONCISE answer to
the user question. Control token use: a few sentences + the key facts, no noise, no invented detail.
Emit the answer text via the emit_agentic_answer tool.`;

/** System prompt for the KB-update suggestion (G4.S3.T7.6). */
export const AGENTIC_UPDATE_SYSTEM_PROMPT = `Compare the knowledge-base hits against the web-search results for the same question.
Tell the user WHAT knowledge the KB is missing / should be added or updated (e.g. upload the doc,
the topic domain). One concise sentence. Emit via the emit_agentic_update tool.`;

function hitBlock(hit: KnowledgeSearchResult): string {
  return `- [${hit.source}] ${hit.title}${hit.path ? ` (${hit.path})` : ""}: ${hit.snippet ?? ""}`;
}

function hitsBlock(hits: KnowledgeSearchResult[]): string {
  return hits.length > 0 ? hits.map(hitBlock).join("\n") : "(no KB hits)";
}

function graphBlock(graph: KnowledgeGraph): string {
  const nodes = graph.nodes.map((n) => n.label).join(", ");
  const edges = graph.edges.map((e) => `${e.source} -> ${e.target}`).join(", ");
  return `Nodes: ${nodes || "(none)"}\nEdges: ${edges || "(none)"}`;
}

/**
 * Production AgenticJudge backed by the Pi ModelRuntime channel. Every decision
 * is a constrained emit-tool call; a malformed response degrades gracefully to a
 * safe default (direct plan / relevant=false / empty suggestion) — never a crash.
 */
export function createAgenticJudge(
  modelRuntime: ModelRuntime,
  options: AgenticJudgeOptions = {},
): AgenticJudge {
  const providerId = options.providerId ?? AGENTIC_PROVIDER;
  const modelId = options.modelId ?? AGENTIC_MODEL;

  async function emit(
    tool: ReturnType<typeof emitTool>,
    systemPrompt: string,
    userContent: string,
  ): Promise<AssistantMessageLike | undefined> {
    const model = modelRuntime.getModel(providerId, modelId);
    if (!model) return undefined;
    try {
      const assistant = await modelRuntime.completeSimple(
        model,
        {
          systemPrompt,
          messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
          tools: [tool],
        },
        { reasoning: "low" },
      );
      return assistant as unknown as AssistantMessageLike;
    } catch {
      return undefined;
    }
  }

  return {
    async transformQuery(query, topics) {
      const message = await emit(
        emitTool(EMIT_AGENTIC_PLAN_TOOL, "Emit the query plan (action, retriever, topic).", PLAN_SCHEMA),
        AGENTIC_PLAN_SYSTEM_PROMPT,
        `User question:\n${query}\n\nKnown topic subtrees:\n${topics.length > 0 ? topics.join("\n") : "(none — whole corpus)"}`,
      );
      return message ? extractPlan(message) : { action: "direct" };
    },
    async judgeRelevance(query, hits) {
      const message = await emit(
        emitTool(EMIT_AGENTIC_JUDGEMENT_TOOL, "Emit relevant: true/false + a short reason.", JUDGEMENT_SCHEMA),
        AGENTIC_JUDGEMENT_SYSTEM_PROMPT,
        `User question:\n${query}\n\nKB hits:\n${hitsBlock(hits)}`,
      );
      return message ? extractJudgement(message) : { relevant: false };
    },
    async multiHop(query, hits, graph) {
      const message = await emit(
        emitTool(EMIT_AGENTIC_MULTIHOP_TOOL, "Emit follow-up graph queries + a trace.", MULTIHOP_SCHEMA),
        AGENTIC_MULTIHOP_SYSTEM_PROMPT,
        `User question:\n${query}\n\nCurrent hits:\n${hitsBlock(hits)}\n\nEntity-relation graph:\n${graphBlock(graph)}`,
      );
      return message ? extractMultiHop(message) : { followUps: [], trace: "" };
    },
    async compress(query, hits) {
      const message = await emit(
        emitTool(EMIT_AGENTIC_ANSWER_TOOL, "Emit the concise answer text.", ANSWER_SCHEMA),
        AGENTIC_ANSWER_SYSTEM_PROMPT,
        `User question:\n${query}\n\nRetrieved chunks:\n${hitsBlock(hits)}`,
      );
      const answer = message ? extractCompression(message) : "";
      return answer || hits.map((h) => `- ${h.title}: ${h.snippet}`).join("\n");
    },
    async suggestKbUpdate(_query, _kbHits, webResults: WebSearchResult[]) {
      const message = await emit(
        emitTool(EMIT_AGENTIC_UPDATE_TOOL, "Emit the KB-update suggestion.", UPDATE_SCHEMA),
        AGENTIC_UPDATE_SYSTEM_PROMPT,
        `Web results:\n${webResults.map((w) => `- ${w.title} (${w.url}): ${w.snippet}`).join("\n")}`,
      );
      const suggestion = message ? extractUpdate(message) : "";
      return suggestion || "the knowledge base is missing this information — consider uploading the relevant document.";
    },
  };
}
