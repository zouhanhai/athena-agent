import { test } from "node:test";
import assert from "node:assert/strict";
import type { HeaderBlock } from "../src/agents/refine-output.js";
import {
  applyTocToMarkdown,
  createDoclingOutlineSource,
  createExternalTocSource,
  createMarkdownTocPreambleSource,
  detectTocTree,
  flattenTocPreOrder,
  gradeHeadersFromToc,
  normalizeHeadingText,
  parseTocInput,
  tocDepthToMdLevel,
  tocFirstJudge,
  type HeaderGradingContext,
  type TocNode,
} from "../src/agents/header-toc.js";

// --- normalized heading text (the matcher's equality key) ---

test("normalizeHeadingText strips trailing page numbers, parens-suffixes, punctuation, case and markdown markers", () => {
  assert.equal(normalizeHeadingText("Introduction, 12"), "introduction");
  assert.equal(normalizeHeadingText("CDS Views (ABAP)"), "cdsviews");
  assert.equal(normalizeHeadingText("CDS Views for Finance!"), "cdsviewsforfinance");
  assert.equal(normalizeHeadingText("**Overview**"), "overview");
  assert.equal(normalizeHeadingText("Header `V_FOO`"), "headervfoo");
  assert.equal(normalizeHeadingText("Überblick"), "überblick");
});

test("normalizeHeadingText strips leading section numbering so TOC '1.2.3 Title' matches heading 'Title'", () => {
  assert.equal(normalizeHeadingText("1.2.3 Introduction"), "introduction");
  assert.equal(normalizeHeadingText("7 Subchapter"), "subchapter");
});

// --- TOC input parsing (external TOC / docling outline JSON) ---

test("parseTocInput accepts nested {title|text, children} arrays (SAP fullToc shape)", () => {
  const tree = parseTocInput([
    { title: "A", children: [{ title: "A1" }, { title: "A2", children: [{ title: "A2.1" }] }] },
    { title: "B" },
  ]);
  assert.ok(tree);
  assert.equal(tree!.level, 0);
  assert.equal(tree!.children?.length, 2);
  assert.equal(tree!.children![0]!.children!.length, 2);
  const flat = flattenTocPreOrder(tree!);
  assert.deepEqual(
    flat.map((e) => `${e.depth}:${e.text}`),
    ["1:A", "2:A1", "2:A2", "3:A2.1", "1:B"],
  );
});

test("parseTocInput accepts flat arrays (strings or {title} objects) as level-1 entries", () => {
  const flat = parseTocInput(["Alpha", "Beta"]);
  assert.deepEqual(flattenTocPreOrder(flat!).map((e) => e.text), ["Alpha", "Beta"]);
  const objFlat = parseTocInput([{ title: "Alpha" }, { title: "Beta" }]);
  assert.deepEqual(flattenTocPreOrder(objFlat!).map((e) => e.text), ["Alpha", "Beta"]);
});

test("parseTocInput accepts wrapper objects ({toc|children|tree}) and JSON strings", () => {
  const wrapped = parseTocInput({ toc: [{ title: "A" }] });
  assert.deepEqual(flattenTocPreOrder(wrapped!).map((e) => e.text), ["A"]);
  const encoded = parseTocInput('{"text":"","level":0,"children":[{"text":"A","level":1,"children":[]}]}');
  assert.deepEqual(flattenTocPreOrder(encoded!).map((e) => e.text), ["A"]);
});

test("parseTocInput returns null for unusable input (never blocks refinement)", () => {
  assert.equal(parseTocInput(undefined), null);
  assert.equal(parseTocInput(null), null);
  assert.equal(parseTocInput(42), null);
  assert.equal(parseTocInput("not json"), null);
  assert.equal(parseTocInput({ title: "A", children: "nope" }), null);
  assert.equal(parseTocInput([]), null);
});

// --- TOC-depth → md-level mapping (parameterized; default D4→h1 … D8→h5) ---

test("tocDepthToMdLevel default: root children → h1, each deeper level +1, clamped at h5", () => {
  assert.equal(tocDepthToMdLevel(1), 1);
  assert.equal(tocDepthToMdLevel(2), 2);
  assert.equal(tocDepthToMdLevel(3), 3);
  assert.equal(tocDepthToMdLevel(4), 4);
  assert.equal(tocDepthToMdLevel(5), 5);
  assert.equal(tocDepthToMdLevel(6), 5);
  assert.equal(tocDepthToMdLevel(9), 5);
});

