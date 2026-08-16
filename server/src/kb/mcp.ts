/**
 * KB-as-MCP server (G4.S7.T3).
 *
 * Exposes the company knowledge base as 5 MCP tools so ANY external agent
 * (OpenCode/Claude Code/Codex/Hermes) can retrieve it over the platform's
 * public URL (Cloudflare Tunnel, athenakb.com) with a single `mcpServers`
 * entry. The server is a thin transport-agnostic wrapper around
 * `KnowledgeRetrievalService`; the Fastify Streamable HTTP route lives in
 * `routes/kb-mcp.ts`.
 *
 * TOPIC-SCOPED SEARCH CONTRACT (search_knowledge):
 * - `topic` is a wiki frontmatter TOPIC SUBTREE (dir path with `/`), e.g.
 *   `sap`, `sap/group_reporting`, `internal/events`. Call `get_kb_topics()`
 *   for the authoritative list of valid values.
 * - The client agent's LLM decides the relevant domain(s) from the question
 *   (Athena's knowledge-navigation: determine topic → converge document
 *   domain → search within it). Omit/empty `topic` = whole-corpus search.
 * - Alias handling applies AT QUERY TIME within the scoped topic: the
 *   semantic-mapping table (G4.S3.T6, colloquial term → canonical, e.g.
 *   "C-Day" → "CALEO Day") expands the query, and the bilingual alias lookup
 *   (G4.S2, entity DE/EN variant names in the Neo4j store) is part of the
 *   fused retrieval — both scoped to the topic subtree sent to the store.
 * - Every hit carries `wikiPath`/`sectionPath` so a client can group chunks
 *   by source page and fuse analysis.
 *
 * NOT here: `answer()` (AgenticRAG full Q&A) — deferred to M6 (A2A).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { KnowledgeRetrievalService } from "./retrieval.js";

export const KB_MCP_SERVER_NAME = "athena-kb";
export const KB_MCP_SERVER_VERSION = "1.0.0";

export interface KbMcpServerOptions {
  retrieval: KnowledgeRetrievalService;
}

/** Serialize a tool payload as a text content block so any MCP client (LLM or
 *  code) can read it as JSON. */
function textResult(payload: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(err: unknown): { content: [{ type: "text"; text: string }]; isError: true } {
  return {
    content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
    isError: true,
  };
}

/** Build the KB MCP server wrapping `retrieval` into the 5 retrieval tools. */
export function buildKbMcpServer(options: KbMcpServerOptions): McpServer {
  const { retrieval } = options;
  const server = new McpServer(
    { name: KB_MCP_SERVER_NAME, version: KB_MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.tool(
    "search_knowledge",
    [
      "Search the company knowledge base and return fused retrieval results",
      "(semantic vector + BM25 keyword + knowledge-graph + topic, across the RAG store",
      "and the llm_wiki keyword index).",
      "Every result carries wikiPath + sectionPath so you can group chunks by source page.",
      "",
      "TOPIC CONTRACT: topic is a wiki-frontmatter TOPIC SUBTREE (a / separated path).",
      "Call get_kb_topics() to list the valid values instead of guessing. If the question",
      "is about a specific domain, pass its topic subtree (e.g. 'sap/group_reporting') to scope",
      "the search; otherwise leave topic empty for a whole-corpus search. Decide the topic",
      "from the question first (determine topic → converge document domain → search).",
      "Company aliases (colloquial term → canonical) and bilingual DE/EN entity variants",
      "are applied to your query automatically within the scoped topic.",
    ].join("\n"),
    {
      query: z
        .string()
        .min(1)
        .describe("The natural-language question to search the KB for (no topic → whole corpus)."),
      topic: z
        .string()
        .optional()
        .describe(
          "Wiki frontmatter topic subtree to scope the search to, e.g. 'sap' or 'sap/group_reporting'. Omit/empty for a whole-corpus search. See get_kb_topics() for valid values.",
        ),
    },
    async ({ query, topic }) => {
      try {
        const response = await retrieval.search(
          query,
          topic && topic.trim().length > 0 ? { topic: topic.trim() } : {},
        );
        return textResult(response);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "get_wiki_page",
    [
      "Read the full markdown of a single wiki page (frontmatter + body) by its wiki path",
      "e.g. 'wiki/sap/group_reporting/overview.md' — exactly the wikiPath carried by a",
      "search_knowledge hit, or a page path from get_wiki_tree().",
      "Returns { path, content } where content is the raw markdown (frontmatter included).",
      "Use this to read a page in full after search_knowledge points you at it.",
    ].join("\n"),
    {
      path: z
        .string()
        .min(1)
        .describe(
          "Wiki page path (like a search result wikiPath or a get_wiki_tree() page path), e.g. 'wiki/sap/group_reporting/overview.md'.",
        ),
    },
    async ({ path }) => {
      try {
        return textResult(await retrieval.readWikiPage(path));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "get_graph",
    [
      "Return the knowledge-graph nodes and edges (entities + relations extracted from the KB)",,
      "e.g. organizations, systems, people and how they relate ({ type, description } per node).",
      "Use this to see entity neighborhoods and to compose multi-hop analyses before or",
      "alongside search_knowledge.",
    ].join("\n"),
    {},
    async () => {
      try {
        return textResult(await retrieval.getGraph());
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "get_kb_topics",
    [
      "List every wiki topic subtree present in the knowledge base — the authoritative set of",
      "VALID values for the search_knowledge topic parameter (e.g. 'sap', 'sap/group_reporting',",
      "'internal/events'). Call this first (or to discover which domains the KB covers)",
      "instead of guessing a topic for search_knowledge.",
    ].join("\n"),
    {},
    async () => {
      try {
        return textResult({ topics: await retrieval.getGraphTopics() });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "get_wiki_tree",
    [
      "Return the wiki page tree (folders + pages with per-page frontmatter type and topic",
      "metadata) so you can browse the wiki's structure and navigation.",
      "Each page node carries name, path, isDir, and (when present) type + topic.",
    ].join("\n"),
    {},
    async () => {
      try {
        return textResult(await retrieval.getWikiTree());
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}