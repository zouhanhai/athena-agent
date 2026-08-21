import { test } from "node:test";
import assert from "node:assert/strict";
import type { RefinementPatch } from "../src/agents/refine-document.js";
import {
  REFINE_MIN_CHUNK_CHARS,
  applyPatches,
  applyPatchesWithReport,
  isFlatHeaderMarkdown,
  splitParagraphSemantic,
  stripImageRefs,
} from "../src/agents/refine-output.js";
import { buildRefinedDocument } from "../src/agents/refine-document.js";

/**
 * G4.S8.T16 — refine hardening: header-patch instrumentation + heading-text
 * anchoring (Mallorca repro), minimum-size chunk merging, HTML-comment
 * placeholder stripping, and zero-LLM contextual enrichment.
 */

// --- Mallorca fixture: docling emitted a FLAT hierarchy (16 × h2) ---

const MALLORCA_HEADINGS = [
  "CALEO Sommerseminar 2023",
  "Wednesday — Arrival",
  "Airport Transfer",
  "Hotel Check-in",
  "Thursday — Workshops",
  "Workshop AI Basics",
  "Workshop Consolidation",
  "Workshop Analytics",
  "Friday — Excursion",
  "Boat Tour",
  "Winery Visit",
  "Saturday — Departure",
  "Checkout",
  "Shuttle Times",
  "Contacts",
  "Impressions",
];

function mallorcaMarkdown(): string {
  return MALLORCA_HEADINGS.map((h) => `## ${h}\n\nBody text of ${h}.`).join("\n\n");
}

/**
 * What the LLM ACTUALLY emits in the wild: correct heading texts but ORDINALS
 * counted over headings only (not the interleaved paragraph grid) — exactly the
 * misnumbered-patch shape applyPatches used to silently drop.
 */
function mallorcaMisnumberedPatches(): RefinementPatch[] {
  // grid: h2 at even indices 0..30 (16 headings, 16 paragraphs)
  const wantLevel = (text: string): number | null => {
    if (text.startsWith("CALEO")) return 1;
    if (/^Wednesday|^Thursday|^Friday|^Saturday/.test(text)) return 2;
    if (/^Workshop|^Airport Transfer|^Hotel Check-in$|^Boat Tour|^Winery Visit$|^Checkout$|^Shuttle Times$|^Contacts$|^Impressions$/.test(text)) return 3;
    return null;
  };
  const patches: RefinementPatch[] = [];
  MALLORCA_HEADINGS.forEach((text, headingOrdinal) => {
    const level = wantLevel(text);
    if (level === null || level === 2) return;
    // WRONG index: the heading ordinal (0-based over HEADINGS), not the block-grid index
    patches.push({ op: "refactor_heading", index: headingOrdinal, level, anchor: text });
  });
  return patches;
}

