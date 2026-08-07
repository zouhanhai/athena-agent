/**
 * Page-aware context injection (G3.S3.T2, g3-requirements §4.3, Vercel-inspired).
 *
 * The global Chat panel keeps ONE shared conversation across all pages, but the
 * agent's context is page-aware: when the user is on a page, the relevant agent
 * capabilities for that page are injected into the prompt (rather than always
 * injecting everything). Switching tabs keeps the conversation context intact —
 * only this dynamic capability overlay changes with the current page.
 *
 *   Uploads page   → ingest capabilities (docling / LightRAG / llm_wiki)
 *   Workbench page → GitHub capabilities (repo tree / PR / issue / mutate)
 *   Wiki / Knowledge → knowledge tools (knowledge_search / wiki_* / LightRAG)
 */

export interface PageCapability {
  name: string;
  description: string;
}

export interface PageContext {
  /** Route path this context is keyed by (also matches nested paths below it). */
  page: string;
  /** Human-readable page name (used in the injected block and the UI badge). */
  label: string;
  /** Capabilities relevant to this page — injected so the agent answers with context-appropriate tooling. */
  capabilities: PageCapability[];
}

const KNOWLEDGE_CAPABILITIES: PageCapability[] = [
  {
    name: "knowledge_search",
    description: "Semantic search over raw document chunks (LightRAG vector/graph).",
  },
  {
    name: "query_graph",
    description: "Query the LightRAG entity-relation knowledge graph.",
  },
  {
    name: "wiki_search",
    description: "Search accumulated wiki pages (llm_wiki).",
  },
  {
    name: "wiki_read_page",
    description: "Read the full content of a wiki page by path (llm_wiki).",
  },
  {
    name: "wiki_graph",
    description: "Traverse the llm_wiki page wikilinks graph.",
  },
];

export const PAGE_CONTEXTS: readonly PageContext[] = [
  {
    page: "/knowledge",
    label: "Knowledge",
    capabilities: KNOWLEDGE_CAPABILITIES,
  },
  {
    page: "/wiki",
    label: "Wiki",
    capabilities: KNOWLEDGE_CAPABILITIES,
  },
  {
    page: "/workbench",
    label: "Workbench",
    capabilities: [
      {
        name: "GitHub browse",
        description: "Repo tree, code view with line numbers and syntax highlighting, branch selector.",
      },
      {
        name: "GitHub issues",
        description: "GitHub-style issue list scoped to the signed-in user's credential.",
      },
      {
        name: "Kanban",
        description: "Kanban board for the workbench.",
      },
      {
        name: "GitHub mutate",
        description: "Open PRs, edit files, merge — scoped to the signed-in user's credential.",
      },
    ],
  },
  {
    page: "/uploads",
    label: "Uploads",
    capabilities: [
      {
        name: "docling ingest",
        description: "Parse uploaded documents with docling.",
      },
      {
        name: "LightRAG ingest",
        description: "Index parsed chunks into the LightRAG vector/graph knowledge base.",
      },
      {
        name: "llm_wiki ingest",
        description: "Write accumulated knowledge into the llm_wiki knowledge base.",
      },
    ],
  },
];

/** Normalize a route path for matching (lowercase, no trailing slash). */
function normalizePage(page: string): string {
  let p = page.trim().toLowerCase();
  while (p.endsWith("/") && p.length > 1) {
    p = p.slice(0, -1);
  }
  return p;
}

/**
 * Find the page context for a route path. Matches the exact path or any nested
 * path below it (e.g. `/workbench/issues` → the `/workbench` context).
 */
export function findPageContext(page: string | undefined): PageContext | undefined {
  if (!page) return undefined;
  const normalized = normalizePage(page);
  return PAGE_CONTEXTS.find((ctx) => {
    if (normalized === ctx.page) return true;
    return normalized.startsWith(`${ctx.page}/`);
  });
}

function renderCapabilities(capabilities: PageCapability[]): string {
  return capabilities
    .map((c) => `- ${c.name}: ${c.description}`)
    .join("\n");
}

/**
 * Build the injected context block for a page, or "" when the page has no
 * registered context (no injection for unknown pages).
 */
export function buildPageInjection(page: string | undefined): string {
  const ctx = findPageContext(page);
  if (!ctx) return "";
  return [
    `[Current page: ${ctx.label}]`,
    `You are working on the ${ctx.label} page. The following agent capabilities are relevant here and available to you:`,
    renderCapabilities(ctx.capabilities),
    "Prefer these capabilities when they fit the user's request.",
  ].join("\n");
}

/**
 * Inject the current page's agent capabilities into a chat message. The message
 * is returned unchanged when the page has no registered context, so the shared
 * conversation context is never polluted for unknown pages.
 */
export function injectPageContext(page: string | undefined, message: string): string {
  const injection = buildPageInjection(page);
  return injection ? `${injection}\n\n${message}` : message;
}
