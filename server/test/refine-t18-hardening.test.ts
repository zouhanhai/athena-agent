import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRefineDocumentTool,
  type AssistantMessageLike,
  type RefineLlmCaller,
} from "../src/agents/refine-document.js";
import {
  assertSingleH1,
  completeHeaderHierarchy,
  countH1,
  deriveStemFromFileName,
  deriveStemWithFileName,
  hasSingleH1,
  mergeObjectiveDefectsIntoQuality,
  scanObjectiveDefects,
  placeholderPatterns,
  DEFAULT_PLACEHOLDER_PATTERNS,
} from "../src/agents/refine-output.js";
import type { RefinementQuality } from "../src/agents/refine-document.js";

/**
 * G4.S8.T18 — header hierarchy completion (Mallorca single-h1 regression),
 * deterministic placeholder pre-check, and stem derivation hardening.
 */

// --- Mallorca fixture: docling emitted a FLAT hierarchy (16 × h2) ---

const MALLORCA_HEADINGS = [
  "Sommerseminar Mallorca 2023",
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
 * The EXACT Mallorca failure shape after T16: the model demotes exactly 5
 * headings to h3 (leaving 11 × h2 + 5 × h3) but NEVER emits the h1 title
 * promotion patch. Indices are drifted (headings-only counting); the text
 * anchors rescue them — all apply, none promotes a title.
 */
function mallorcaPartialPatches(): Array<{ op: string; index: number; level?: number; text?: string; anchor?: string }> {
  const patches: Array<{ op: string; index: number; level?: number; text?: string; anchor?: string }> = [];
  MALLORCA_HEADINGS.forEach((text) => {
    if (/^Workshop |^Airport Transfer|^Hotel Check-in$|^Boat Tour|^Winery Visit$/.test(text)) {
      // Ordinals drift past the real grid; only the anchor locates the target.
      patches.push({ op: "refactor_heading", index: 999, level: 3, anchor: text });
    }
  });
  return patches;
}

function deltaMessage(overrides: Record<string, unknown> = {}): AssistantMessageLike {
  return {
    role: "assistant",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          summary: "Seminar program.",
          sections: [],
          frontmatter: { type: "event", topic: "internal/events" },
          entities: [],
          relations: [],
          keywords: ["mallorca"],
          quality: { complete: true, confidence: 0.95, issues: [], action: "auto_accept" },
          patches: mallorcaPartialPatches(),
          ...overrides,
        }),
      },
    ],
  };
}

function stubCaller(responses: AssistantMessageLike[]): RefineLlmCaller {
  let i = 0;
  return async () => ({ message: responses[Math.min(i++, responses.length - 1)]! });
}

// --- 1a. pure helpers ---

test("hasSingleH1 / countH1 / assertSingleH1 detect the h1 count", () => {
  assert.equal(hasSingleH1("# Title\n\n## A\n\n# B"), false);
  assert.equal(hasSingleH1("## A\n\n### B"), false);
  assert.equal(hasSingleH1("# Title\n\n## A"), true);
  assert.equal(countH1("# T\n\nbody with # not-a-heading\n\n## X"), 1);
  assert.throws(() => assertSingleH1("## only-h2"));
  assert.doesNotThrow(() => assertSingleH1("# one\n\n## two"));
});

