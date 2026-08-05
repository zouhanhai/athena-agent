/**
 * Knowledge tools for Pi (G2.S3.T3) + Capability routing.
 *
 * Each Pi tool declares the capability requirement it needs (AnyOf/AllOf);
 * each knowledge source declares its capability surface. Pi (ReAct) routes by
 * user intent + tool descriptions + capability declarations (see
 * docs/knowledge-rag-design.md sections 3-5).
 */
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { LightRagClient } from "./lightrag.js";
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
  { id: "lightrag", name: "LightRAG", capabilities: ["vector", "graph"] },
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
  lightrag: Pick<LightRagClient, "query" | "getGraph">;
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
 * Build the 5 knowledge tools registered on Pi AgentSession:
 *   knowledge_search / query_graph (LightRAG), wiki_search / wiki_read_page / wiki_graph (llm_wiki).
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
      name: "knowledge_search",
      label: "Knowledge Search (LightRAG)",
      description:
        "Semantic search over raw document chunks (suitable for: specific facts, fuzzy semantics, material lookup). Requires vector or keyword capability (LightRAG).",
      promptGuidelines: [
        "Use for fact/semantic/material questions. Capability required: vector OR keyword (available from LightRAG).",
        "Prefer this over wiki_search when the user asks for a specific fact, fuzzy semantic match, or materials about a topic.",
      ],
      parameters: Type.Object({
        query: Type.String(),
        topK: Type.Optional(Type.Number()),
      }),
      requireCapability: { anyOf: ["vector", "keyword"] },
      sources: ["lightrag"],
      async execute(_toolCallId, params: { query: string; topK?: number }) {
        const result = await services.lightrag.query(params.query, {
          mode: "hybrid",
          topK: params.topK ?? 5,
          includeChunkContent: true,
        });
        const refs = (result.references ?? [])
          .map((r) => `- ${r.file_path}${r.content?.length ? `:\n  ${r.content.join("\n  ")}` : ""}`)
          .join("\n");
        return textResult(
          `Answer:\n${result.response}\n\nReferences:\n${refs || "(none)"}`,
        );
      },
    },
    {
      name: "query_graph",
      label: "Query Graph (LightRAG)",
      description:
        "Query the LightRAG entity-relation knowledge graph (suitable for: who relates to whom, dependency relationships). Requires vector or graph capability.",
      promptGuidelines: [
        "Use for entity relationships / dependencies. Capability required: vector OR graph (available from LightRAG).",
        "Use when the user asks which entities relate to X, dependencies, or connections between components.",
      ],
      parameters: Type.Object({
        label: Type.String(),
      }),
      requireCapability: { anyOf: ["vector", "graph"] },
      sources: ["lightrag"],
      async execute(_toolCallId, params: { label: string }) {
        const graph = await services.lightrag.getGraph(params.label, { maxDepth: 3, maxNodes: 1000 });
        const nodes = graph.nodes.map((n) => n.label ?? n.id).filter(Boolean);
        const edges = graph.edges.map(
          (e) => `${e.source} -> ${e.target}${e.weight !== undefined ? ` (${e.weight})` : ""}`,
        );
        return textResult(
          `Graph around "${params.label}":\nNodes (${nodes.length}): ${nodes.slice(0, 50).join(", ")}\nEdges (${edges.length}):\n${edges.slice(0, 50).join("\n") || "(none)"}`,
        );
      },
    },
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
    "- Specific facts / fuzzy semantics / materials -> knowledge_search (LightRAG)",
    "- Entity relationships / dependencies -> query_graph (LightRAG)",
    "- Page / topic links exploration -> wiki_graph (llm_wiki)",
    "- Cross-domain comparisons -> query multiple sources, then fuse the answers",
    "- Simple chit-chat -> answer directly without querying",
  ].join("\n");
}