test("tocDepthToMdLevel honors a parameterized base/max mapping", () => {
  const mapping = { baseLevel: 2, maxLevel: 4 };
  assert.equal(tocDepthToMdLevel(1, mapping), 2);
  assert.equal(tocDepthToMdLevel(2, mapping), 3);
  assert.equal(tocDepthToMdLevel(3, mapping), 4);
  assert.equal(tocDepthToMdLevel(5, mapping), 4);
});

// --- deterministic grading: md headings matched to the TOC pre-order walk ---

const SAP_TOC: TocNode = {
  text: "",
  level: 0,
  children: [
    {
      text: "SAP S/4HANA, SAP S/4HANA Cloud",
      level: 1,
      children: [
        {
          text: "CDS Views in SAP S/4HANA",
          level: 2,
          children: [
            {
              text: "Development Tool Guidance",
              level: 3,
              children: [
                {
                  text: "Prerequisites",
                  level: 4,
                  children: [
                    {
                      text: "ABAP Development Tools",
                      level: 5,
                      children: [
                        { text: "Additional Information", level: 6, children: [] },
                      ],
                    },
                  ],
                },
              ],
            },
            { text: "General Concepts", level: 3, children: [] },
          ],
        },
        { text: "Data Model", level: 2, children: [] },
      ],
    },
  ],
};

function blocks(texts: string[], level = 2): HeaderBlock[] {
  return texts.map((text, index) => ({
    index,
    level,
    text,
    heading: `${"#".repeat(level)} ${text}`,
    body: `body of ${text}`,
  }));
}

test("gradeHeadersFromToc reproduces the clean hierarchy: D4→h1 … D8→h5 (deep clamped), unmatched keep originals", () => {
  const input = blocks([
    "SAP S/4HANA, SAP S/4HANA Cloud",
    "CDS Views in SAP S/4HANA",
    "Development Tool Guidance",
    "Prerequisites (2023)",
    "ABAP Development Tools, 88",
    "Additional Information",
    "General Concepts",
    "Data Model",
    "Template Field Overview",
  ]);
  const graded = gradeHeadersFromToc(input, SAP_TOC);

  const leveled = new Map(graded.blocks.map((b) => [b.text, b.level]));
  assert.equal(leveled.get("SAP S/4HANA, SAP S/4HANA Cloud"), 1, "D4 → h1");
  assert.equal(leveled.get("CDS Views in SAP S/4HANA"), 2, "D5 → h2");
  assert.equal(leveled.get("Development Tool Guidance"), 3, "D6 → h3");
  assert.equal(leveled.get("Prerequisites (2023)"), 4, "D7 → h4 (parens normalized)");
  assert.equal(leveled.get("ABAP Development Tools, 88"), 5, "D8 → h5 (page number normalized)");
  assert.equal(leveled.get("Additional Information"), 5, "D9+ → h5 (clamped)");
  assert.equal(leveled.get("General Concepts"), 3, "sibling re-enters the pre-order walk");
  assert.equal(leveled.get("Data Model"), 2);
  assert.equal(leveled.get("Template Field Overview"), 2, "unmatched keeps the conservative original level");
  assert.equal(graded.matched, 8);
  assert.equal(graded.total, 8);
});

test("gradeHeadersFromToc: duplicate TOC titles match in document order (forward cursor)", () => {
  const tree = parseTocInput([{ title: "Overview", children: [{ title: "Deep" }, { title: "Overview" }] }, { title: "Tail" }]);
  const graded = gradeHeadersFromToc(blocks(["Overview", "Deep", "Overview", "Tail"]), tree!);
  assert.deepEqual(
    graded.blocks.map((b) => [b.text, b.level]),
    [
      ["Overview", 1],
      ["Deep", 2],
      ["Overview", 2],
      ["Tail", 1],
    ],
    "each TOC occurrence binds to its document-order block (forward cursor)",
  );
  assert.equal(graded.matched, 4);
});

test("gradeHeadersFromToc: partial TOC — unmatched sections keep conservative defaults, matched counted", () => {
  const tree = parseTocInput([{ title: "One" }, { title: "Three" }]);
  const graded = gradeHeadersFromToc(blocks(["One", "Two", "Three", "Four"]), tree!);
  const leveled = new Map(graded.blocks.map((b) => [b.text, b.level]));
  assert.equal(leveled.get("One"), 1);
  assert.equal(leveled.get("Two"), 2, "unmatched keeps original");
  assert.equal(leveled.get("Three"), 1);
  assert.equal(leveled.get("Four"), 2);
  assert.equal(graded.matched, 2);
  assert.equal(graded.total, 2);
});

test("gradeHeadersFromToc: empty tree grades nothing", () => {
  const graded = gradeHeadersFromToc(blocks(["A"]), { text: "", level: 0, children: [] });
  assert.equal(graded.matched, 0);
  assert.equal(graded.total, 0);
  assert.equal(graded.blocks[0]!.level, 2);
});

