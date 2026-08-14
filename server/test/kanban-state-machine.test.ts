import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STATE_MACHINE,
  SPEC_STATE_MACHINE,
  TRANSITION_ACTOR,
  SPEC_TRANSITION_ACTOR,
  canTransition,
  transitionsFrom,
  transitionsTo,
  transitionId,
  actorFor,
  TICKET_STATUSES,
  SPEC_STATUSES,
  type TicketStatus,
  type SpecStatus,
  type TransitionId,
  type SpecTransitionId,
} from "../src/kanban/index.js";

test("state machine covers the full lifecycle with the reject branch", () => {
  assert.equal(canTransition("backlog", "in_progress"), true);
  assert.equal(canTransition("in_progress", "done"), true);
  assert.equal(canTransition("in_progress", "in_review"), true);
  assert.equal(canTransition("done", "in_review"), true);
  assert.equal(canTransition("in_review", "approved"), true);
  assert.equal(canTransition("in_review", "rejected"), true);
});

test("approved and rejected are terminal states; illegal edges are refused", () => {
  assert.deepEqual(transitionsFrom("approved"), []);
  assert.deepEqual(transitionsFrom("rejected"), []);
  assert.equal(canTransition("rejected", "backlog"), false);
  assert.equal(canTransition("rejected", "in_progress"), false);
  assert.equal(canTransition("done", "approved"), false);
  assert.equal(canTransition("done", "done"), false);
  assert.equal(canTransition("in_progress", "approved"), false);
  assert.equal(canTransition("in_progress", "backlog"), false);
  assert.equal(canTransition("backlog", "done"), false);
});

test("transitionsTo is the inverse: which from-states can reach a target", () => {
  assert.deepEqual(transitionsTo("in_progress"), ["backlog"]);
  assert.deepEqual(transitionsTo("done"), ["in_progress"]);
  assert.deepEqual(transitionsTo("in_review"), ["in_progress", "done"]);
  assert.deepEqual(transitionsTo("approved"), ["in_review"]);
  assert.deepEqual(transitionsTo("rejected"), ["in_review"]);
});

test("every from/to state in the table is a known ticket status", () => {
  for (const from of TICKET_STATUSES) {
    assert.ok(STATE_MACHINE[from], `STATE_MACHINE has an entry for ${from}`);
    for (const to of STATE_MACHINE[from]) {
      assert.ok(TICKET_STATUSES.includes(to), `${from} → ${to} is a known status`);
    }
  }
});

test("transitionId names every edge of the machine", () => {
  assert.equal(transitionId("backlog", "in_progress"), "claim");
  assert.equal(transitionId("in_progress", "done"), "report-done");
  assert.equal(transitionId("in_progress", "in_review"), "report-in_review");
  assert.equal(transitionId("done", "in_review"), "report-in_review");
  assert.equal(transitionId("in_review", "approved"), "approve");
  assert.equal(transitionId("in_review", "rejected"), "reject");
  assert.equal(transitionId("done", "approved"), null);
  assert.equal(transitionId("rejected", "backlog"), null);
});

test("each transition is performed by the correct soul role", () => {
  assert.equal(actorFor("backlog", "in_progress"), "worker");
  assert.equal(actorFor("in_progress", "done"), "worker");
  assert.equal(actorFor("in_progress", "in_review"), "worker");
  assert.equal(actorFor("done", "in_review"), "worker");
  assert.equal(actorFor("in_review", "approved"), "reviewer");
  assert.equal(actorFor("in_review", "rejected"), "reviewer");
  assert.equal(actorFor("done", "approved"), null);
});

test("TRANSITION_ACTOR covers every transition id with a defined role", () => {
  const ids: readonly TransitionId[] = [
    "claim",
    "report-done",
    "report-in_review",
    "approve",
    "reject",
  ];
  for (const id of ids) {
    assert.ok(id in TRANSITION_ACTOR, `TRANSITION_ACTOR has ${id}`);
  }
  for (const id of Object.keys(TRANSITION_ACTOR) as TransitionId[]) {
    assert.ok(ids.includes(id), `${id} is a known transition`);
  }
});

test("the reject branch is the only path out of review, and re-decompose re-enters via backlog", () => {
  // rejected has no outgoing transitions on the same ticket
  assert.deepEqual(transitionsFrom("rejected"), []);
  // but a re-decompose produces a brand-new backlog ticket (covered by lifecycle)
  assert.ok(canTransition("backlog", "in_progress"));
  // and the review verdict is binary: approve or reject
  const review = transitionsFrom("in_review") as TicketStatus[];
  assert.deepEqual(review, ["approved", "rejected"]);
});

// ---------------------------------------------------------------------------
// G4.S5.T7 / G4.S6.T2 — Spec state machine (backlog → in_progress → done →
// in_review → approved/rejected; rejected → re-decompose; canceled terminal).
// `decomposed` removed (G4.S6.T2); backlog → in_progress is ticket-driven.
// ---------------------------------------------------------------------------

