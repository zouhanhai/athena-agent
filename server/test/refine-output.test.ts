import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RefinedDocument } from "../src/agents/refine-document.js";
import {
  HEADER_RELEVEL_BATCH_SIZE,
  REFINE_SINGLE_READ_MAX_BYTES,
  applyPatches,
  batchHeaderBlocks,
  deriveStem,
  isLargeMarkdown,
  mergeRefinements,
  previewMarkdown,
  rebuildMarkdown,
  splitByHeaders,
  splitByRefinedH1,
  splitParagraphSemantic,
  storeRefinementOutput,
  type RefineOutputRef,
  type HeaderBlock,
} from "../src/agents/refine-output.js";

function refinedSection(heading: string, body: string): RefinedDocument {
  return {
    markdown: `# ${heading}\n\n${body}`,
    summary: `Summary of ${heading}.`,
    sections: [{ title: heading, summary: `Section summary of ${heading}.` }],
    frontmatter: { type: "document", topic: "t" },
    chunks: [{ id: "c1", text: body, heading_path: heading }],
    entities: [],
    relations: [],
    keywords: [],
    quality: { complete: true, confidence: 0.8, issues: [], action: "auto_accept" },
  };
}

test("isLargeMarkdown routes >1MB md to two-stage and sub-1MB to single", () => {
  const small = "# Doc\n\n" + "body line\n".repeat(100);
  assert.equal(isLargeMarkdown(small), false);
  // exactly at the threshold is NOT large (strictly greater)
  const atThreshold = "x".repeat(REFINE_SINGLE_READ_MAX_BYTES);
  assert.equal(isLargeMarkdown(atThreshold), false);
  const overThreshold = `${atThreshold}y`;
  assert.equal(isLargeMarkdown(overThreshold), true);
});

test("splitByHeaders returns preamble + heading blocks with level/text/body", () => {
  const md = "Intro line.\n\n# Sommerseminar\n\nWelcome.\n\n## Workshops\n\nDetails.\n\n## Talks\n\nMore.";
  const { preamble, blocks } = splitByHeaders(md);
  assert.equal(preamble, "Intro line.");
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[0], {
    index: 0,
    level: 1,
    text: "Sommerseminar",
    heading: "# Sommerseminar",
    body: "Welcome.",
  });
  assert.equal(blocks[1].level, 2);
  assert.equal(blocks[1].text, "Workshops");
  assert.equal(blocks[1].body, "Details.");
  assert.equal(blocks[2].text, "Talks");
  assert.equal(blocks[2].body, "More.");
});

test("batchHeaderBlocks batches headers ~30-50 per group (default 40)", () => {
  const blocks: HeaderBlock[] = Array.from({ length: 90 }, (_, i) => ({
    index: i,
    level: 2,
    text: `H${i}`,
    heading: `## H${i}`,
    body: "",
  }));
  const batches = batchHeaderBlocks(blocks);
  assert.equal(batches.length, 3);
  assert.equal(batches[0].length, 40);
  assert.equal(batches[0][0].index, 0);
  assert.equal(batches[1].length, 40);
  assert.equal(batches[1][0].index, 40);
  assert.equal(batches[2].length, 10);
  assert.equal(batches[2][0].index, 80);
  assert.equal(batches[2][0].index + batches[2].length, 90);
  assert.ok(HEADER_RELEVEL_BATCH_SIZE >= 30 && HEADER_RELEVEL_BATCH_SIZE <= 50);
});

test("rebuildMarkdown applies corrected header levels", () => {
  const md = "# T\n\na\n\n## A\n\nb\n\n## B\n\nc";
  const { preamble, blocks } = splitByHeaders(md);
  const releveled = blocks.map((b, i) => (i === 1 ? { ...b, level: 1 } : b));
  const rebuilt = rebuildMarkdown(preamble, releveled);
  assert.equal(rebuilt, "# T\n\na\n\n# A\n\nb\n\n## B\n\nc");
});

