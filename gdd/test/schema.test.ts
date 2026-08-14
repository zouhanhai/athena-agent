import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseGoal,
  parseSpec,
  parseTicket,
  parseBoardFrontmatter,
  TICKET_STATUSES,
  SPEC_STATUSES,
  LAYERS,
  BoardSchemaError,
  type GoalFrontmatter,
  type SpecFrontmatter,
  type TicketFrontmatter,
} from "../src/kanban/schema.js";
import { parseFrontmatter } from "../src/kanban/frontmatter.js";

test("TICKET_STATUSES follows the state machine", () => {
  assert.deepEqual(TICKET_STATUSES, [
    "backlog",
    "in_progress",
    "done",
    "in_review",
    "approved",
    "rejected",
    "canceled",
  ]);
});

test("LAYERS are G / S / T", () => {
  assert.deepEqual(LAYERS, ["G", "S", "T"]);
});

test("SPEC_STATUSES covers the full Spec lifecycle (G4.S5.T7, G4.S6.T2)", () => {
  assert.deepEqual(SPEC_STATUSES, [
    "backlog",
    "in_progress",
    "done",
    "in_review",
    "approved",
    "rejected",
    "canceled",
  ]);
});

test("parseSpec maps the legacy `active` Spec status to in_progress (G4.S5.T7)", () => {
  const fm = parseSpec(
    parseFrontmatter(`---
id: g3_s6
title: "G3.S6: Git-Driven Development"
layer: S
parent: G3
owner: pm
status: active
milestone: M3
acceptance_criteria:
  - "G.S.T board structure defined"
---
`),
  );
  assert.equal(fm.status, "in_progress");
});

test("parseSpec accepts every full-lifecycle Spec status (G4.S5.T7)", () => {
  for (const status of SPEC_STATUSES) {
    const fm = parseSpec(
      parseFrontmatter(`---
id: s1
title: S1
layer: S
parent: G1
owner: pm
status: ${status}
acceptance_criteria:
  - x
---
`),
    );
    assert.equal(fm.status, status, `parseSpec keeps ${status}`);
  }
});

test("parseSpec rejects an unknown Spec status (G4.S5.T7)", () => {
  assert.throws(
    () =>
      parseSpec(
        parseFrontmatter(`---
id: s1
title: S1
layer: S
parent: G1
owner: pm
status: nope
acceptance_criteria:
  - x
---
`),
      ),
    BoardSchemaError,
  );
});

test("parseGoal accepts a valid Goal frontmatter", () => {
  const fm = parseGoal(
    parseFrontmatter(`---
id: g3
title: "G3: Multi-Agent Federation & Team Workbench"
layer: G
owner: consultant
status: active
created_at: 2026-08-07
milestone: M3
acceptance_criteria:
  - "Global Chat panel"
  - "Agent Registry"
---
`),
  );
  assert.equal(fm.layer, "G");
  assert.equal(fm.parent, undefined);
  assert.equal(fm.created_at, "2026-08-07");
  assert.equal(fm.milestone, "M3");
  assert.deepEqual(fm.acceptance_criteria, ["Global Chat panel", "Agent Registry"]);
});

test("parseGoal rejects a missing layer", () => {
  assert.throws(
    () => parseGoal(parseFrontmatter("---\nid: g3\ntitle: G3\n---\n")),
    BoardSchemaError,
  );
});

test("parseGoal rejects a wrong layer", () => {
  assert.throws(
    () => parseGoal(parseFrontmatter("---\nid: g3\ntitle: G3\nlayer: T\n---\n")),
    BoardSchemaError,
  );
});

test("parseSpec accepts a valid Spec frontmatter", () => {
  const fm = parseSpec(
    parseFrontmatter(`---
id: g3_s6
title: "G3.S6: Git-Driven Development"
layer: S
parent: G3
owner: pm
status: active
milestone: M3
acceptance_criteria:
  - "G.S.T board structure defined"
---
`),
  );
  assert.equal(fm.layer, "S");
  assert.equal(fm.parent, "G3");
  assert.equal(fm.milestone, "M3");
});

test("parseSpec requires a parent", () => {
  assert.throws(
    () => parseSpec(parseFrontmatter("---\nid: g3_s6\ntitle: S6\nlayer: S\nowner: pm\nstatus: active\nacceptance_criteria:\n  - x\n---\n")),
    BoardSchemaError,
  );
});

test("parseTicket accepts a backlog ticket with defaults", () => {
  const fm = parseTicket(
    parseFrontmatter(`---
id: t1
title: "G3.S6.T1: board structure + md helpers"
layer: T
parent: G3.S6
owner: eng-director
status: backlog
assignee: ""
started_at: ""
blocked_by: []
acceptance_criteria:
  - "schema defined"
---
`),
  );
  assert.equal(fm.layer, "T");
  assert.equal(fm.parent, "G3.S6");
  assert.equal(fm.status, "backlog");
  assert.equal(fm.assignee, "");
  assert.deepEqual(fm.blocked_by, []);
  assert.equal(fm.session_id, undefined);
});

