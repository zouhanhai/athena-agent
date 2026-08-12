import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWikiDiff } from "../../src/kb/diff.js";

test("no change yields a no-op diff", () => {
  const body = "# Title\n\nIntro paragraph.\n";
  const diff = computeWikiDiff(body, body);
  assert.equal(diff.changed, false);
  assert.equal(diff.hunks.length, 0);
  assert.equal(diff.unified, "");
  assert.equal(diff.structural, false);
});

test("a localized body edit produces a single minimal hunk", () => {
  const before = "# Runbook\n\n## Setup\n\nCopy the file. Start the service.\n\n## Recovery\n\nRestart.";
  const after = "# Runbook\n\n## Setup\n\nCopy the file. Stop the service.\n\n## Recovery\n\nRestart.";
  const diff = computeWikiDiff(before, after);
  assert.equal(diff.changed, true);
  assert.equal(diff.hunks.length, 1, "one changed region");
  const hunk = diff.hunks[0]!;
  assert.deepEqual(hunk.beforeLines, ["Copy the file. Start the service."]);
  assert.deepEqual(hunk.afterLines, ["Copy the file. Stop the service."]);
  assert.ok(diff.unified.includes("-Copy the file. Start the service."));
  assert.ok(diff.unified.includes("+Copy the file. Stop the service."));
  assert.equal(diff.structural, false, "a prose edit is not structural");
});

test("added and removed lines appear in the hunk", () => {
  const before = "One.\nTwo.\nFour.\n";
  const after = "One.\nTwo.\nThree.\nFour.\n";
  const diff = computeWikiDiff(before, after);
  assert.equal(diff.changed, true);
  const added = diff.hunks.flatMap((h) => h.afterLines);
  assert.deepEqual(added, ["Three."]);
  const removed = diff.hunks.flatMap((h) => h.beforeLines);
  assert.deepEqual(removed, []);
});

test("a word replacement keeps the surrounding lines as context-free pure change", () => {
  const before = "Start.\nCopy the file. Start the service.\nEnd.\n";
  const after = "Start.\nCopy the file. Stop the service.\nEnd.\n";
  const diff = computeWikiDiff(before, after);
  assert.equal(diff.hunks.length, 1);
  assert.deepEqual(diff.hunks[0]!.beforeLines, ["Copy the file. Start the service."]);
  assert.deepEqual(diff.hunks[0]!.afterLines, ["Copy the file. Stop the service."]);
});

test("heading changes are structural", () => {
  const before = "# Title\n\n## Setup\n\nbody\n";
  const after = "# Title\n\n### Setup\n\nbody\n";
  const diff = computeWikiDiff(before, after);
  assert.equal(diff.structural, true, "a changed heading forces re-chunk consideration");
  assert.equal(diff.hunks.length, 1);
  assert.ok(diff.hunks[0]!.beforeLines.some((l) => l.startsWith("##")));
});

test("adding a whole new section is structural", () => {
  const before = "# Doc\n\nbody\n";
  const after = "# Doc\n\n## New section\n\nnew body\n";
  const diff = computeWikiDiff(before, after);
  assert.equal(diff.structural, true);
});

test("CRLF input is normalized before diffing", () => {
  const before = "# Doc\r\n\r\nOne.\r\n";
  const after = "# Doc\r\n\r\nTwo.\r\n";
  const diff = computeWikiDiff(before, after);
  assert.equal(diff.changed, true);
  assert.deepEqual(diff.hunks[0]!.beforeLines, ["One."]);
  assert.deepEqual(diff.hunks[0]!.afterLines, ["Two."]);
});

test("a large wholly-changed document degrades to a single replacement hunk", () => {
  const before = Array.from({ length: 1500 }, (_, i) => `old line ${i}`).join("\n");
  const after = Array.from({ length: 1500 }, (_, i) => `new line ${i}`).join("\n");
  const diff = computeWikiDiff(before, after);
  assert.equal(diff.changed, true);
  // The oversized middle falls back to one replacement (1500 removed + 1500 added).
  assert.equal(diff.hunks.length, 1);
  assert.equal(diff.hunks[0]!.beforeLines.length, 1500);
  assert.equal(diff.hunks[0]!.afterLines.length, 1500);
});
