import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DuckDuckGoWebSearchProvider,
  parseDuckDuckGoHtml,
  type WebSearchResult,
} from "../../src/kb/web-search.js";

test("parseDuckDuckGoHtml extracts title / url / snippet triples from result blocks", () => {
  const html = `<!DOCTYPE html><html><body>
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdeepseek-v4">DeepSeek-V4 specs</a>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdeepseek-v4">A concise description of DeepSeek V4.</a>
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fmodel">Model card</a>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fmodel">Benchmarks for the model.</a>
  </body></html>`;
  const results = parseDuckDuckGoHtml(html);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    title: "DeepSeek-V4 specs",
    url: "https://example.com/deepseek-v4",
    snippet: "A concise description of DeepSeek V4.",
  });
  assert.equal(results[1]!.url, "https://example.org/model");
});

test("parseDuckDuckGoHtml ignores blocks without a snippet (unmatched url)", () => {
  const html = `<html><body>
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2Fx">Only title</a>
  </body></html>`;
  assert.deepEqual(parseDuckDuckGoHtml(html), []);
});

test("DuckDuckGoWebSearchProvider searches via the injected fetch and decodes results", async () => {
  const html = `<!DOCTYPE html><html><body>
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Frag">What is agentic RAG?</a>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Frag">Agentic RAG adds an LLM to the retrieval loop.</a>
  </body></html>`;
  let requested = "";
  const provider = new DuckDuckGoWebSearchProvider({
    fetchImpl: async (url: string | URL | Request) => {
      requested = String(url);
      return {
        ok: true,
        async text() {
          return html;
        },
      } as Response;
    },
  });
  const results: WebSearchResult[] = await provider.search("agentic rag");
  assert.ok(requested.includes("q=agentic%20rag"), "query is URL-encoded into the search request");
  assert.equal(results.length, 1);
  assert.equal(results[0]!.title, "What is agentic RAG?");
  assert.equal(results[0]!.url, "https://example.com/rag");
});

test("DuckDuckGoWebSearchProvider returns [] on a failed fetch (best-effort)", async () => {
  const provider = new DuckDuckGoWebSearchProvider({
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  assert.deepEqual(await provider.search("anything"), []);
});
