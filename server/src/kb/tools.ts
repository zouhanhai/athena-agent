/**
 * Knowledge tools for Pi (G2.S3.T3) + Capability routing.
 *
 * Each Pi tool declares the capability requirement it needs (AnyOf/AllOf);
 * each knowledge source declares its capability surface. Pi (ReAct) routes by
 * user intent + tool descriptions + capability declarations (see
 * docs/knowledge-rag-design.md sections 3-5).
 *
 * G4.S2.T10: the semantic knowledge tools (knowledge_search / query_graph) were
 * removed with their backend; llm_wiki remains the knowledge source.
 *
 * G4.S3.T7.6: `web_search` is the not-found fallback tool (the Pi SDK exposes
 * no built-in web search, so this wraps an injectable WebSearchProvider).
 */
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { LlmWikiClient } from "./llmwiki.js";
import type { AgenticRetrievalService, WebSearchProvider } from "./agentic-rag.js";

export type Capability = "vector" | "keyword" | "graph" | "wiki";

export interface CapabilityRequirement {
  /** Any one of these suffices. */
  anyOf?: Capability[];
  /** All of these must be present. */
  allOf?: Capability[];
}

export interface KnowledgeSource {
  id: string;
  name: string;
  capabilities: Capability[];
}

/** Declared capability surface of each knowledge source (design §3.1). */
export const KNOWLEDGE_SOURCES: readonly KnowledgeSource[] = [
  { id: "llmwiki", name: "llm_wiki", capabilities: ["wiki", "keyword", "graph"] },
];

/** Does a knowledge source satisfy a tool's capability requirement? */
export function sourceSatisfiesRequirement(
  source: KnowledgeSource,
  requirement: CapabilityRequirement,
): boolean {
  const caps = new Set(source.capabilities);
  const allOk = (requirement.allOf ?? []).every((c) => caps.has(c));
  const anyOk =
    (requirement.anyOf ?? []).length === 0 || (requirement.anyOf ?? []).some((c) => caps.has(c));
  return allOk && anyOk;
}

/** Which knowledge source(s) a tool routes to for a given requirement. */
export function routeRequirement(requirement: CapabilityRequirement): KnowledgeSource[] {
  return KNOWLEDGE_SOURCES.filter((source) => sourceSatisfiesRequirement(source, requirement));
}

export interface KnowledgeToolServices {
  llmwiki: Pick<LlmWikiClient, "search" | "readFile" | "getGraph" | "listProjects">;
  /** Explicit llm_wiki project id; otherwise resolved from listProjects(). */
  projectId?: string;
}

/** A knowledge ToolDefinition carrying its capability requirement (AnyOf/AllOf). */
export interface KnowledgeToolDefinition extends ToolDefinition {
  requireCapability: CapabilityRequirement;
  /** Knowledge source id(s) this tool targets. */
  sources: string[];
}

function textResult(text: string): Promise<AgentToolResult<unknown>> {
  return Promise.resolve({ content: [{ type: "text", text }], details: {} });
}

/**
 * Build the 3 wiki knowledge tools registered on Pi AgentSession:
 *   wiki_search / wiki_read_page / wiki_graph (llm_wiki).
 * G4.S2.T10: the semantic knowledge tools were removed with their backend.
 */