test("parseTicket accepts a claimed ticket with session_id", () => {
  const fm = parseTicket(
    parseFrontmatter(`---
id: t1
title: "G3.S6.T1"
layer: T
parent: G3.S6
owner: eng-director
status: in_progress
assignee: opencode
session_id: ses_44ab85fcdceaf106
started_at: 2026-08-08
blocked_by: []
acceptance_criteria:
  - "schema defined"
---
`),
  );
  assert.equal(fm.status, "in_progress");
  assert.equal(fm.assignee, "opencode");
  assert.equal(fm.session_id, "ses_44ab85fcdceaf106");
  assert.equal(fm.started_at, "2026-08-08");
});

test("parseTicket accepts a done ticket with completed_at / pr / branch", () => {
  const fm = parseTicket(
    parseFrontmatter(`---
id: t1
title: "G3.S6.T1"
layer: T
parent: G3.S6
owner: eng-director
status: done
assignee: opencode
session_id: ses_44ab85fcdceaf106
started_at: 2026-08-08
completed_at: 2026-08-08
blocked_by: []
acceptance_criteria:
  - "schema defined"
pr: 12
branch: feat/t1-board
---
`),
  );
  assert.equal(fm.status, "done");
  assert.equal(fm.completed_at, "2026-08-08");
  assert.equal(fm.pr, 12);
  assert.equal(fm.branch, "feat/t1-board");
});

test("parseTicket accepts a rejected ticket with parent_id / qa_feedback / reopen_reason", () => {
  const fm = parseTicket(
    parseFrontmatter(`---
id: t1.1
title: "G3.S6.T1.1"
layer: T
parent: G3.S6
owner: eng-director
status: backlog
assignee: ""
started_at: ""
blocked_by: []
acceptance_criteria:
  - "schema defined"
parent_id: t1
qa_feedback: "ac fails"
reopen_reason: "rework"
---
`),
  );
  assert.equal(fm.parent_id, "t1");
  assert.equal(fm.qa_feedback, "ac fails");
  assert.equal(fm.reopen_reason, "rework");
});

test("parseTicket rejects an invalid status", () => {
  assert.throws(
    () =>
      parseTicket(
        parseFrontmatter(`---
id: t1
title: T1
layer: T
parent: G3.S6
owner: eng-director
status: nope
assignee: ""
blocked_by: []
acceptance_criteria:
  - "x"
---
`),
      ),
    BoardSchemaError,
  );
});

test("parseTicket requires parent / assignee / blocked_by / acceptance_criteria", () => {
  assert.throws(
    () => parseTicket(parseFrontmatter("---\nid: t1\ntitle: T1\nlayer: T\n---\n")),
    BoardSchemaError,
  );
  assert.throws(
    () =>
      parseTicket(
        parseFrontmatter("---\nid: t1\ntitle: T1\nlayer: T\nparent: G3.S6\nassignee: x\n---\n"),
      ),
    BoardSchemaError,
  );
});

test("parseBoardFrontmatter dispatches by layer", () => {
  const goal = parseBoardFrontmatter(
    parseFrontmatter("---\nid: g1\ntitle: G1\nlayer: G\nowner: c\nstatus: active\nacceptance_criteria:\n  - x\n---\n"),
  );
  assert.equal(goal.layer, "G");
  const spec = parseBoardFrontmatter(
    parseFrontmatter("---\nid: s1\ntitle: S1\nlayer: S\nparent: G1\nowner: pm\nstatus: active\nacceptance_criteria:\n  - x\n---\n"),
  );
  assert.equal(spec.layer, "S");
  const ticket = parseBoardFrontmatter(
    parseFrontmatter("---\nid: t1\ntitle: T1\nlayer: T\nparent: G1.S1\nowner: ed\nstatus: backlog\nassignee: \"\"\nblocked_by: []\nacceptance_criteria:\n  - x\n---\n"),
  );
  assert.equal(ticket.layer, "T");
});

test("parseBoardFrontmatter throws on an unknown layer", () => {
  assert.throws(
    () => parseBoardFrontmatter(parseFrontmatter("---\nid: x\ntitle: X\nlayer: Z\n---\n")),
    BoardSchemaError,
  );
});

test("the parsed Goal/Spec/Ticket types carry the right shape", () => {
  const goal: GoalFrontmatter = {
    id: "g1",
    title: "G1",
    layer: "G",
    owner: "c",
    status: "active",
    acceptance_criteria: [],
  };
  const spec: SpecFrontmatter = {
    id: "s1",
    title: "S1",
    layer: "S",
    parent: "G1",
    owner: "pm",
    status: "in_progress",
    acceptance_criteria: [],
  };
  const ticket: TicketFrontmatter = {
    id: "t1",
    title: "T1",
    layer: "T",
    parent: "G1.S1",
    owner: "ed",
    status: "backlog",
    assignee: "",
    blocked_by: [],
    acceptance_criteria: [],
  };
  assert.equal(goal.layer, "G");
  assert.equal(spec.layer, "S");
  assert.equal(ticket.layer, "T");
});