test("Spec lifecycle chain backlog→in_progress→done→in_review→approved; in_review→rejected (G4.S5.T7)", () => {
  const chain: [SpecStatus, SpecStatus][] = [
    ["backlog", "in_progress"],
    ["in_progress", "done"],
    ["done", "in_review"],
    ["in_review", "approved"],
  ];
  for (const [from, to] of chain) {
    assert.equal(canTransition(from, to, "spec"), true, `${from} → ${to}`);
  }
  assert.equal(canTransition("in_review", "rejected", "spec"), true);
});

test("Spec machine: backlog→in_progress direct + re-decompose (G4.S6.T2, no decomposed)", () => {
  assert.equal(canTransition("backlog", "in_progress", "spec"), true);
  assert.equal(canTransition("rejected", "backlog", "spec"), true);
  assert.equal(canTransition("rejected", "in_progress", "spec"), true);
});

test("Spec illegal edges are refused; approved/canceled are terminal (G4.S5.T7)", () => {
  assert.equal(canTransition("in_progress", "in_review", "spec"), false);
  assert.equal(canTransition("backlog", "done", "spec"), false);
  assert.equal(canTransition("in_progress", "in_progress", "spec"), false);
  assert.equal(canTransition("approved", "backlog", "spec"), false);
  assert.equal(canTransition("canceled", "backlog", "spec"), false);
  assert.deepEqual(transitionsFrom("approved", "spec"), []);
  assert.deepEqual(transitionsFrom("canceled", "spec"), []);
});

test("Spec transitionsFrom/transitionsTo follow the lifecycle (G4.S6.T2)", () => {
  assert.deepEqual(transitionsFrom("backlog", "spec"), ["in_progress"]);
  assert.deepEqual(transitionsFrom("in_progress", "spec"), ["done"]);
  assert.deepEqual(transitionsFrom("in_review", "spec"), ["approved", "rejected"]);
  assert.deepEqual(transitionsFrom("rejected", "spec"), ["backlog", "in_progress"]);
  assert.deepEqual(transitionsTo("in_progress", "spec"), ["backlog", "rejected"]);
  assert.deepEqual(transitionsTo("done", "spec"), ["in_progress"]);
  assert.deepEqual(transitionsTo("in_review", "spec"), ["done"]);
  assert.deepEqual(transitionsTo("approved", "spec"), ["in_review"]);
  assert.deepEqual(transitionsTo("rejected", "spec"), ["in_review"]);
});

test("every Spec machine state is a known Spec status (G4.S5.T7)", () => {
  for (const from of SPEC_STATUSES) {
    assert.ok(SPEC_STATE_MACHINE[from], `SPEC_STATE_MACHINE has an entry for ${from}`);
    for (const to of SPEC_STATE_MACHINE[from]) {
      assert.ok(SPEC_STATUSES.includes(to), `${from} → ${to} is a known status`);
    }
  }
});

test("Spec transitionId names every edge; plan agent/reviewer actors (G4.S6.T2)", () => {
  assert.equal(transitionId("backlog", "in_progress", "spec"), "start");
  assert.equal(transitionId("in_progress", "done", "spec"), "report-done");
  assert.equal(transitionId("done", "in_review", "spec"), "report-in_review");
  assert.equal(transitionId("in_review", "approved", "spec"), "approve");
  assert.equal(transitionId("in_review", "rejected", "spec"), "reject");
  assert.equal(transitionId("rejected", "backlog", "spec"), "re-decompose");
  assert.equal(transitionId("rejected", "in_progress", "spec"), "re-decompose");
  assert.equal(transitionId("approved", "backlog", "spec"), null);
  // Review verdicts are the Reviewer's; start/report/re-decompose are Eng Director.
  assert.equal(actorFor("backlog", "in_progress", "spec"), "eng-director");
  assert.equal(actorFor("rejected", "in_progress", "spec"), "eng-director");
  assert.equal(actorFor("in_review", "approved", "spec"), "reviewer");
  assert.equal(actorFor("in_review", "rejected", "spec"), "reviewer");
  assert.equal(actorFor("done", "approved", "spec"), null);
});

test("SPEC_TRANSITION_ACTOR covers every Spec transition id with a defined role (G4.S5.T7)", () => {
  const ids: readonly SpecTransitionId[] = [
    "start",
    "report-done",
    "report-in_review",
    "approve",
    "reject",
    "re-decompose",
  ];
  for (const id of ids) {
    assert.ok(id in SPEC_TRANSITION_ACTOR, `SPEC_TRANSITION_ACTOR has ${id}`);
  }
  for (const id of Object.keys(SPEC_TRANSITION_ACTOR) as SpecTransitionId[]) {
    assert.ok(ids.includes(id), `${id} is a known Spec transition`);
  }
});