test("applyPatchesWithReport reports {patchesEmitted, patchesApplied, patchesDropped:[{index,reason}]}", () => {
  const md = "# T\n\nintro\n\n## A\n\nbody A";
  const { markdown, report } = applyPatchesWithReport(md, [
    { op: "refactor_heading", index: 2, level: 3 }, // valid: block 2 IS the "## A" heading
    { op: "refactor_heading", index: 999, level: 1 }, // out of range
    { op: "replace_paragraph", index: 0, text: "nope" }, // kind mismatch (heading, not paragraph)
  ]);
  assert.match(markdown, /^### A$/m);
  assert.equal(report.emitted, 3);
  assert.equal(report.applied, 1);
  assert.deepEqual(
    report.dropped.map((d) => ({ index: d.index, reason: d.reason })),
    [
      { index: 999, reason: "out_of_range" },
      { index: 0, reason: "kind_mismatch" },
    ],
  );
});

test("Mallorca repro: flat 16 × h2 + misnumbered ordinals + anchors → hierarchical output, zero silent drops", () => {
  const patches = mallorcaMisnumberedPatches();
  const { markdown, report } = applyPatchesWithReport(mallorcaMarkdown(), patches);

  // Every patch resolved via its heading-text ANCHOR despite wrong ordinal indices.
  assert.equal(report.dropped.length, 0, `no patch silently dropped: ${JSON.stringify(report.dropped)}`);
  assert.equal(report.applied, report.emitted);

  // Hierarchical output: exactly one h1, four day h2s, sub-sections h3.
  const levels = [...markdown.matchAll(/^(#{1,6}) /gm)].map((m) => m[1]!.length);
  assert.equal(levels.filter((l) => l === 1).length, 1, "one title");
  assert.ok(levels.filter((l) => l === 2).length >= 4, "day sections at h2");
  assert.ok(levels.filter((l) => l === 3).length >= 8, "sub-sections demoted to h3");
  assert.match(markdown, /^# CALEO Sommerseminar 2023$/m);
  assert.match(markdown, /^### Workshop AI Basics$/m);
});

test("heading-text anchoring survives block-count drift (paragraphs inserted between headings)", () => {
  const drifted =
    "# T\n\nNEW preamble para.\n\n## A\n\npara one\n\npara two\n\n## B\n\nbody B";
  const { markdown, report } = applyPatchesWithReport(drifted, [
    // grid index 3 points at "para one"; only the ANCHOR locates the "## B" heading reliably
    { op: "refactor_heading", index: 3, level: 3, anchor: "B" } as RefinementPatch & { anchor?: string },
  ]);
  assert.match(markdown, /^### B$/m);
  assert.equal(report.dropped.length, 0);
});

test("unresolvable heading patch (wrong index AND unknown anchor) is reported as dropped with reason", () => {
  const { report } = applyPatchesWithReport("# T\n\n## A\n\nbody", [
    { op: "refactor_heading", index: 42, level: 3, anchor: "Does Not Exist" } as RefinementPatch & { anchor?: string },
  ]);
  assert.equal(report.applied, 0);
  assert.equal(report.dropped[0]!.reason, "unresolved");
});

test("isFlatHeaderMarkdown detects the Mallorca shape (>3 same-level headings, ≤1 outlier)", () => {
  assert.equal(isFlatHeaderMarkdown(mallorcaMarkdown()), true, "16 × h2 is flat");
  assert.equal(isFlatHeaderMarkdown("# T\n\n## A\n\n## B"), false, "<4 headings never flat");
  assert.equal(isFlatHeaderMarkdown("# T\n\n## A\n\n### A1\n\n## B\n\n### B1"), false, "varied hierarchy is not flat");
  assert.equal(isFlatHeaderMarkdown("no headings at all"), false);
});

test("splitParagraphSemantic merges consecutive small blocks under one heading path up to REFINE_MIN_CHUNK_CHARS", () => {
  assert.ok(REFINE_MIN_CHUNK_CHARS >= 400, "default minimum is 400 chars");

  const small = "Short sentence."; // 15 chars
  const md = `# Doc\n\n## Section\n\n${Array.from({ length: 40 }, () => small).join("\n\n")}`;
  const chunks = splitParagraphSemantic(md);

  assert.ok(chunks.length <= 2, `forty tiny paragraphs collapse to ≤2 chunks (got ${chunks.length})`);
  assert.ok(chunks[0]!.text.length >= REFINE_MIN_CHUNK_CHARS, "merged chunk reaches the minimum size");
  for (const c of chunks) {
    assert.equal(c.heading_path, "Doc / Section");
    assert.ok(c.text.includes("Short sentence."), "no fragment lost by the merge");
  }
  const last = chunks[chunks.length - 1]!;
  const totalChars = chunks.reduce((n, c) => n + c.text.replace(/\n+/g, "").length, 0);
  assert.ok(totalChars >= 40 * small.length - 4 * (chunks.length - 1), "all paragraph text preserved across merged groups");
  void last;
});

test("min-size merge: oversized blocks stay intact; final block may stay below the minimum", () => {
  const big = "x".repeat(2000); // > 400 → stays its own chunk
  const md = `# Doc\n\n## S\n\n${big}\n\ntiny tail`;
  const chunks = splitParagraphSemantic(md);
  assert.deepEqual(chunks.map((c) => c.text), [big, "tiny tail"], "oversized intact; final short block exempt");
});

test("min-size merge never crosses a heading boundary (merge only within the same heading path)", () => {
  const md = "# Doc\n\n## A\n\nalpha one\n\nalpha two\n\n## B\n\nbeta one";
  const chunks = splitParagraphSemantic(md);
  assert.deepEqual(chunks.map((c) => c.heading_path), ["Doc / A", "Doc / B"]);
  assert.match(chunks[0]!.text, /^alpha one/);
  assert.match(chunks[0]!.text, /alpha two$/);
});

test("REFINE_MIN_CHUNK_CHARS env override is honored", () => {
  process.env.REFINE_MIN_CHUNK_CHARS = "10";
  try {
    const chunks = splitParagraphSemantic("# Doc\n\nshort\n\nalso short");
    assert.equal(chunks.length, 1, "with min=10 the two blocks still merge (>= threshold reached)");
    const bigEnough = "y".repeat(12);
    const two = splitParagraphSemantic(`# Doc\n\n${bigEnough}\n\nzz`);
    assert.equal(two.length, 2, "first block already ≥ env threshold → stays alone; final exempt");
  } finally {
    delete process.env.REFINE_MIN_CHUNK_CHARS;
  }
});

test("stripImageRefs ALSO removes <!-- image --> HTML-comment placeholders (the File B leak)", () => {
  const md = [
    "# Doc",
    "",
    "<!-- image -->",
    "",
    "![Image](images/image_1.jpeg)",
    "",
    "The image displays a bright sky.",
    "",
    "text <!-- image --> more", // inline placeholder too
  ].join("\n");
  const stripped = stripImageRefs(md);
  assert.ok(!stripped.includes("<!-- image -->"), "HTML-comment placeholder removed");
  assert.ok(!stripped.includes("![Image]"), "image ref line removed");
  assert.ok(stripped.includes("The image displays a bright sky."), "VLM description preserved");
});

test("stripImageRefs handles MULTIPLE image-ref lines (stateful-regex regression)", () => {
  const md = "# D\n\n![a](x.png)\n\nfirst caption\n\n![b](y.png)\n\nsecond caption\n\n![c](z.png)\n\nthird";
  const stripped = stripImageRefs(md);
  assert.equal(stripped.includes("](x.png)") || stripped.includes("](y.png)") || stripped.includes("](z.png)"), false);
  assert.ok(stripped.includes("second caption"));
});

// --- zero-LLM contextual enrichment ---

test("buildRefinedDocument composes chunk.context = '<summary>; this section covers <path>' (zero extra LLM calls)", () => {
  const doc = buildRefinedDocument("# CALEO 2023\n\n## Thursday\n\nArrival and shuttle details.", {
    summary: "CALEO 2023 Mallorca workshop schedule.",
    sections: [],
    frontmatter: { type: "event", topic: "internal/events" },
    entities: [],
    relations: [],
    keywords: [],
    quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
  });

  assert.equal(doc.chunks.length, 1);
  const context = doc.chunks[0]!.context!;
  assert.match(context, /CALEO 2023 Mallorca workshop schedule/);
  assert.match(context, /this section covers CALEO 2023 \/ Thursday/);
  assert.ok(!context.includes("\n"), "context stays a single line");
});

test("chunk context falls back gracefully without summary or headings (never crashes, empty allowed only when both absent)", () => {
  const withPathOnly = buildRefinedDocument("# Doc\n\n## A\n\nbody", {
    summary: "",
    sections: [],
    frontmatter: { type: "document", topic: "corporate/general" },
    entities: [],
    relations: [],
    keywords: [],
    quality: { complete: true, confidence: 0.5, issues: [], action: "auto_accept" },
  });
  assert.equal(withPathOnly.chunks[0]!.context, "This section covers Doc / A.");

  const bare = buildRefinedDocument("just a paragraph", {
    summary: "",
    sections: [],
    frontmatter: { type: "document", topic: "corporate/general" },
    entities: [],
    relations: [],
    keywords: [],
    quality: { complete: true, confidence: 0.5, issues: [], action: "auto_accept" },
  });
  assert.equal(bare.chunks[0]!.context, undefined, "neither summary nor heading path → no fabricated context");
});
