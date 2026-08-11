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
 */
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { LlmWikiClient } from "./llmwiki.js";

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
