/**
 * Web search provider (G4.S3.T7.6) — the not-found fallback for agentic RAG.
 *
 * NOTE: the Pi SDK (pi-web-access package) already exposes a `web_search` tool
 * on the Athena chat agent — verified via `agent.session.getAllTools()`. This
 * module provides the SERVER-side WebSearchProvider used by the agentic RAG
 * fallback pipeline (AgenticRetrievalService.webSearch). The default
 * implementation queries DuckDuckGo's HTML endpoint (no API key required) and
 * parses the classic `result__a` / `result__snippet` blocks. The fetch function
 * is injectable so tests run offline and a different search provider can be
 * swapped in.
 */
import type { WebSearchProvider, WebSearchResult } from "./agentic-rag.js";

export type { WebSearchResult };

/** Parse the classic DuckDuckGo HTML search-results page. */
export function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  // Each result block is split at 'class="result__a"', so the block starts
  // mid-tag: ' href="//duckduckgo.com/l/?uddg=<encoded>">title</a> ... snippet'.
  const blocks = html.split('class="result__a"').slice(1);
  for (const block of blocks) {
    const href = /href="([^"]*)"/.exec(block)?.[1] ?? "";
    const title = />\s*([\s\S]*?)\s*<\/a>/.exec(block)?.[1] ?? "";
    const snippetMatch = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    const snippet = snippetMatch?.[1] ?? "";
    if (!title.trim() || !snippet.trim()) continue;
    const url = decodeDdgUrl(href);
    if (!url) continue;
    results.push({
      title: stripHtml(title).trim(),
      url,
      snippet: stripHtml(snippet).trim(),
    });
  }
  return results;
}

/** Decode a DuckDuckGo redirect URL (//duckduckgo.com/l/?uddg=<encoded>). */
function decodeDdgUrl(href: string): string | undefined {
  const match = /[?&]uddg=([^&]+)/.exec(href);
  if (!match) return undefined;
  try {
    const decoded = decodeURIComponent(match[1]!);
    return /^https?:\/\//.test(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** Strip HTML tags + entities from a title/snippet fragment. */
function stripHtml(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

export interface DuckDuckGoWebSearchOptions {
  /** Base search endpoint. Default: https://html.duckduckgo.com/html/ */
  baseUrl?: string;
  /** Injectable fetch (tests). Default: global fetch. */
  fetchImpl?: typeof fetch;
  /** Max results per query. Default: 5. */
  topK?: number;
}

/** DuckDuckGo HTML search provider — a thin keyless web search wrapper. */
export class DuckDuckGoWebSearchProvider implements WebSearchProvider {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly topK: number;

  constructor(options: DuckDuckGoWebSearchOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://html.duckduckgo.com/html/";
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.topK = options.topK ?? 5;
  }

  async search(query: string): Promise<WebSearchResult[]> {
    const url = `${this.baseUrl}?q=${encodeURIComponent(query)}`;
    try {
      const response = await this.fetchImpl(url, {
        headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36" },
      });
      if (!response.ok) return [];
      const html = await response.text();
      return parseDuckDuckGoHtml(html).slice(0, this.topK);
    } catch {
      return [];
    }
  }
}
