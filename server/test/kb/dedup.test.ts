import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMarkdown,
  sha256Hex,
  hashChunks,
  compareChunkHashes,
  ContentDedupStore,
} from "../../src/kb/dedup.js";

test("normalizeMarkdown strips format artifacts so identical content hashes equal", () => {
  // PDF-style headings (##) vs DOCX-style bold headings (**) must both become plain text.
  const pdf = "## Introduction\n\nThis is **bold** text with an inline `code`.";
  const docx = "**Introduction**\n\nThis is bold text with an inline code.";
  assert.equal(normalizeMarkdown(pdf), normalizeMarkdown(docx));
});

test("normalizeMarkdown strips comments and image placeholders", () => {
  const withExtras = "## Heading\n\nBody <!-- comment --> with a ![logo](logo.png).";
  const plain = "Heading\n\nBody with a.";
  assert.equal(normalizeMarkdown(withExtras), normalizeMarkdown(plain));
});

test("normalizeMarkdown strips YAML frontmatter and collapses whitespace/lowercase", () => {
  const withFrontmatter = "---\ntype: concept\ntitle: Foo\n---\n\n# Heading\nBody  text.";
  const body = "# Heading\n\nBody text.";
  assert.equal(normalizeMarkdown(withFrontmatter), normalizeMarkdown(body));
  assert.ok(normalizeMarkdown("Hello   World").startsWith("hello world"));
});

test("normalizeMarkdown strips links/headings/list markers/table pipes/code", () => {
  const raw = [
    "1. First",
    "- bullet",
    "| a | b |",
    "[label](https://example.com)",
    "`code`",
  ].join("\n");
  const normalized = normalizeMarkdown(raw);
  assert.ok(!normalized.includes("|"));
  assert.ok(!normalized.includes("`"));
  assert.ok(!normalized.includes("example.com"));
  assert.ok(normalized.includes("label"));
  assert.ok(normalized.includes("first"));
  assert.ok(normalized.includes("bullet"));
});

test("sha256Hex is deterministic and differs for different text", () => {
  assert.equal(sha256Hex("a"), sha256Hex("a"));
  assert.notEqual(sha256Hex("a"), sha256Hex("b"));
});

test("hashChunks splits long normalized text into multiple chunk hashes", () => {
  const longText = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
  const chunks = hashChunks(longText, 20);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]!.length, 64);
});

test("compareChunkHashes matches identical sequences and rejects different ones", () => {
  const a = ["h1", "h2", "h3"];
  assert.ok(compareChunkHashes(a, ["h1", "h2", "h3"]));
  assert.ok(!compareChunkHashes(a, ["h1", "h2"]));
  assert.ok(!compareChunkHashes(a, ["h1", "h2", "h4"]));
});

test("ContentDedupStore detects an exact duplicate seeded from existing pages", async () => {
  const store = new ContentDedupStore({
    loadExisting: async () => [
      { path: "wiki/sommerseminar/sommerseminar-l-sen.md", content: "# Sommerseminar\n\nAgenda for the seminar." },
    ],
  });
  const result = await store.check("# Sommerseminar\n\nAgenda for the seminar.");
  assert.deepEqual(result, {
    duplicate: true,
    method: "hash",
    existingSource: "wiki/sommerseminar/sommerseminar-l-sen.md",
  });
});

test("ContentDedupStore matches identical content across different markdown renderings", async () => {
  const store = new ContentDedupStore({
    loadExisting: async () => [
      { path: "a.pdf.md", content: "## Heading\n\nSome **content**." },
    ],
  });
  const result = await store.check("**Heading**\n\nSome content.");
  assert.equal(result.duplicate, true);
  assert.equal(result.method, "hash");
});

test("ContentDedupStore does not flag distinct content", async () => {
  const store = new ContentDedupStore({
    loadExisting: async () => [
      { path: "a.md", content: "First document" },
    ],
  });
  const result = await store.check("Completely different document");
  assert.deepEqual(result, { duplicate: false });
});

test("ContentDedupStore detects long-doc duplicates and indexes per-chunk hashes", async () => {
  const longA = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
  const store = new ContentDedupStore({
    loadExisting: async () => [{ path: "long.md", content: longA }],
    chunkWords: 20,
  });

  // Identical long content is flagged as a duplicate.
  const result = await store.check(longA);
  assert.equal(result.duplicate, true);

  // Long docs are split into multiple chunk hashes and indexed (size reflects
  // the seeded doc, and the chunk sequence is comparable).
  const chunks = hashChunks(normalizeMarkdown(longA), 20);
  assert.ok(chunks.length > 1);
  assert.equal(compareChunkHashes(chunks, chunks), true);
  assert.equal(store.size(), 1);
});

test("ContentDedupStore records new content and detects it on the next check", async () => {
  const store = new ContentDedupStore({ loadExisting: async () => [] });
  const first = await store.check("# Brand new\nContent here.");
  assert.equal(first.duplicate, false);

  await store.record("# Brand new\nContent here.", "fresh.md");

  const second = await store.check("# Brand new\nContent here.");
  assert.equal(second.duplicate, true);
  assert.equal(second.existingSource, "fresh.md");
});

test("ContentDedupStore seeds only once and record() is idempotent", async () => {
  let loads = 0;
  const store = new ContentDedupStore({
    loadExisting: async () => {
      loads += 1;
      return [];
    },
  });
  await store.check("a");
  await store.check("b");
  await store.record("c", "c.md");
  await store.record("c", "c.md");
  assert.equal(loads, 1);
  assert.equal(store.size(), 1);
});