export function createKnowledgeTools(services: KnowledgeToolServices): KnowledgeToolDefinition[] {
  let resolvedProjectId: string | undefined;
  const getProjectId = async (): Promise<string> => {
    if (services.projectId) return services.projectId;
    if (resolvedProjectId) return resolvedProjectId;
    const { projects, currentProject } = await services.llmwiki.listProjects();
    resolvedProjectId = currentProject?.id ?? projects[0]?.id ?? "current";
    return resolvedProjectId;
  };

  const tools: KnowledgeToolDefinition[] = [
    {
      name: "wiki_search",
      label: "Wiki Search (llm_wiki)",
      description:
        "Search accumulated wiki pages (suitable for: processes, standards, concept definitions). Requires wiki capability (llm_wiki).",
      promptGuidelines: [
        "Use for process/standards/concept-definition questions. Capability required: wiki (available from llm_wiki).",
        "Prefer this over knowledge_search when the user asks what a process, standard, or concept says.",
      ],
      parameters: Type.Object({
        query: Type.String(),
        topK: Type.Optional(Type.Number()),
      }),
      requireCapability: { allOf: ["wiki"] },
      sources: ["llmwiki"],
      async execute(_toolCallId, params: { query: string; topK?: number }) {
        const projectId = await getProjectId();
        const search = await services.llmwiki.search(projectId, params.query, {
          topK: params.topK ?? 5,
          includeContent: true,
        });
        const rows = search.results.map(
          (r) => `- ${r.title} (${r.path}, score ${r.score})${r.snippet ? `\n  ${r.snippet}` : ""}`,
        );
        return textResult(
          `Wiki search results (mode: ${search.mode ?? "keyword"}):\n${rows.join("\n") || "(no results)"}`,
        );
      },
    },
    {
      name: "wiki_read_page",
      label: "Read Wiki Page (llm_wiki)",
      description:
        "Read the full content of a wiki page by path (use after wiki_search / wiki_graph to fetch a page). Requires wiki capability (llm_wiki).",
      promptGuidelines: [
        "Use to fetch the full content of a wiki page after finding its path via wiki_search or wiki_graph.",
      ],
      parameters: Type.Object({
        path: Type.String(),
      }),
      requireCapability: { allOf: ["wiki"] },
      sources: ["llmwiki"],
      async execute(_toolCallId, params: { path: string }) {
        const projectId = await getProjectId();
        const page = await services.llmwiki.readFile(projectId, params.path);
        return textResult(`# ${page.path}\n\n${page.content}`);
      },
    },
    {
      name: "wiki_graph",
      label: "Wiki Graph (llm_wiki)",
      description:
        "Traverse the llm_wiki wiki page wikilinks graph (suitable for: which pages link to a topic, knowledge exploration). Requires wiki + graph capability.",
      promptGuidelines: [
        "Use for page/topic link exploration. Capability required: wiki AND graph (available from llm_wiki).",
        "Use when the user asks which wiki pages link to a topic or wants to explore related pages.",
      ],
      parameters: Type.Object({
        q: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
      }),
      requireCapability: { allOf: ["wiki", "graph"] },
      sources: ["llmwiki"],
      async execute(_toolCallId, params: { q?: string; limit?: number }) {
        const projectId = await getProjectId();
        const graph = await services.llmwiki.getGraph(projectId, {
          q: params.q,
          limit: params.limit ?? 200,
        });
        const nodes = graph.nodes.map((n) => n.label);
        const edges = graph.edges.map((e) => `${e.source} -> ${e.target}`);
        return textResult(
          `Wiki graph${params.q ? ` around "${params.q}"` : ""}:\nNodes (${nodes.length}): ${nodes.slice(0, 50).join(", ")}\nEdges (${edges.length}):\n${edges.slice(0, 50).join("\n") || "(none)"}`,
        );
      },
    },
  ];

  return tools;
}

/** Capability declaration + routing section that can be appended to a Pi system prompt. */
export function buildCapabilitiesSystemSection(): string {
  const sources = KNOWLEDGE_SOURCES.map(
    (s) => `- ${s.name} (${s.id}): capabilities = [${s.capabilities.join(", ")}]`,
  ).join("\n");
  return [
    "# Knowledge Base Capabilities (Agentic RAG routing)",
    sources,
    "",
    "Route queries by intent:",
    "- Process / standards / concept definitions -> wiki_search (llm_wiki)",
    "- Page / topic links exploration -> wiki_graph (llm_wiki)",
    "- Simple chit-chat -> answer directly without querying",
  ].join("\n");
}

/**
 * `web_search` Pi tool (G4.S3.T7.6) — the not-found fallback + web comparison
 * source for agentic RAG. The Pi SDK exposes no built-in web search, so this is
 * a thin wrapper around an injectable WebSearchProvider. Returns up to `topK`
 * results as {title, url, snippet} lines for the LLM to answer from.
 */
