import { test } from "node:test";
import assert from "node:assert/strict";
import { alignChunksToMarkdown } from "../src/agents/refine-output.js";
import type { RefinementChunk } from "../src/agents/refine-document.js";

/**
 * G4.S8.T20 — the wiki-edit incremental pipeline's chunk-alignment seam.
 *
 * After the delta-mode rollout the wiki-edit LLM no longer emits chunks; the
 * caller rebuilds them by aligning the document's EXISTING chunk boundaries to
 * the corrected markdown (refiner.ts backstop). The contract under test:
 *   - a section whose text did not change keeps its chunk id + text verbatim;
 *   - a changed section refreshes ONLY its text (id/heading_path preserved so
 *     Neo4j overwrite() classifies it as "changed" and re-embeds just that one);
 *   - a section heading missing from the new markdown keeps the old text (the
 *     chunk is then dropped/kept by overwrite()'s stale-chunk delete, never
 *     silently rewritten).
 */
function priorChunks(): RefinementChunk[] {
  return [
    { id: "c1", text: "# Overview\n\nThe Lüsen week overview.", heading_path: "Overview" },
    {
      id: "c2",
      text: "# Agenda\n\nMonday: arrival. Tuesday: workshops.",
      heading_path: "Agenda",
    },
  ];
}

test("alignChunksToMarkdown keeps an unchanged section's chunk id and text verbatim", () => {
  const oldChunks = priorChunks();
  const markdown = ["# Overview", "", "The Lüsen week overview.", "", "# Agenda", "", "Monday: arrival. Tuesday: workshops."].join("\n");

  const aligned = alignChunksToMarkdown(oldChunks, markdown);

  assert.equal(aligned.length, 2, "one aligned chunk per prior chunk");
  assert.deepEqual(
    aligned.map((c) => c.id),
    ["c1", "c2"],
    "chunk ids are preserved across the edit",
  );
  assert.equal(aligned[0]!.text, oldChunks[0]!.text, "unchanged section text kept verbatim");
  assert.ok(
    aligned[0] === oldChunks[0],
    "an unchanged section returns the SAME chunk object (no churn)",
  );
});

test("alignChunksToMarkdown refreshes only the changed section's text (id + heading_path preserved)", () => {
  const oldChunks = priorChunks();
  const markdown = ["# Overview", "", "The Lüsen week overview.", "", "# Agenda", "", "Monday: arrival CHANGED. Tuesday: workshops."].join("\n");

  const aligned = alignChunksToMarkdown(oldChunks, markdown);

  assert.ok(aligned[0] === oldChunks[0], "the untouched section keeps its original chunk object");
  assert.equal(aligned[1]!.id, "c2", "changed section keeps its chunk id");
  assert.equal(aligned[1]!.heading_path, "Agenda", "changed section keeps its heading_path");
  assert.match(aligned[1]!.text, /arrival CHANGED\./, "changed section carries the new text");
  assert.notEqual(aligned[1], oldChunks[1], "a refreshed section is a new chunk object");
});

test("alignChunksToMarkdown keeps the old text when the section heading is gone from the new markdown", () => {
  const oldChunks = priorChunks();
  // The Agenda heading was removed by the structural edit — only Overview remains.
  const markdown = ["# Overview", "", "The Lüsen week overview."].join("\n");

  const aligned = alignChunksToMarkdown(oldChunks, markdown);

  assert.equal(aligned.length, 2, "alignment never drops chunks itself");
  assert.equal(aligned[1]!.id, "c2");
  assert.equal(
    aligned[1]!.text,
    oldChunks[1]!.text,
    "a heading with no matching section keeps the OLD text (stale-chunk deletion is overwrite()'s job)",
  );
});

/**
 * G4.S8.T21 ③ — sections are keyed by their FULL heading-path chain, not the
 * last segment. Repeated tail titles ("Agenda" under Day 1 AND Day 2) must
 * each map to their own chunk — the wrong chunk must never be refreshed.
 */
function dayChunks(): RefinementChunk[] {
  return [
    {
      id: "d1-agenda",
      text: "### Agenda\n\nDay 1: arrival and welcome.",
      heading_path: "Day 1 / Agenda",
    },
    {
      id: "d2-agenda",
      text: "### Agenda\n\nDay 2: workshops unchanged.",
      heading_path: "Day 2 / Agenda",
    },
  ];
}

const daysMarkdown = [
  "# Day 1",
  "",
  "### Agenda",
  "",
  "Day 1: arrival CHANGED plus evening session.",
  "",
  "# Day 2",
  "",
  "### Agenda",
  "",
  "Day 2: workshops unchanged.",
].join("\n");

test("alignChunksToMarkdown maps repeated tail titles to their own chunk via the full parent chain", () => {
  const oldChunks = dayChunks();

  const aligned = alignChunksToMarkdown(oldChunks, daysMarkdown);

  assert.equal(aligned.length, 2);
  assert.equal(aligned[0]!.id, "d1-agenda");
  assert.match(
    aligned[0]!.text,
    /arrival CHANGED/,
    "the Day 1 Agenda edit refreshes the Day 1 chunk",
  );
  assert.ok(aligned[1] === oldChunks[1], "the Day 2 Agenda chunk is untouched (no cross-refresh)");
  assert.equal(
    aligned[1]!.text,
    oldChunks[1]!.text,
    "the identically-titled Day 2 Agenda keeps its own text",
  );
});

test("alignChunksToMarkdown refreshes the second same-tail section when ITS text changes", () => {
  const oldChunks = dayChunks();
  const markdown = [
    "# Day 1",
    "",
    "### Agenda",
    "",
    "Day 1: arrival and welcome.",
    "",
    "# Day 2",
    "",
    "### Agenda",
    "",
    "Day 2: workshops RESCHEDULED to afternoon.",
  ].join("\n");

  const aligned = alignChunksToMarkdown(oldChunks, markdown);

  assert.ok(aligned[0] === oldChunks[0], "Day 1 Agenda is untouched");
  assert.match(aligned[1]!.text, /RESCHEDULED/, "the Day 2 edit hits the Day 2 chunk");
});

test("alignChunksToMarkdown still matches plain top-level chains (legacy single-segment paths)", () => {
  const oldChunks = priorChunks();
  const markdown = [
    "# Overview",
    "",
    "The Lüsen week overview.",
    "",
    "# Agenda",
    "",
    "Monday REVISED. Tuesday: workshops.",
  ].join("\n");

  const aligned = alignChunksToMarkdown(oldChunks, markdown);

  assert.ok(aligned[0] === oldChunks[0]);
  assert.match(aligned[1]!.text, /REVISED/);
});
