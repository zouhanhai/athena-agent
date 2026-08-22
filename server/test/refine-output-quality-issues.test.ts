import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RefinedDocument } from "../src/agents/refine-document.js";
import {
  deriveQualityIssues,
  mergeRefinements,
  storeRefinementOutput,
  type RefinementQualityIssue,
} from "../src/agents/refine-output.js";

function docWith(overrides: Partial<RefinedDocument>): RefinedDocument {
  return {
    markdown: "# Lüsen\n\n## Anreise\n\nDer Zustieg am ????? ist unklar.\n\n## Hütte\n\nSchöne Aussicht.",
    summary: "Lüsen hike.",
    sections: [],
    frontmatter: { type: "document", topic: "hiking" },
    chunks: [],
    entities: [],
    relations: [],
    keywords: [],
    quality: { complete: true, confidence: 0.6, issues: [], action: "auto_accept" },
    ...overrides,
  };
}

test("deriveQualityIssues maps issue_anchors to structured issues with heading paths (G4.S8.T17)", () => {
  const markdown = "# Lüsen\n\nIntro paragraph.\n\n## Anreise\n\nDer Zustieg am ????? ist unklar.\n\n## Hütte\n\nKeine Bildunterschrift hier.";
  const issues = deriveQualityIssues(
    {
      complete: true,
      confidence: 0.5,
      issues: ["2 image captions missing"],
      action: "review_required",
      issue_anchors: [
        { message: "Placeholder 'Zustieg am ?????' left in the source", quote: "Der Zustieg am ????? ist unklar." },
        { message: "Caption missing under the panorama image", quote: "a quote that IS NOT in the doc" },
      ],
    },
    markdown,
  );
  assert.equal(issues.length, 3);
  const [first, second, plain] = issues;
  assert.equal(first!.id, "qi-1");
  assert.equal(first!.resolved, false);
  assert.ok(first!.anchor);
  assert.equal(first!.anchor?.quote, "Der Zustieg am ????? ist unklar.");
  // heading path derived from the enclosing headings
  assert.equal(first!.anchor?.heading_path, "Lüsen / Anreise");
  assert.equal(second!.id, "qi-2");
  // unmatched quote → no heading path derivable
  assert.equal(second!.anchor?.heading_path, undefined);
  // plain (unanchored) issue keeps its message, no anchor
  assert.equal(plain!.message, "2 image captions missing");
  assert.equal(plain!.anchor, undefined);
  assert.equal(plain!.id, "qi-3");
});

test("deriveQualityIssues tolerates whitespace differences between quote and markdown", () => {
  const markdown = "# T\n\n## S\n\nDer   Zustieg\nam ?????   ist unklar.\n";
  const issues = deriveQualityIssues(
    {
      complete: true,
      confidence: 0.5,
      issues: [],
      action: "review_required",
      issue_anchors: [{ message: "placeholder", quote: "Der Zustieg am ????? ist unklar." }],
    },
    markdown,
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.anchor?.heading_path, "T / S");
});

test("storeRefinementOutput writes quality.json with the structured issues array (G4.S8.T17)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "refine-quality-"));
  try {
    const ref = await storeRefinementOutput(
      docWith({
        quality: {
          complete: false,
          confidence: 0.4,
          issues: ["image captions missing"],
          action: "review_required",
          issue_anchors: [
            { message: "Zustieg placeholder", quote: "Der Zustieg am ????? ist unklar." },
          ],
        },
      }),
      dir,
      { stem: "lusen" },
    );
    const raw = JSON.parse(await readFile(join(dir, "lusen", "quality.json"), "utf8")) as {
      action: string;
      issues: RefinementQualityIssue[];
    };
    assert.equal(raw.action, "review_required");
    assert.equal(raw.issues.length, 2);
    const anchored = raw.issues.find((i) => i.anchor);
    assert.ok(anchored);
    assert.equal(anchored!.anchor!.quote, "Der Zustieg am ????? ist unklar.");
    assert.equal(anchored!.anchor!.heading_path, "Lüsen / Anreise");
    assert.equal(anchored!.resolved, false);
    // every issue has a stable unique id
    const ids = new Set(raw.issues.map((i) => i.id));
    assert.equal(ids.size, raw.issues.length);
    void ref;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mergeRefinements unions issue_anchors across sections (deduped by message+quote)", () => {
  const base = {
    summary: "",
    sections: [],
    frontmatter: { type: "document", topic: "t" },
    chunks: [],
    entities: [],
    relations: [],
    keywords: [],
  };
  const a = {
    ...base,
    markdown: "# A",
    quality: {
      complete: true,
      confidence: 0.9,
      issues: ["x"],
      action: "review_required" as const,
      issue_anchors: [{ message: "m1", quote: "q1" }, { message: "m2", quote: "q2" }],
    },
  };
  const b = {
    ...base,
    markdown: "# B",
    quality: {
      complete: true,
      confidence: 0.8,
      issues: ["y"],
      action: "auto_accept" as const,
      issue_anchors: [{ message: "m2", quote: "q2" }, { message: "m3", quote: "q3" }],
    },
  };
  const merged = mergeRefinements([a, b]);
  assert.deepEqual(
    merged.quality.issue_anchors?.map((i) => i.quote).sort(),
    ["q1", "q2", "q3"],
  );
});