test("completeHeaderHierarchy promotes the first heading when NO h1 exists", () => {
  const out = completeHeaderHierarchy(mallorcaMarkdown());
  assert.equal(out.changed, true);
  assert.equal(out.promoted, 1);
  assert.equal(out.demoted, 0);
  assert.equal(hasSingleH1(out.markdown), true);
  assert.match(out.markdown, /^# Sommerseminar Mallorca 2023\n/);
});

test("completeHeaderHierarchy demotes surplus h1s beyond the first", () => {
  const md = "# Title\n\nx\n\n# Second\n\ny\n\n# Third\n\nz";
  const out = completeHeaderHierarchy(md);
  assert.deepEqual({ changed: out.changed, promoted: out.promoted, demoted: out.demoted }, {
    changed: true,
    promoted: 0,
    demoted: 2,
  });
  assert.equal(hasSingleH1(out.markdown), true);
  assert.match(out.markdown, /## Second/);
});

test("completeHeaderHierarchy is a no-op on a compliant document", () => {
  const md = "# Title\n\n## A\n\n### B";
  const out = completeHeaderHierarchy(md);
  assert.deepEqual(out, { markdown: md, changed: false, promoted: 0, demoted: 0 });
});

test("completeHeaderHierarchy(demoteSurplus:false) promotes a MISSING title but keeps by-design h1 sections (two-stage)", () => {
  const md = "# S0\n\na\n\n# S1\n\nb";
  // Existing h1 sections stay untouched…
  assert.deepEqual(completeHeaderHierarchy(md, { demoteSurplus: false }), {
    markdown: md,
    changed: false,
    promoted: 0,
    demoted: 0,
  });
  // …but a missing title is still promoted.
  const out = completeHeaderHierarchy("## S0\n\na\n\n## S1\n\nb", { demoteSurplus: false });
  assert.equal(out.promoted, 1);
  assert.equal(hasSingleH1(out.markdown), true);
});

// --- 1b. end-to-end through the refine tool (the actual T16 regression) ---

test("Mallorca-shaped run ends with EXACTLY ONE h1 even when the model never promotes a title", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t18-header-"));
  try {
    const tool = createRefineDocumentTool({} as never, {
      storageDir: dir,
      httpCaller: stubCaller([deltaMessage()]),
    });
    const result = await tool.execute(
      "refine_document",
      { markdown: mallorcaMarkdown() },
      undefined,
      undefined,
      {} as never,
    );
    const details = (result as { details: Record<string, unknown> }).details;
    const ref = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { md_ref: string };
    const final = await readFile(ref.md_ref, "utf8");
    // THE contract: every refined document carries exactly one document title.
    assertSingleH1(final);
    // The model's partial re-leveling (5 × h3) is preserved beneath it.
    assert.equal((final.match(/^### /gm) ?? []).length, 7);
    // Instrumentation stays truthful: completion logged, T16 counters intact.
    assert.deepEqual(details.headerCompletion, { promoted: 1, demoted: 0 });
    const patches = details.patches as { emitted: number; applied: number };
    assert.equal(patches.applied, 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compliant documents skip header completion (no false instrumentation)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t18-header-clean-"));
  try {
    const good =
      "# Title\n\nintro\n\n## A\n\nbody\n\n### B\n\ndeep body\n\n## C\n\nmore body\n\n### D\n\ntail body\n\n## E\n\nlast body\n\n### F\n\nfinal body";
    const tool = createRefineDocumentTool({} as never, {
      storageDir: dir,
      httpCaller: stubCaller([
        deltaMessage({
          patches: [{ op: "refactor_heading", index: 6, level: 3, anchor: "B" }],
        }),
      ]),
    });
    const result = await tool.execute(
      "refine_document",
      { markdown: good },
      undefined,
      undefined,
      {} as never,
    );
    const details = (result as { details: Record<string, unknown> }).details;
    assert.equal(details.headerCompletion, undefined);
    const ref = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { md_ref: string };
    assertSingleH1(await readFile(ref.md_ref, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 2. deterministic placeholder pre-check ---

const PLACEHOLDER_DOC = [
  "# Seminar Report",
  "",
  "## Anfahrt",
  "",
  "Der Zustieg am ????? ist unklar.",
  "",
  "## Offene Punkte",
  "",
  "TODO: Klärfall mit Herrn Maier besprechen.",
].join("\n");

test("scanObjectiveDefects finds ?????/TODO/FIXME/XXX/lorem ipsum with heading paths", () => {
  const defects = scanObjectiveDefects(PLACEHOLDER_DOC);
  const patterns = defects.map((d) => d.pattern).sort();
  assert.deepEqual(patterns, ["\\?{3,}", "\\bTODO\\b"]);
  assert.ok(defects.every((d) => d.quote.includes("?") || d.quote.toUpperCase().includes("TODO")));
  const questionMark = defects.find((d) => d.pattern === "\\?{3,}")!;
  assert.equal(questionMark.heading_path, "Seminar Report / Anfahrt");
  const todo = defects.find((d) => d.pattern === "\\bTODO\\b")!;
  assert.equal(todo.heading_path, "Seminar Report / Offene Punkte");
});

test("scanObjectiveDefects returns nothing on clean documents (no false positive)", () => {
  assert.deepEqual(
    scanObjectiveDefects("# Clean\n\nNormal prose. What time? Two questions?? maybe.\n\n- list item"),
    [],
  );
  assert.deepEqual(scanObjectiveDefects(""), []);
});

test("placeholderPatterns honors REFINE_PLACEHOLDER_PATTERNS (:: separated) and skips bad regex", () => {
  process.env.REFINE_PLACEHOLDER_PATTERNS = "\\?{5,}::\\bWIP\\b::([unclosed";
  try {
    const patterns = placeholderPatterns();
    assert.equal(patterns.length, 2);
    assert.deepEqual(
      patterns.map((p) => p.source),
      ["\\?{5,}", "\\bWIP\\b"],
    );
  } finally {
    delete process.env.REFINE_PLACEHOLDER_PATTERNS;
  }
  assert.deepEqual(DEFAULT_PLACEHOLDER_PATTERNS.length >= 4, true);
});

function qualityOf(action: "auto_accept" | "review_required"): RefinementQuality {
  return { complete: true, confidence: 0.95, issues: [], action };
}

test("mergeObjectiveDefectsIntoQuality forces review_required + complete=false despite auto_accept LLM verdict", () => {
  const merged = mergeObjectiveDefectsIntoQuality(qualityOf("auto_accept"), PLACEHOLDER_DOC);
  assert.equal(merged.quality.action, "review_required");
  assert.equal(merged.quality.complete, false);
  assert.equal(merged.appended.length, 2);
  const anchored = merged.quality.issue_anchors!.filter((a) => a.message.startsWith("[placeholder:"));
  assert.equal(anchored.length, 2);
  assert.match(anchored[0]!.message, /under "Seminar Report \/ Anfahrt"/);
});

test("mergeObjectiveDefectsIntoQuality dedupes against an LLM anchor for the SAME quote but still gates", () => {
  const q: RefinementQuality = {
    complete: true,
    confidence: 0.95,
    issues: [],
    action: "auto_accept",
    issue_anchors: [{ message: "Placeholder left in", quote: "Der Zustieg am ????? ist unklar." }],
  };
  const merged = mergeObjectiveDefectsIntoQuality(q, PLACEHOLDER_DOC);
  // The ????? hit dedupes; only the TODO line is appended.
  assert.equal(merged.appended.length, 1);
  assert.match(merged.appended[0]!.anchor!.quote, /TODO/);
  // Gate is forced regardless of the LLM's own clean verdict.
  assert.equal(merged.quality.action, "review_required");
  assert.equal(merged.quality.complete, false);
  assert.equal(merged.quality.issue_anchors!.length, 2);
});

test("LLM-said-clean + placeholder present → the stored ref quality is FORCED review_required end-to-end", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t18-placeholder-"));
  try {
    const doc = `${PLACEHOLDER_DOC}\n\n## Mehr\n\nWeitere Body-Zeile hier.`;
    const tool = createRefineDocumentTool({} as never, {
      storageDir: dir,
      httpCaller: stubCaller([deltaMessage({ patches: [] })]),
    });
    const result = await tool.execute(
      "refine_document",
      { markdown: doc },
      undefined,
      undefined,
      {} as never,
    );
    const ref = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as {
      quality: RefinementQuality;
      refinement_issues?: Array<{ message: string; anchor?: { quote: string } }>;
    };
    assert.equal(ref.quality.action, "review_required");
    assert.equal(ref.quality.complete, false);
    assert.ok(ref.refinement_issues!.some((i) => i.anchor?.quote.includes("?????")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 3. stem derivation hardening ---

test("deriveStemFromFileName slugs upload names (extension stripped)", () => {
  assert.equal(deriveStemFromFileName("Sommerseminar-Mallorca-2023.pdf.md"), "sommerseminar-mallorca-2023");
  assert.equal(deriveStemFromFileName("Group Report SAP.pdf"), "group-report-sap");
  assert.equal(deriveStemWithFileName("## no h1 here\n\nbody", "Sommerseminar-Mallorca-2023.pdf.md"), "sommerseminar-mallorca-2023");
});

test("deriveStemWithFileName NEVER returns 'document' when a file name is available", () => {
  // Non-latin headings slug to empty → generic fallback WITHOUT a file name…
  assert.equal(deriveStemWithFileName("## 马略卡研讨会\n\n正文", undefined), "document");
  // …but NEVER with one.
  assert.notEqual(deriveStemWithFileName("## 马略卡研讨会\n\n正文", "马略卡-2023.pdf"), "document");
  assert.equal(deriveStemWithFileName("# Proper Title\n\nbody", "ignored.pdf"), "proper-title");
});

test("the tool threads file_name into the storage stem on EVERY store path (success + fallback)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t18-stem-"));
  try {
    const nonSlugMarkdown = "## 研讨会\n\n正文一。\n\n## 日程\n\n正文二。";
    // Success path: file_name wins when the h1 slug is empty.
    const tool = createRefineDocumentTool({} as never, {
      storageDir: dir,
      httpCaller: stubCaller([deltaMessage({ patches: [] })]),
    });
    const ok = await tool.execute(
      "refine_document",
      { markdown: nonSlugMarkdown, file_name: "Sommerseminar-Mallorca-2023.pdf" },
      undefined,
      undefined,
      {} as never,
    );
    const okRef = JSON.parse(
      (ok.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { md_ref: string };
    assert.ok(okRef.md_ref.includes("sommerseminar-mallorca-2023"), okRef.md_ref);

    // Fallback path: the LLM always fails → deterministic fallback still stores
    // under the name-derived stem, never the generic document/ dir.
    const failingTool = createRefineDocumentTool({} as never, {
      storageDir: dir,
      httpCaller: stubCaller([(() => ({ role: "assistant", content: [{ type: "text", text: "not json" }] }))()]),
      retries: 0,
    });
    const fb = await failingTool.execute(
      "refine_document",
      { markdown: nonSlugMarkdown, file_name: "Mallorca-Fallback.pdf" },
      undefined,
      undefined,
      {} as never,
    );
    const fbRef = JSON.parse(
      (fb.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { md_ref: string };
    assert.ok(fbRef.md_ref.includes("mallorca-fallback"), fbRef.md_ref);
    assert.ok(!fbRef.md_ref.includes("/document/"), fbRef.md_ref);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