test("splitByRefinedH1 splits at h1 boundaries into sections with heading_path", () => {
  const md = "# Title\n\nintro\n\n# A\n\naa\n\n# B\n\nbb\n\n## B1\n\nsub";
  const sections = splitByRefinedH1(md);
  assert.equal(sections.length, 3);
  assert.equal(sections[0].heading_path, "Title");
  assert.equal(sections[1].heading_path, "A");
  assert.equal(sections[2].heading_path, "B");
  assert.equal(sections[1].markdown, "# A\n\naa");
  assert.match(sections[2].markdown, /## B1/);
});

test("splitByRefinedH1 falls back to h2 boundaries when the doc has no h1", () => {
  const md = "## A\n\na\n\n## B\n\nb";
  const sections = splitByRefinedH1(md);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].heading_path, "A");
  assert.equal(sections[1].heading_path, "B");
});

test("previewMarkdown returns a short preview (big-output: only preview in context)", () => {
  const md = "# T\n\n" + "body text line\n".repeat(60);
  const preview = previewMarkdown(md, 200);
  assert.equal(preview.length, 200);
  assert.ok(preview.endsWith("…"));
  assert.ok(preview.startsWith("# T"));
  // a short doc is returned verbatim without an ellipsis
  assert.equal(previewMarkdown("# T", 200), "# T");
});

test("deriveStem slugs the first h1 heading", () => {
  assert.equal(deriveStem("# Group Reporting (SAP)\n\nbody"), "group-reporting-sap");
  assert.equal(deriveStem("## No h1\n\nbody"), "document");
});

