import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PLANNING_OWNER,
  PlanningError,
  buildGoal,
  buildSpec,
  buildTicket,
  nextGoalRef,
  nextSpecRef,
  nextTicketRef,
  planGoal,
  validateGoalDraft,
  validatePlan,
  validateSpecDraft,
  validateTicketDraft,
  writeGoal,
  writeSpec,
  writeTicket,
  writeTickets,
  type GoalDraft,
  type PlanInput,
  type SpecDraft,
  type TicketDraft,
} from "../src/kanban/planning.js";
import { parseBoardFile, readBoardFile } from "../src/kanban/board.js";
import { renderBoardMd } from "../src/kanban/frontmatter.js";
import { scanBoard } from "../src/kanban/scan.js";

async function tempRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "kanban-plan-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const GOAL: GoalDraft = {
  title: "Test Goal",
  context: "grill output",
  milestone: "M3",
  acceptance_criteria: ["acceptance is clear"],
};

const SPEC: SpecDraft = {
  title: "Test Spec",
  task: "to-spec output",
  milestone: "M3",
  acceptance_criteria: ["spec is clear"],
};

const TICKET: TicketDraft = {
  title: "Test Ticket",
  task: "to-ticket output",
  acceptance_criteria: ["ticket is clear"],
};

test("buildGoal produces a valid Goal document with consultant as owner", () => {
  const doc = buildGoal("G4", GOAL);
  assert.equal(doc.frontmatter.layer, "G");
  assert.equal(doc.frontmatter.id, "g4");
  assert.equal(doc.frontmatter.title, "G4: Test Goal");
  assert.equal(doc.frontmatter.owner, PLANNING_OWNER.goal);
  assert.equal(doc.frontmatter.status, "active");
  assert.equal(doc.frontmatter.milestone, "M3");
  assert.deepEqual(doc.frontmatter.acceptance_criteria, ["acceptance is clear"]);
  assert.match(doc.body, /## Background/);
  const reparse = parseBoardFile(renderBoardMd({ ...doc.frontmatter }, doc.body));
  assert.equal(reparse.frontmatter.layer, "G");
});

test("buildGoal honors an explicit owner override", () => {
  const doc = buildGoal("G4", { ...GOAL, owner: "consultant.alice" });
  assert.equal(doc.frontmatter.owner, "consultant.alice");
});

test("buildSpec produces a valid Spec document with pm as owner and parent goal", () => {
  const doc = buildSpec("G4.S1", SPEC);
  assert.equal(doc.frontmatter.layer, "S");
  assert.equal(doc.frontmatter.id, "g4_s1");
  assert.equal(doc.frontmatter.title, "G4.S1: Test Spec");
  assert.equal(doc.frontmatter.parent, "G4");
  assert.equal(doc.frontmatter.owner, PLANNING_OWNER.spec);
  assert.deepEqual(doc.frontmatter.acceptance_criteria, ["spec is clear"]);
  assert.match(doc.body, /## Task/);
  const reparse = parseBoardFile(renderBoardMd({ ...doc.frontmatter }, doc.body));
  assert.equal(reparse.frontmatter.layer, "S");
});

test("buildTicket produces a backlog Ticket with eng-director owner and parent spec", () => {
  const doc = buildTicket("G4.S1.T1", TICKET);
  assert.equal(doc.frontmatter.layer, "T");
  assert.equal(doc.frontmatter.id, "t1");
  assert.equal(doc.frontmatter.title, "G4.S1.T1: Test Ticket");
  assert.equal(doc.frontmatter.parent, "G4.S1");
  assert.equal(doc.frontmatter.owner, PLANNING_OWNER.ticket);
  assert.equal(doc.frontmatter.status, "backlog");
  assert.equal(doc.frontmatter.assignee, "");
  assert.deepEqual(doc.frontmatter.blocked_by, []);
  assert.deepEqual(doc.frontmatter.acceptance_criteria, ["ticket is clear"]);
  const reparse = parseBoardFile(renderBoardMd({ ...doc.frontmatter }, doc.body));
  assert.equal(reparse.frontmatter.layer, "T");
});

test("omitted optional fields do not leak undefined into the written md", async () => {
  const { root, cleanup } = await tempRoot();
  try {
    await writeGoal(root, "G4", { title: "No meta", acceptance_criteria: ["a"] });
    const content = await readFile(path.join(root, "G4", "Goal.md"), "utf8");
    assert.ok(!content.includes("undefined"));
    assert.ok(!content.includes("milestone"));
    assert.ok(!content.includes("created_at"));
  } finally {
    await cleanup();
  }
});

test("writeGoal writes Goal.md at the ref path and it round-trips", async () => {
  const { root, cleanup } = await tempRoot();
  try {
    const file = await writeGoal(root, "G4", GOAL);
    assert.equal(file, path.join(root, "G4", "Goal.md"));
    const doc = await readBoardFile(root, "G4");
    assert.equal(doc.frontmatter.layer, "G");
    assert.equal(doc.frontmatter.owner, "consultant");
  } finally {
    await cleanup();
  }
});

test("writeSpec writes Spec.md under the goal", async () => {
  const { root, cleanup } = await tempRoot();
  try {
    const file = await writeSpec(root, "G4.S1", SPEC);
    assert.equal(file, path.join(root, "G4", "S1", "Spec.md"));
    const doc = await readBoardFile(root, "G4.S1");
    assert.equal(doc.frontmatter.parent, "G4");
    assert.equal(doc.frontmatter.owner, "pm");
  } finally {
    await cleanup();
  }
});

test("writeTicket writes a single ticket by ref", async () => {
  const { root, cleanup } = await tempRoot();
  try {
    const file = await writeTicket(root, "G4.S1.T1", TICKET);
    assert.equal(file, path.join(root, "G4", "S1", "T1.md"));
    const doc = await readBoardFile(root, "G4.S1.T1");
    assert.equal(doc.frontmatter.status, "backlog");
    assert.equal(doc.frontmatter.owner, "eng-director");
  } finally {
    await cleanup();
  }
});

test("writeTickets auto-numbers T1..Tn after existing tickets", async () => {
  const { root, cleanup } = await tempRoot();
  try {
    await writeGoal(root, "G4", GOAL);
    await writeSpec(root, "G4.S1", SPEC);
    await writeTicket(root, "G4.S1.T1", TICKET);
    const files = await writeTickets(root, "G4.S1", [TICKET, { ...TICKET, title: "Second" }]);
    assert.deepEqual(files, [
      path.join(root, "G4", "S1", "T2.md"),
      path.join(root, "G4", "S1", "T3.md"),
    ]);
    const board = await scanBoard(root);
    assert.deepEqual(board.goals[0].specs[0].tickets.map((t) => t.ref), ["G4.S1.T1", "G4.S1.T2", "G4.S1.T3"]);
  } finally {
    await cleanup();
  }
});

test("nextGoalRef returns G1 on an empty root and max+1 otherwise", async () => {
  const { root, cleanup } = await tempRoot();
  try {
    assert.equal(await nextGoalRef(root), "G1");
    await writeGoal(root, "G1", GOAL);
    await writeGoal(root, "G3", GOAL);
    assert.equal(await nextGoalRef(root), "G4");
  } finally {
    await cleanup();
  }
});

test("nextSpecRef returns the next S number under a goal", async () => {
  const { root, cleanup } = await tempRoot();
  try {
    await writeGoal(root, "G1", GOAL);
    assert.equal(await nextSpecRef(root, "G1"), "G1.S1");
    await writeSpec(root, "G1.S1", SPEC);
    await writeSpec(root, "G1.S3", SPEC);
    assert.equal(await nextSpecRef(root, "G1"), "G1.S4");
  } finally {
    await cleanup();
  }
});

test("nextTicketRef returns the next T number under a spec", async () => {
  const { root, cleanup } = await tempRoot();
  try {
    assert.equal(await nextTicketRef(root, "G1.S1"), "G1.S1.T1");
    await writeTicket(root, "G1.S1.T1", TICKET);
    await writeTicket(root, "G1.S1.T4", TICKET);
    assert.equal(await nextTicketRef(root, "G1.S1"), "G1.S1.T5");
  } finally {
    await cleanup();
  }
});

test("validateGoalDraft rejects empty title and empty acceptance_criteria", () => {
  assert.deepEqual(validateGoalDraft(GOAL), []);
  assert.ok(validateGoalDraft({ ...GOAL, title: "" }).some((p) => /title/.test(p)));
  assert.ok(validateGoalDraft({ ...GOAL, title: "  " }).some((p) => /title/.test(p)));
  assert.ok(validateGoalDraft({ ...GOAL, acceptance_criteria: [] }).some((p) => /acceptance_criteria/.test(p)));
});

test("validateSpecDraft and validateTicketDraft reject empty criteria", () => {
  assert.deepEqual(validateSpecDraft(SPEC), []);
  assert.deepEqual(validateTicketDraft(TICKET), []);
  assert.ok(validateSpecDraft({ ...SPEC, acceptance_criteria: [] }).some((p) => /acceptance_criteria/.test(p)));
  assert.ok(validateTicketDraft({ ...TICKET, acceptance_criteria: [] }).some((p) => /acceptance_criteria/.test(p)));
});

test("validatePlan rejects refs that do not sit under their parent layer", () => {
  const plan = {
    goalRef: "G4",
    goal: GOAL,
    specs: [
      { specRef: "G5.S1", spec: SPEC, tickets: [] },
      {
        specRef: "G4.S1",
        spec: SPEC,
        tickets: [{ ticketRef: "G4.S2.T1", ticket: TICKET }],
      },
    ],
  };
  const problems = validatePlan(plan);
  assert.ok(problems.some((p) => /G5\.S1/.test(p) && /not under G4/.test(p)));
  assert.ok(problems.some((p) => /G4\.S2\.T1/.test(p) && /not under G4\.S1/.test(p)));
});

test("validatePlan surfaces draft-level problems", () => {
  const problems = validatePlan({
    goalRef: "G4",
    goal: { ...GOAL, acceptance_criteria: [] },
    specs: [
      { specRef: "G4.S1", spec: SPEC, tickets: [{ ticketRef: "G4.S1.T1", ticket: { ...TICKET, title: "" } }] },
    ],
  });
  assert.ok(problems.some((p) => /goal/.test(p) && /acceptance_criteria/.test(p)));
  assert.ok(problems.some((p) => /G4\.S1\.T1/.test(p) && /title/.test(p)));
});

test("planGoal produces the three layers: Goal.md, Spec.md, T1..Tn.md", async () => {
  const { root, cleanup } = await tempRoot();
  try {
    const input: PlanInput = {
      goal: GOAL,
      specs: [
        { spec: SPEC, tickets: [TICKET, { ...TICKET, title: "Second ticket" }] },
        { spec: { ...SPEC, title: "Empty spec" }, tickets: [] },
      ],
    };
    const result = await planGoal(root, input);
    assert.equal(result.goalRef, "G1");
    assert.deepEqual(result.specs.map((s) => s.specRef), ["G1.S1", "G1.S2"]);
    assert.deepEqual(result.specs[0].ticketRefs, ["G1.S1.T1", "G1.S1.T2"]);
    assert.deepEqual(result.specs[1].ticketRefs, []);

    const board = await scanBoard(root);
    assert.equal(board.errors.length, 0);
    assert.equal(board.goals.length, 1);
    assert.equal(board.goals[0].ref, "G1");
    assert.equal(board.goals[0].goal.owner, "consultant");
    assert.deepEqual(board.goals[0].specs.map((s) => s.ref), ["G1.S1", "G1.S2"]);
    assert.equal(board.goals[0].specs[0].spec.owner, "pm");
    assert.deepEqual(
      board.goals[0].specs[0].tickets.map((t) => t.ref),
      ["G1.S1.T1", "G1.S1.T2"],
    );
    assert.equal(board.goals[0].specs[0].tickets[0].ticket.owner, "eng-director");
    assert.equal(board.goals[0].specs[1].tickets.length, 0);
  } finally {
    await cleanup();
  }
});

test("planGoal allocates the next free G on each run", async () => {
  const { root, cleanup } = await tempRoot();
  try {
    const input: PlanInput = { goal: GOAL, specs: [] };
    const first = await planGoal(root, input);
    assert.equal(first.goalRef, "G1");
    const second = await planGoal(root, input);
    assert.equal(second.goalRef, "G2");
    const board = await scanBoard(root);
    assert.deepEqual(board.goals.map((g) => g.ref), ["G1", "G2"]);
  } finally {
    await cleanup();
  }
});

test("planGoal throws PlanningError on invalid input and writes nothing", async () => {
  const { root, cleanup } = await tempRoot();
  try {
    await assert.rejects(
      () =>
        planGoal(root, {
          goal: { ...GOAL, acceptance_criteria: [] },
          specs: [],
        }),
      PlanningError,
    );
    const board = await scanBoard(root);
    assert.equal(board.goals.length, 0);
  } finally {
    await cleanup();
  }
});
