/**
 * G4.S10.T7 — header review gate: card model + deterministic rewrite tests.
 *
 * The draft payload contract: the server accepts ops (move/promote/demote/level/
 * bold) against the detected card model, validates them (unknown ids, cycles),
 * applies them, and can rewrite the parsed markdown IDEMPOTENTLY with all
 * non-header content preserved verbatim.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cardsFromMarkdown,
  applyOps,
  rewriteMarkdown,
  cardsToTocNode,
  previewTree,
  applyBulkTemplateDemotion,
  HeaderReviewOpError,
  countCardChanges,
} from "../../src/kb/header-review.js";
import { parseTocInput, flattenTocPreOrder } from "../../src/agents/header-toc.js";

const DOC = `---
title: CDS Views
---

# Introduction

Some intro text.

## Purpose

CDS views give you one model.

## Prerequisites

You need ABAP.

# Setup

## Step 1

Install things.

### Step 1a

Details.

## Step 2

More things.

# Appendix

## Related Information

Links.
`;

// heading order in DOC: 0 Introduction, 1 Purpose, 2 Prerequisites,
// 3 Setup, 4 Step 1, 5 Step 1a, 6 Step 2, 7 Appendix, 8 Related Information
const INTRO = 0; const PURPOSE = 1; const PREREQ = 2; const SETUP = 3;
const STEP1 = 4; const STEP1A = 5; const STEP2 = 6; const APPENDIX = 7; const REINFO = 8;

test("cardsFromMarkdown detects level, parent and sibling order", () => {
  const cards = cardsFromMarkdown(DOC);
  assert.equal(cards.length, 9);
  const byIndex = new Map(cards.map((c) => [c.index, c]));
  assert.equal(byIndex.get(INTRO)!.level, 1);
  assert.equal(byIndex.get(INTRO)!.parentId, null);
  assert.equal(byIndex.get(PURPOSE)!.level, 2);
  assert.equal(byIndex.get(PURPOSE)!.parentId, byIndex.get(INTRO)!.id);
  assert.equal(byIndex.get(STEP1A)!.parentId, byIndex.get(STEP1)!.id, "Step 1a under Step 1");
  assert.equal(byIndex.get(STEP2)!.parentId, byIndex.get(SETUP)!.id, "Step 2 under Setup");
  assert.equal(byIndex.get(REINFO)!.text, "Related Information");
});

test("cardsFromMarkdown ignores headings inside fenced code blocks", () => {
  const md = `# Title\n\n## Real\n\n\`\`\`\ntext\n## Not A Heading\n\`\`\`\n\ntail\n`;
  const cards = cardsFromMarkdown(md);
  assert.equal(cards.length, 2);
  assert.equal(cards[1]!.text, "Real");
});

test("applyOps rejects unknown index / self-parent / descendant cycles", () => {
  const cards = cardsFromMarkdown(DOC);
  assert.throws(
    () => applyOps(cards, [{ type: "move", index: 99, parentId: null, position: 0 }]),
    HeaderReviewOpError,
  );
  const self = cards.find((c) => c.index === PURPOSE)!;
  assert.throws(
    () => applyOps(cards, [{ type: "move", index: PURPOSE, parentId: self.id, position: 0 }]),
    HeaderReviewOpError,
  );
  // move "Setup" (index SETUP) under its own descendant "Step 1a" (index STEP1A) → cycle
  assert.throws(
    () => applyOps(cards, [{ type: "move", index: SETUP, parentId: cards[STEP1A]!.id, position: 0 }]),
    HeaderReviewOpError,
  );
});

test("applyOps reorders among siblings and re-parents (drop-on-card)", () => {
  let cards = cardsFromMarkdown(DOC);
  // reorder: move "Step 2" before "Step 1" (same parent, position 0)
  cards = applyOps(cards, [{ type: "move", index: STEP2, parentId: cards[SETUP]!.id, position: 0 }]);
  const step1 = cards.find((c) => c.text === "Step 1")!;
  const step2 = cards.find((c) => c.text === "Step 2")!;
  assert.equal(step2.parentId, cards[SETUP]!.id);
  assert.ok(step2.order < step1.order, "Step 2 ordered before Step 1");
  // re-parent: drop "Appendix" under "Introduction"
  cards = applyOps(cards, [{ type: "move", index: APPENDIX, parentId: cards[INTRO]!.id, position: 0 }]);
  const appendix = cards.find((c) => c.text === "Appendix")!;
  assert.equal(appendix.parentId, cards[INTRO]!.id);
  assert.equal(previewTree(cards)[0]!.children?.find((c) => c.text === "Appendix")?.index, APPENDIX);
});

test("applyOps promote/demote/level adjust the tree like an outliner", () => {
  let cards = cardsFromMarkdown(DOC);
  // demote "Prerequisites" under "Purpose" (its previous sibling)
  cards = applyOps(cards, [{ type: "demote", index: PREREQ }]);
  const pre = cards.find((c) => c.text === "Prerequisites")!;
  const purpose = cards.find((c) => c.text === "Purpose")!;
  assert.equal(pre.parentId, purpose.id);
  assert.equal(pre.level, 3);
  // promote it back
  cards = applyOps(cards, [{ type: "promote", index: PREREQ }]);
  assert.equal(cards.find((c) => c.index === PREREQ)!.level, 2);
  assert.equal(cards.find((c) => c.index === PREREQ)!.parentId, cards[INTRO]!.id);
  // set-level: "Step 1a" (level 3, child of Step 1) → level 2 (promoted out)
  cards = applyOps(cards, [{ type: "level", index: STEP1A, level: 2 }]);
  const step1a = cards.find((c) => c.index === STEP1A)!;
  assert.equal(step1a.level, 2);
  assert.equal(step1a.parentId, cards[SETUP]!.id);
  // set-level clamps to 1..6 (unreachable targets walk as far as possible)
  cards = applyOps(cards, [{ type: "level", index: SETUP, level: 9 }]);
  const setupLevel = cards.find((c) => c.index === SETUP)!.level;
  assert.ok(setupLevel >= 1 && setupLevel <= 6, `level clamped into 1..6 (got ${setupLevel})`);
});

test("applyOps bold demotes to a paragraph and grafts children to the parent", () => {
  let cards = cardsFromMarkdown(DOC);
  cards = applyOps(cards, [{ type: "bold", index: PURPOSE }]);
  const purpose = cards.find((c) => c.index === PURPOSE)!;
  assert.equal(purpose.bold, true);
  assert.equal(purpose.level, 0);
  const pre = cards.find((c) => c.text === "Prerequisites")!;
  assert.equal(pre.parentId, cards[INTRO]!.id, "child grafted to the bold card's parent");
  assert.equal(pre.level, 2);
  // toggle back
  cards = applyOps(cards, [{ type: "bold", index: PURPOSE }]);
  assert.equal(cards.find((c) => c.index === PURPOSE)!.bold, false);
});

test("rewriteMarkdown preserves non-header content verbatim", () => {
  const cards = cardsFromMarkdown(DOC);
  const { markdown } = rewriteMarkdown(DOC, cards);
  // no edits → byte-identical output (the rewrite is a pure round-trip)
  assert.equal(markdown, DOC);
});

test("rewriteMarkdown applies level edits + reorders sections verbatim", () => {
  let cards = cardsFromMarkdown(DOC);
  cards = applyOps(cards, [
    { type: "level", index: PREREQ, level: 3 },    // ## Prerequisites → ### Prerequisites
    { type: "move", index: STEP2, parentId: cards[SETUP]!.id, position: 0 }, // Step 2 before Step 1
  ]);
  const { markdown } = rewriteMarkdown(DOC, cards);
  assert.match(markdown, /\n### Prerequisites\n/);
  assert.match(markdown, /\n## Step 2\n\nMore things\.\n\n## Step 1\n\nInstall things\./);
  assert.ok(markdown.includes("CDS views give you one model."), "body preserved");
  assert.ok(markdown.includes("---\ntitle: CDS Views\n---"), "preamble preserved");
  assert.ok(!markdown.includes("\n## Prerequisites\n"), "old level line gone");
});

test("rewriteMarkdown renders bold cards as **paragraphs**", () => {
  let cards = cardsFromMarkdown(DOC);
  cards = applyOps(cards, [{ type: "bold", index: PURPOSE }]);
  const { markdown } = rewriteMarkdown(DOC, cards);
  assert.match(markdown, /\*\*Purpose\*\*\n/);
});

test("rewriteMarkdown is idempotent: deterministic + re-detect recovers the tree", () => {
  let cards = cardsFromMarkdown(DOC);
  cards = applyOps(cards, [
    { type: "demote", index: PREREQ },
    { type: "bold", index: APPENDIX },
    { type: "move", index: SETUP, parentId: cards[INTRO]!.id, position: 0 },
  ]);
  // the rewrite is a pure function of (markdown, cards) — same inputs, same bytes
  assert.equal(rewriteMarkdown(DOC, cards).markdown, rewriteMarkdown(DOC, cards).markdown);
  const { markdown } = rewriteMarkdown(DOC, cards);
  // re-detection recovers the same TREE (identity shifts only because moves
  // change the document order → new indices; text/level/bold/parent are stable)
  const re = cardsFromMarkdown(markdown);
  // compare by TEXT (identity shifts with the new document order)
  const shape = (cs: typeof cards) => {
    const out: Record<string, { level: number; bold: boolean; parent: string | null }> = {};
    for (const c of cs) {
      out[c.text] = {
        level: c.level,
        bold: c.bold,
        parent: c.parentId === null ? null : cs.find((x) => x.id === c.parentId)!.text,
      };
    }
    return out;
  };
  assert.deepEqual(shape(re), shape(cards));
  // approving the re-detected state is a no-op: the round-trip is byte-stable
  assert.equal(rewriteMarkdown(markdown, re).markdown, markdown);
});

test("cardsToTocNode exports a TOC parseable by the header-toc module", () => {
  let cards = cardsFromMarkdown(DOC);
  cards = applyOps(cards, [{ type: "bold", index: PURPOSE }]);
  const tree = cardsToTocNode(cards);
  assert.equal(tree.level, 0);
  const flattened = flattenTocPreOrder(tree);
  assert.ok(flattened.some((e) => e.text === "Introduction"));
  assert.ok(!flattened.some((e) => e.text === "Purpose"), "bold cards are excluded");
  assert.ok(flattened.some((e) => e.text === "Prerequisites"), "grafted children preserved");
  const reparsed = parseTocInput(JSON.stringify(tree));
  assert.equal(flattenTocPreOrder(reparsed!).length, flattened.length);
});

test("countCardChanges reports only cards differing from the original", () => {
  let cards = cardsFromMarkdown(DOC);
  assert.equal(countCardChanges(cards), 0);
  cards = applyOps(cards, [{ type: "level", index: PREREQ, level: 3 }]);
  assert.equal(countCardChanges(cards), 1);
  cards = applyOps(cards, [{ type: "bold", index: REINFO }]);
  assert.equal(countCardChanges(cards), 2);
});

test("applyBulkTemplateDemotion converts matching headers to bold", () => {
  const cards = cardsFromMarkdown(DOC);
  const result = applyBulkTemplateDemotion(cards, ["Purpose", "Prerequisites", "Related Information"]);
  assert.equal(result.applied.length, 3);
  assert.deepEqual(result.applied.map((c) => c.index).sort(), [1, 2, 8]);
  assert.equal(result.cards.find((c) => c.index === PURPOSE)!.bold, true);
  assert.equal(result.cards.find((c) => c.index === SETUP)!.bold, false, "non-matching header untouched");
  assert.equal(result.matchedButAlreadyBold.length, 0);
});

test("applyBulkTemplateDemotion skips words no longer real headers", () => {
  let cards = cardsFromMarkdown(DOC);
  cards = applyOps(cards, [{ type: "bold", index: PURPOSE }]);
  const result = applyBulkTemplateDemotion(cards, ["Purpose"]);
  assert.equal(result.applied.length, 0);
  assert.equal(result.matchedButAlreadyBold.length, 1);
});