// --- detection: markdown-toc-preamble provider ---

const SAP_PREAMBLE_MD = [
  "- [SAP S/4HANA, SAP S/4HANA Cloud](?pip=search&page=1)",
  "  - [CDS Views in SAP S/4HANA](?pip=cds)",
  "    - [Development Tool Guidance](?pip=devtools)",
  "    - [General Concepts](?pip=concepts)",
  "  - [Data Model](?pip=datamodel)",
  "- [Billing](?pip=billing)",
  "",
  "## SAP S/4HANA, SAP S/4HANA Cloud",
  "",
  "Text about CDS views.",
].join("\n");

test("markdown-toc-preamble detects the SAP '- [Title](...)' preamble block with indent levels", async () => {
  const source = createMarkdownTocPreambleSource();
  const tree = await source.detect({ markdown: SAP_PREAMBLE_MD, outline: null, externalToc: null });
  assert.ok(tree);
  assert.equal(tree!.children!.length, 2);
  const flat = flattenTocPreOrder(tree!);
  assert.deepEqual(flat.map((e) => `${e.depth}:${e.text}`), [
    "1:SAP S/4HANA, SAP S/4HANA Cloud",
    "2:CDS Views in SAP S/4HANA",
    "3:Development Tool Guidance",
    "3:General Concepts",
    "2:Data Model",
    "1:Billing",
  ]);
});

test("markdown-toc-preamble rejects list runs below minEntries", async () => {
  const md = "- [One](?a=1)\n- [Two](?a=2)\n\n# Title\n\nBody";
  const source = createMarkdownTocPreambleSource();
  assert.equal(await source.detect({ markdown: md, outline: null, externalToc: null }), null);
});

test("markdown-toc-preamble rejects plain bullet lists (no links) unless requireLinks:false", async () => {
  const md = "- one\n- two\n- three\n- four\n\n# Title\n\nBody";
  const strict = createMarkdownTocPreambleSource();
  assert.equal(await strict.detect({ markdown: md, outline: null, externalToc: null }), null);
  const lax = createMarkdownTocPreambleSource({ requireLinks: false });
  assert.ok(await lax.detect({ markdown: md, outline: null, externalToc: null }));
});

test("markdown-toc-preamble returns null when the document has no TOC-shaped block", async () => {
  const source = createMarkdownTocPreambleSource();
  assert.equal(await source.detect({ markdown: "# Just a heading\n\nBody", outline: null, externalToc: null }), null);
});

// --- detection: docling-outline + external providers + ordering ---

const OUTLINE_JSON: TocNode = {
  text: "",
  level: 0,
  children: [{ text: "Chapter One", level: 1, children: [{ text: "Sub One", level: 2, children: [] }] }],
};

test("docling-outline provider serves the parsed PDF outline from the context", async () => {
  const source = createDoclingOutlineSource();
  const found = await source.detect({ markdown: "# Chapter One", outline: OUTLINE_JSON, externalToc: null });
  assert.ok(found);
  assert.deepEqual(flattenTocPreOrder(found!).map((e) => e.text), ["Chapter One", "Sub One"]);
  assert.equal(await source.detect({ markdown: "# No Outline", outline: null, externalToc: null }), null);
});

test("external provider serves the TOC passed at refine time", async () => {
  const source = createExternalTocSource();
  const found = await source.detect({ markdown: "# A", outline: null, externalToc: [{ title: "A" }, { title: "B" }] });
  assert.ok(found);
  assert.deepEqual(flattenTocPreOrder(found!).map((e) => e.text), ["A", "B"]);
  assert.equal(await source.detect({ markdown: "# A", outline: null, externalToc: null }), null);
});

test("detectTocTree tries providers in order and never blocks on a throwing provider", async () => {
  const boom: HeaderGradingContext = {
    markdown: "# A",
    outline: null,
    externalToc: null,
  };
  const broken = {
    name: "broken",
    detect: async () => {
      throw new Error("provider crashed");
    },
  };
  const found = await detectTocTree(
    boom,
    [broken, createMarkdownTocPreambleSource(), { name: "external", detect: async () => parseTocInput([{ title: "A" }]) } as never],
  );
  assert.ok(found);
  assert.equal(found!.source.name, "external");
  assert.equal(await detectTocTree(boom, [broken, broken]), null, "all providers fail → null, never throws");
});

// --- composed judge: TOC-first with LLM fallback ---

const ctxFor = (markdown: string, extra: Partial<HeaderGradingContext> = {}): HeaderGradingContext => ({
  markdown,
  outline: null,
  externalToc: null,
  ...extra,
});