test("storeRefinementOutput writes markdown.md + chunks.json and returns the small ref", async () => {
  const dir = await mkdtemp(join(tmpdir(), "refine-output-"));
  try {
    const doc: RefinedDocument = {
      markdown: "# Sommerseminar\n\n## Workshops\n\n" + "details\n".repeat(400),
      summary: "CALEO's annual Sommerseminar.",
      sections: [{ title: "Sommerseminar", summary: "The annual CALEO event." }],
      frontmatter: { type: "event", topic: "internal/events" },
      chunks: [{ id: "c1", text: "details", heading_path: "Sommerseminar / Workshops" }],
      entities: [{ name: "CALEO", type: "org", description: "An organization" }],
      relations: [],
      keywords: ["sommerseminar"],
      quality: { complete: true, confidence: 0.85, issues: [], action: "auto_accept" },
    };
    const ref = await storeRefinementOutput(doc, dir, {
      stem: "sommerseminar",
      mode: "two-stage",
      section_paths: ["Workshops"],
    });
    const mdPath = join(dir, "sommerseminar", "markdown.md");
    const chunksPath = join(dir, "sommerseminar", "chunks.json");

    assert.equal(ref.md_ref, mdPath);
    assert.equal(ref.chunks_ref, chunksPath);
    assert.ok(ref.preview.startsWith("# Sommerseminar"));
    assert.notEqual(ref.preview, doc.markdown, "preview is truncated, not the full doc");
    assert.equal(ref.char_count, doc.markdown.length);
    assert.equal(ref.line_count, doc.markdown.split("\n").length);
    assert.equal(ref.header_count, 2);
    assert.equal(ref.chunk_count, 1);
    assert.deepEqual(ref.frontmatter, { type: "event", topic: "internal/events" });
    assert.deepEqual(ref.entities, doc.entities);
    assert.deepEqual(ref.keywords, ["sommerseminar"]);
    assert.deepEqual(ref.quality, doc.quality);
    assert.equal(ref.summary, "CALEO's annual Sommerseminar.", "ref carries the document summary");
    assert.deepEqual(ref.sections, [{ title: "Sommerseminar", summary: "The annual CALEO event." }]);
    assert.equal(ref.mode, "two-stage");
    assert.deepEqual(ref.section_paths, ["Workshops"]);

    assert.equal(await readFile(mdPath, "utf8"), doc.markdown);
    assert.deepEqual(JSON.parse(await readFile(chunksPath, "utf8")), doc.chunks);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("storeRefinementOutput writes the File B RAG working copy only when it differs (G4.S1.T6)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "refine-output-rag-"));
  try {
    const fileAPrime = "# Doc\n\n![Image](images/x.png)\n\nThe image displays a bright sky.\n\nbody";
    const fileB = "# Doc\n\nThe image displays a bright sky.\n\nbody";
    const doc: RefinedDocument = {
      markdown: fileAPrime,
      summary: "A doc with an image ref.",
      frontmatter: { type: "event", topic: "internal/events" },
      chunks: [{ id: "c1", text: "body", heading_path: "Doc" }],
      entities: [],
      relations: [],
      keywords: [],
      quality: { complete: true, confidence: 0.85, issues: [], action: "auto_accept" },
    };
    const stem = "doc";

    // File B differs from File A′ (image refs stripped) → a separate rag.md is written
    const separate = await storeRefinementOutput(doc, dir, { stem, ragMarkdown: fileB });
    const ragPath = join(dir, stem, "rag.md");
    assert.equal(separate.rag_md_ref, ragPath);
    assert.notEqual(separate.rag_md_ref, separate.md_ref);
    assert.equal(await readFile(ragPath, "utf8"), fileB);

    // File B equals the durable markdown → rag_md_ref falls back to md_ref, no rag.md
    const same = await storeRefinementOutput(doc, dir, { stem: "doc-same", ragMarkdown: fileAPrime });
    assert.equal(same.rag_md_ref, same.md_ref);
    assert.equal(existsSync(join(dir, "doc-same", "rag.md")), false, "no separate rag.md when File B is identical");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mergeRefinements concats markdown/chunks, dedupes entities/relations/keywords, aggregates quality", () => {
  const a: RefinedDocument = {
    markdown: "# A\n\naa",
    summary: "Section A summary.",
    sections: [{ title: "A", summary: "A summary." }],
    frontmatter: { type: "event", topic: "t" },
    chunks: [{ id: "c1", text: "aa", heading_path: "A" }],
    entities: [
      { name: "CALEO", type: "org", description: "org" },
      { name: "caleo", type: "org", description: "dup variant" },
    ],
    relations: [{ source: "CALEO", target: "X", keywords: ["hosts"], description: "d" }],
    keywords: ["cal", "leo"],
    quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
  };
  const b: RefinedDocument = {
    markdown: "# B\n\nbb",
    summary: "",
    sections: [{ title: "A", summary: "" }, { title: "B", summary: "B summary." }],
    frontmatter: { type: "event", topic: "t" },
    chunks: [{ id: "c1", text: "bb", heading_path: "B" }],
    entities: [{ name: "CALEO", type: "org", description: "org" }],
    relations: [{ source: "CALEO", target: "X", keywords: ["hosts"], description: "d" }],
    keywords: ["cal"],
    quality: { complete: false, confidence: 0.5, issues: ["table split"], action: "review_required" },
  };

  const m = mergeRefinements([a, b]);
  assert.equal(m.markdown, "# A\n\naa\n\n# B\n\nbb");
  assert.deepEqual(m.chunks, [
    { id: "c1", text: "aa", heading_path: "A" },
    { id: "c2", text: "bb", heading_path: "B" },
  ]);
  // entities deduped case-insensitively, first canonical name wins
  assert.deepEqual(m.entities, [{ name: "CALEO", type: "org", description: "org" }]);
  assert.deepEqual(m.relations, [{ source: "CALEO", target: "X", keywords: ["hosts"], description: "d" }]);
  assert.deepEqual(m.keywords, ["cal", "leo"]);
  assert.equal(m.quality.complete, false);
  assert.equal(m.quality.confidence, 0.7);
  assert.deepEqual(m.quality.issues, ["table split"]);
  assert.equal(m.quality.action, "review_required");
  assert.equal(m.summary, "Section A summary.", "first non-empty section summary kept on merge");
  // section summaries merged by title, non-empty wins over empty dup
  assert.deepEqual(m.sections, [
    { title: "A", summary: "A summary." },
    { title: "B", summary: "B summary." },
  ]);
});

// --- G4.S8.T1: local markdown rebuild (applyPatches) + local paragraph-semantic chunking ---

const PATCH_GRID_MD = `# Title

Intro paragraph.

## Section A

Body A paragraph.

## Section B

Body B paragraph.`;

test("applyPatches refactor_heading retitles/re-levels a heading block by index", () => {
  const md = applyPatches(PATCH_GRID_MD, [{ op: "refactor_heading", index: 2, level: 3 }]);
  assert.match(md, /^### Section A$/m, "block index 2 (heading 'Section A') re-leveled to h3");
  assert.match(md, /^# Title$/m, "title heading unchanged");
  assert.match(md, /^## Section B$/m, "other headings unchanged");
  assert.match(md, /Body A paragraph\./, "body preserved verbatim");

  const retitle = applyPatches(PATCH_GRID_MD, [{ op: "retitle_heading", index: 4, text: "Section C" }]);
  assert.match(retitle, /^## Section C$/m, "heading text replaced by index");
});

test("applyPatches replaces/inserts/deletes paragraph blocks by index", () => {
  // index 1 = "Intro paragraph."
  const replaced = applyPatches(PATCH_GRID_MD, [{ op: "replace_paragraph", index: 1, text: "Updated intro." }]);
  assert.match(replaced, /\n\nUpdated intro\.\n\n/);
  assert.ok(!replaced.includes("Intro paragraph."), "old paragraph gone");

  const inserted = applyPatches(PATCH_GRID_MD, [{ op: "insert_paragraph", index: 3, text: "Inserted para." }]);
  assert.match(inserted, /Body A paragraph\.\n\nInserted para\.\n\n## Section B/);

  const deleted = applyPatches(PATCH_GRID_MD, [{ op: "delete_paragraph", index: 3 }]);
  assert.ok(!deleted.includes("Body A paragraph."), "deleted paragraph gone");
  assert.match(deleted, /## Section A\n\n## Section B/);
});

test("applyPatches ignores a patch whose index is out of range or targets the wrong block kind", () => {
  const noop = applyPatches(PATCH_GRID_MD, [
    { op: "refactor_heading", index: 999, level: 3 },
    { op: "replace_paragraph", index: 0, text: "nope" }, // index 0 is a heading, not a paragraph
  ]);
  assert.equal(noop, applyPatches(PATCH_GRID_MD, []), "no-op patches leave the markdown unchanged");
});

test("splitParagraphSemantic emits c1..cN with heading_path and preserves content fidelity", () => {
  const md = `# Title

## A

Alpha paragraph one.

Alpha paragraph two.

## B

Beta paragraph.`;
  const chunks = splitParagraphSemantic(md);
  // G4.S8.T16 min-size merge: the two short alpha paragraphs share a heading path and merge
  // into ONE chunk; beta is the final block of its section (exempt) and stays its own chunk.
  assert.deepEqual(chunks.map((c) => c.id), ["c1", "c2"], "stable sequential ids");
  assert.deepEqual(chunks.map((c) => c.heading_path), ["Title / A", "Title / B"]);
  assert.match(chunks[0]!.text, /^Alpha paragraph one\.\n\nAlpha paragraph two\.$/, "consecutive small blocks merged under one heading path");
  assert.ok(joinedIncludes(chunks, "Alpha paragraph one."));
  assert.ok(joinedIncludes(chunks, "Alpha paragraph two."));
  assert.ok(joinedIncludes(chunks, "Beta paragraph."));
});

function joinedIncludes(chunks: Array<{ text: string }>, fragment: string): boolean {
  return chunks.some((c) => c.text.includes(fragment));
}

test("splitParagraphSemantic keeps one chunk per oversized paragraph (paragraph-semantic block count)", () => {
  // Each paragraph exceeds the ~1200-token target, so each paragraph is its own semantic chunk.
  const big = "x".repeat(6000); // ~1500 tokens
  const md = `# Report\n\n## Part A\n\n${big}\n\n## Part B\n\n${big}\n\n## Part C\n\n${big}`;
  const chunks = splitParagraphSemantic(md);
  assert.equal(chunks.length, 3, "chunk count == paragraph-semantic block count");
  assert.deepEqual(chunks.map((c) => c.id), ["c1", "c2", "c3"]);
  assert.deepEqual(chunks.map((c) => c.heading_path), ["Report / Part A", "Report / Part B", "Report / Part C"]);
  for (const c of chunks) assert.equal(c.text, big, "paragraph text preserved verbatim in its chunk");
});

test("storeRefinementOutput ref carries small metadata only (no full markdown/chunks)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "refine-output-"));
  try {
    const doc: RefinedDocument = {
      ...refinedSection("Big", "x".repeat(50_000) + "ENDMARKER-7f3a"),
      chunks: Array.from({ length: 40 }, (_, i) => ({
        id: `c${i}`,
        text: "chunk body " + "y".repeat(500),
        heading_path: "Big",
      })),
    };
    const ref: RefineOutputRef = await storeRefinementOutput(doc, dir, { stem: "big" });
    const serialized = JSON.stringify(ref);
    assert.ok(serialized.length < 4000, "ref must stay small in context");
    assert.ok(!serialized.includes("ENDMARKER-7f3a"), "the far tail of the markdown is NOT in the returned ref");
    assert.ok(!serialized.includes("chunk body"), "chunk texts NOT in the returned ref");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
