import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProgressLog } from "../src/kanban/progress.js";

test("parseProgressLog returns nothing for an empty body", () => {
  assert.deepEqual(parseProgressLog(""), {});
});

test("parseProgressLog ignores a body without a Progress Log section", () => {
  const body = "# Body\n\nSome implementation notes.\n";
  assert.deepEqual(parseProgressLog(body), {});
});

test("parseProgressLog returns the NEWEST row even when rows are prepended (plugin order)", () => {
  const body = [
    "## Progress Log",
    "| UTC timestamp | status | progress |",
    "|---|---|---|",
    "| 2026-08-13T09:36:42.101Z | in_progress | ran read |",
    "| 2026-08-13T09:31:36.220Z | in_progress | opencode claimed G4.S4.T2 |",
    "| 2026-08-13T09:25:12.175Z | in_progress | opencode claimed G4.S4.T2 |",
    "",
  ].join("\n");
  assert.deepEqual(parseProgressLog(body), {
    progress_updated_at: "2026-08-13T09:36:42.101Z",
    status: "in_progress",
    progress_last_row: "ran read",
  });
});

test("parseProgressLog falls back to the last row when no timestamp parses", () => {
  const body = [
    "## Progress Log",
    "| UTC timestamp | status | progress |",
    "|---|---|---|",
    "| n/a | in_progress | First |",
    "| n/a | in_progress | Last |",
    "",
  ].join("\n");
  assert.deepEqual(parseProgressLog(body), {
    progress_updated_at: "n/a",
    status: "in_progress",
    progress_last_row: "Last",
  });
});

test("parseProgressLog reads the last row of the Progress Log table", () => {
  const body = [
    "## Implementation",
    "",
    "Done stuff.",
    "",
    "## Progress Log",
    "| Timestamp (UTC) | Status | Progress |",
    "|-----------------|--------|----------|",
    "| 2026-08-09 12:00:00Z | in_progress | Reading code, understood ticket |",
    "| 2026-08-09 12:30:00Z | in_progress | Implementing shared repo selector |",
    "",
  ].join("\n");
  assert.deepEqual(parseProgressLog(body), {
    progress_updated_at: "2026-08-09 12:30:00Z",
    status: "in_progress",
    progress_last_row: "Implementing shared repo selector",
  });
});

test("parseProgressLog handles a headerless Progress Log table", () => {
  const body = [
    "## Progress Log",
    "| 2026-08-09 12:00:00Z | in_progress | Working |",
    "",
  ].join("\n");
  assert.deepEqual(parseProgressLog(body), {
    progress_updated_at: "2026-08-09 12:00:00Z",
    status: "in_progress",
    progress_last_row: "Working",
  });
});

test("parseProgressLog ignores rows that are not table rows", () => {
  const body = [
    "## Progress Log",
    "| Timestamp (UTC) | Status | Progress |",
    "|-----------------|--------|----------|",
    "not a row",
    "| 2026-08-09 12:00:00Z | in_progress | Only real row |",
    "",
  ].join("\n");
  assert.deepEqual(parseProgressLog(body), {
    progress_updated_at: "2026-08-09 12:00:00Z",
    status: "in_progress",
    progress_last_row: "Only real row",
  });
});

test("parseProgressLog stops at the next heading after Progress Log", () => {
  const body = [
    "## Progress Log",
    "| 2026-08-09 12:00:00Z | in_progress | In log |",
    "## Notes",
    "| 2026-08-09 13:00:00Z | done | Outside the log |",
    "",
  ].join("\n");
  assert.deepEqual(parseProgressLog(body), {
    progress_updated_at: "2026-08-09 12:00:00Z",
    status: "in_progress",
    progress_last_row: "In log",
  });
});