test("tocFirstJudge grades from the TOC when detected (fallback NOT called) and reports toc mode", async () => {
  const fallbackCalls: string[][] = [];
  const blocks = flatSapBlocks();
  const result = await tocFirstJudge(blocks, ctxFor(SAP_PREAMBLE_MD), {
    sources: [createMarkdownTocPreambleSource()],
    fallback: async (bs) => {
      fallbackCalls.push(bs.map((b) => b.text));
      return { blocks: bs, batches: 1, failedBatches: 0 };
    },
  });
  assert.deepEqual(fallbackCalls, [], "LLM judge never called");
  assert.equal(result.headerMode, "toc");
  assert.equal(result.tocSource, "markdown-toc-preamble");
  assert.equal(result.tocMatched, 6);
  assert.equal(result.tocTotal, 6);
  const leveled = new Map(result.blocks.map((b) => [b.text, b.level]));
  assert.equal(leveled.get("SAP S/4HANA, SAP S/4HANA Cloud"), 1);
  assert.equal(leveled.get("Development Tool Guidance"), 3);
});

test("tocFirstJudge: a zero-match preamble falls through to the external TOC (provider chain)", async () => {
  const result = await tocFirstJudge(blocks(["Chapter One"]), ctxFor(SAP_PREAMBLE_MD, { externalToc: [{ title: "Chapter One" }] }), {
    sources: [createMarkdownTocPreambleSource(), createExternalTocSource()],
    fallback: async (bs) => ({ blocks: bs, batches: 1, failedBatches: 0 }),
  });
  assert.equal(result.headerMode, "toc");
  assert.equal(result.tocSource, "external", "preamble detected but graded 0 matches → external TOC wins");
  assert.equal(result.tocMatched, 1);
  assert.equal(result.tocTotal, 1);
});

test("tocFirstJudge falls back to the LLM judge with mode=llm when no TOC is detected", async () => {
  const fallbackCalls = [];
  const result = await tocFirstJudge(blocks(["Title"], 1), ctxFor("# Title\n\nBody"), {
    sources: [createMarkdownTocPreambleSource()],
    fallback: async (bs) => {
      fallbackCalls.push(bs.length);
      return { blocks: bs.map((b) => ({ ...b, level: 1 })), batches: 1, failedBatches: 0 };
    },
  });
  assert.deepEqual(fallbackCalls, [1]);
  assert.equal(result.headerMode, "llm");
  assert.equal(result.blocks[0]!.level, 1, "fallback levels applied");
});

test("tocFirstJudge treats a zero-match TOC as no TOC (false-positive guard) → LLM fallback", async () => {
  const md = "- [External Link A](https://a.example)\n- [External Link B](https://b.example)\n- [External Link C](https://c.example)\n\n# Title\n\nBody";
  const fallbackCalls = [];
  const result = await tocFirstJudge(blocks(["Title"], 1), ctxFor(md), {
    sources: [createMarkdownTocPreambleSource()],
    fallback: async (bs) => {
      fallbackCalls.push(bs.length);
      return { blocks: bs, batches: 1, failedBatches: 0 };
    },
  });
  assert.deepEqual(fallbackCalls, [1], "LLM path preserved for a detected-but-unmatched block");
  assert.equal(result.headerMode, "llm");
});

// --- single-pass helper: apply TOC re-leveling to an already-refined markdown ---

test("applyTocToMarkdown re-levels flat markdown per the TOC tree (preamble preserved)", () => {
  const md = [
    "- [Chapter One](?c=1)",
    "  - [Sub One](?c=1.1)",
    "- [Chapter Two](?c=2)",
    "",
    "## Chapter One",
    "",
    "body one",
    "",
    "## Sub One",
    "",
    "body sub",
    "",
    "## Chapter Two",
    "",
    "body two",
  ].join("\n");
  const applied = applyTocToMarkdown(md, parseTocInput([{ title: "Chapter One", children: [{ title: "Sub One" }] }, { title: "Chapter Two" }])!);
  assert.match(applied.markdown, /^# Chapter One$/m);
  assert.match(applied.markdown, /^## Sub One$/m);
  assert.match(applied.markdown, /^# Chapter Two$/m);
  assert.match(applied.markdown, /^- \[Chapter One\]/, "preamble TOC list preserved on rebuild");
  assert.equal(applied.matched, 3);
  assert.equal(applied.total, 3);
});

function flatSapBlocks(): HeaderBlock[] {
  return blocks([
    "SAP S/4HANA, SAP S/4HANA Cloud",
    "CDS Views in SAP S/4HANA",
    "Development Tool Guidance",
    "General Concepts",
    "Data Model",
    "Billing",
  ]);
}