import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPageInjection,
  findPageContext,
  injectPageContext,
  PAGE_CONTEXTS,
} from "../src/agents/page-context.js";

test("page-context: registers Uploads, Workbench, Wiki and Knowledge pages", () => {
  const pages = PAGE_CONTEXTS.map((p) => p.page);
  for (const expected of ["/uploads", "/workbench", "/wiki", "/knowledge"]) {
    assert.ok(pages.includes(expected), `should register ${expected}`);
  }
});

test("page-context: Workbench injects GitHub capabilities", () => {
  const ctx = findPageContext("/workbench");
  assert.ok(ctx, "should find a context for /workbench");
  const injection = buildPageInjection("/workbench");
  assert.match(injection, /GitHub/, "should mention GitHub");
  assert.match(injection, /repo/i, "should mention repos");
  assert.match(injection, /PR/i, "should mention pull requests");
  assert.match(injection, /issue/i, "should mention issues");
});

test("page-context: Knowledge and Wiki inject knowledge tools", () => {
  for (const page of ["/knowledge", "/wiki"]) {
    const injection = buildPageInjection(page);
    assert.match(injection, /knowledge_search/, `${page} should list knowledge_search`);
    assert.match(injection, /wiki_search/, `${page} should list wiki_search`);
    assert.match(injection, /LightRAG/, `${page} should mention LightRAG`);
    assert.match(injection, /llm_wiki/i, `${page} should mention llm_wiki`);
  }
});

test("page-context: Uploads injects ingest capabilities", () => {
  const injection = buildPageInjection("/uploads");
  assert.match(injection, /ingest/i, "should mention ingest");
  assert.match(injection, /docling/i, "should mention docling parsing");
  assert.match(injection, /LightRAG/i, "should mention LightRAG indexing");
});

test("page-context: unknown page has no context and no injection", () => {
  assert.equal(findPageContext("/register"), undefined);
  assert.equal(buildPageInjection("/register"), "");
  assert.equal(injectPageContext("/register", "hello"), "hello");
});

test("page-context: empty/undefined page is not injected", () => {
  assert.equal(buildPageInjection(""), "");
  assert.equal(buildPageInjection(undefined), "");
  assert.equal(injectPageContext(undefined, "hi"), "hi");
});

test("page-context: nested workbench paths match the workbench context", () => {
  assert.equal(findPageContext("/workbench/issues")?.page, "/workbench");
  assert.equal(findPageContext("/workbench/code")?.page, "/workbench");
});

test("page-context: injectPageContext prepends context and preserves the message", () => {
  const out = injectPageContext("/knowledge", "summarize the RAG design doc");
  assert.ok(out.endsWith("summarize the RAG design doc"), "message text should be preserved");
  assert.ok(out.includes("Knowledge"), "injection should name the page");
});

test("page-context: page labels are readable", () => {
  assert.equal(findPageContext("/workbench")?.label, "Workbench");
  assert.equal(findPageContext("/uploads")?.label, "Uploads");
});
