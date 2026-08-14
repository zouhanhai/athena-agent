import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KANBAN_SPEC_STATUS_TO_PROJECT_STATUS,
  KANBAN_STATUS_TO_PROJECT_STATUS,
  kanbanSpecStatusToProjectStatus,
  kanbanStatusToProjectStatus,
  projectStatusToKanbanStatus,
} from "../src/kanban/status-map.js";
import { SPEC_STATUSES } from "../src/kanban/schema.js";
import { KANBAN_SPEC_STATUS_OPTIONS, statusFieldOptions } from "../src/kanban/github-sync.js";

test("kanban statuses map to Project Status option names", () => {
  assert.equal(KANBAN_STATUS_TO_PROJECT_STATUS.backlog, "Backlog");
  assert.equal(KANBAN_STATUS_TO_PROJECT_STATUS.in_progress, "In Progress");
  assert.equal(KANBAN_STATUS_TO_PROJECT_STATUS.done, "Done");
  assert.equal(KANBAN_STATUS_TO_PROJECT_STATUS.in_review, "In Review");
  assert.equal(KANBAN_STATUS_TO_PROJECT_STATUS.approved, "Approved");
  assert.equal(KANBAN_STATUS_TO_PROJECT_STATUS.rejected, "Rejected");
  assert.equal(KANBAN_STATUS_TO_PROJECT_STATUS.canceled, "Canceled");
  assert.equal(kanbanStatusToProjectStatus("in_review"), "In Review");
});

test("project Status option names map back to kanban statuses", () => {
  assert.equal(projectStatusToKanbanStatus("Backlog"), "backlog");
  assert.equal(projectStatusToKanbanStatus("In Progress"), "in_progress");
  assert.equal(projectStatusToKanbanStatus("Done"), "done");
  assert.equal(projectStatusToKanbanStatus("In Review"), "in_review");
  assert.equal(projectStatusToKanbanStatus("Approved"), "approved");
  assert.equal(projectStatusToKanbanStatus("Rejected"), "rejected");
  assert.equal(projectStatusToKanbanStatus("Canceled"), "canceled");
});

test("an unknown Project Status option maps to null", () => {
  assert.equal(projectStatusToKanbanStatus("No status"), null);
  assert.equal(projectStatusToKanbanStatus(""), null);
});

test("status mapping round-trips in both directions", () => {
  for (const [kanban, option] of Object.entries(KANBAN_STATUS_TO_PROJECT_STATUS)) {
    assert.equal(kanbanStatusToProjectStatus(kanban as keyof typeof KANBAN_STATUS_TO_PROJECT_STATUS), option);
    assert.equal(projectStatusToKanbanStatus(option), kanban);
  }
});

test("Spec statuses map to Project columns across the full lifecycle (G4.S5.T7, G4.S6.T2)", () => {
  assert.equal(KANBAN_SPEC_STATUS_TO_PROJECT_STATUS.backlog, "Backlog");
  assert.equal(KANBAN_SPEC_STATUS_TO_PROJECT_STATUS.in_progress, "In Progress");
  assert.equal(KANBAN_SPEC_STATUS_TO_PROJECT_STATUS.done, "Done");
  assert.equal(KANBAN_SPEC_STATUS_TO_PROJECT_STATUS.in_review, "In Review");
  assert.equal(KANBAN_SPEC_STATUS_TO_PROJECT_STATUS.approved, "Approved");
  assert.equal(KANBAN_SPEC_STATUS_TO_PROJECT_STATUS.rejected, "Rejected");
  assert.equal(KANBAN_SPEC_STATUS_TO_PROJECT_STATUS.canceled, "Rejected");
  assert.equal(kanbanSpecStatusToProjectStatus("backlog"), "Backlog");
  assert.equal(kanbanSpecStatusToProjectStatus("in_progress"), "In Progress");
  assert.equal(kanbanSpecStatusToProjectStatus("done"), "Done");
  assert.equal(kanbanSpecStatusToProjectStatus("in_review"), "In Review");
  assert.equal(kanbanSpecStatusToProjectStatus("approved"), "Approved");
  assert.equal(kanbanSpecStatusToProjectStatus("rejected"), "Rejected");
  assert.equal(kanbanSpecStatusToProjectStatus("canceled"), "Rejected");
  // legacy `active` Spec status still maps via the alias (G4.S5.T7 backward compat)
  assert.equal(kanbanSpecStatusToProjectStatus("active"), "In Progress");
});

test("an unknown Spec status maps to null (the card is left untouched) (G4.S5.T6)", () => {
  assert.equal(kanbanSpecStatusToProjectStatus("weird"), null);
  assert.equal(kanbanSpecStatusToProjectStatus(""), null);
});

test("KANBAN_SPEC_STATUS_OPTIONS carries a column for every Spec status (G4.S5.T7)", () => {
  const names = new Set(KANBAN_SPEC_STATUS_OPTIONS.map((o) => o.name));
  for (const status of SPEC_STATUSES) {
    assert.ok(names.has(kanbanSpecStatusToProjectStatus(status)!), `column for ${status}`);
  }
});

test("statusFieldOptions merges ticket + Spec Status options without duplicates (G4.S5.T7)", () => {
  const options = statusFieldOptions();
  const names = options.map((o) => o.name);
  assert.equal(new Set(names).size, names.length, "no duplicate option names");
  for (const column of ["Backlog", "In Progress", "Done", "In Review", "Approved", "Rejected", "Canceled"]) {
    assert.ok(names.includes(column), `status options include ${column}`);
  }
});