export function createWebSearchTool(provider: WebSearchProvider): ToolDefinition {
  return {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the open web for the latest / external information when the knowledge base does not " +
      "contain the answer (or to compare against KB results).",
    promptGuidelines: [
      "Use when the KB returns nothing relevant or the user asks for up-to-date / external facts.",
      "The result is a list of {title, url, snippet} — answer from it and cite the urls.",
    ],
    parameters: Type.Object({
      query: Type.String(),
      topK: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params: { query: string; topK?: number }, _signal?, _onUpdate?, _ctx?) {
      const results = await provider.search(params.query).then((r) => (params.topK ? r.slice(0, params.topK) : r));
      if (results.length === 0) {
        return textResult("(no web results)");
      }
      const rows = results.map((r) => `- ${r.title} (${r.url})\n  ${r.snippet}`);
      return textResult(`Web search results:\n${rows.join("\n")}`);
    },
  };
}

/**
 * `search_knowledge` Pi tool (G4.S3.T7) — the agentic RAG retrieval tool (the
 * retrieval-side of the KB-as-MCP `search_knowledge(query, topic?)` contract,
 * G4.S6). Runs the full AgenticRetrievalService pipeline (query transform /
 * retriever picker + topic convergence / multi-hop / compression / not-found →
 * web fallback + KB-update suggestion) and returns the final answer. Optional
 * `topic` scopes the search to a topic subtree.
 *
 * G4.S3.T13: when the agentic plan chooses `clarify`, the result carries a
 * structured `details.clarification = { question, options, query }` block AND a
 * `CLARIFICATION_REQUESTED` text marker. This is a REAL question for the user,
 * not a final answer — the agent must surface it as a clarification follow-up
 * (the chat route relays it to the front-end chat) and re-run the query with
 * the user's chosen context.
 */
export function createSearchKnowledgeTool(service: AgenticRetrievalService): ToolDefinition {
  return {
    name: "search_knowledge",
    label: "Search Knowledge (Agentic RAG)",
    description:
      "Answer from the Athena knowledge base with agentic RAG: query transformation, the best " +
      "retriever picker, topic convergence, multi-hop graph reasoning and compression. When the KB " +
      "does not answer, says so explicitly and falls back to web search with a KB-update suggestion.",
    promptGuidelines: [
      "Use for knowledge-base questions that need retrieval + synthesis (processes, standards, concepts, entity relations).",
      "Corpus-level questions (themes/topics spanning MANY documents, e.g. 'what events does CALEO organize?') → pass scope=\"global\" to search over community summaries; leave scope unset for ordinary per-document questions.",
      "When the answer says 'not found in the knowledge base', read the web-fallback + KB-update suggestion and follow up.",
      "If the result is a CLARIFICATION_REQUESTED, do NOT answer yet — the user must pick one of the options (or type an answer); re-run search_knowledge with the original question plus the user's choice once they reply.",
    ],
    parameters: Type.Object({
      query: Type.String(),
      topic: Type.Optional(Type.String()),
      scope: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("global")])),
    }),
    async execute(
      _toolCallId,
      params: { query: string; topic?: string; scope?: "local" | "global" },
      _signal?,
      _onUpdate?,
      _ctx?,
    ) {
      const answer = await service.answer(params.query, {
        ...(params.scope ? { scope: params.scope } : {}),
      });
      if (answer.needsClarification) {
        const clarification = {
          question: answer.answer,
          options: answer.clarificationOptions ?? [],
          query: params.query,
        };
        const marker = `CLARIFICATION_REQUESTED\nquestion: ${clarification.question}\noptions: ${clarification.options.join(" | ")}`;
        return {
          content: [
            {
              type: "text" as const,
              text: `${marker}\n\nThis is a clarification request for the user — NOT a final answer. ` +
                `The chat UI shows these options to the user; when the user answers, re-run the query ` +
                `"${clarification.query}" with the chosen context.`,
            },
          ],
          details: { clarification },
        };
      }
      const parts = [`Answer: ${answer.answer}`];
      if (answer.notFound && answer.kbUpdateSuggestion) {
        parts.push(`KB update suggestion: ${answer.kbUpdateSuggestion}`);
      }
      if (answer.webResults.length > 0) {
        parts.push(`Web sources:\n${answer.webResults.map((w) => `- ${w.title} (${w.url})`).join("\n")}`);
      }
      if (answer.hits.length > 0) {
        parts.push(`KB sources:\n${answer.hits.map((h) => `- ${h.title}${h.path ? ` (${h.path})` : ""}`).join("\n")}`);
      }
      return textResult(parts.join("\n\n"));
    },
  };
}
