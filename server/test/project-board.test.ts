import { test } from "node:test";
import assert from "node:assert/strict";
import type { GithubIssue, GithubProject, GithubProjectItem } from "../src/github/client.js";
import {
  buildGithubProjectBoard,
  subIssuesForSpec,
  subTaskProgress,
} from "../src/github/project-board.js";

test("subTaskProgress counts a Spec's closed sub-issues over its total (G4.S5.T6)", () => {
  const issues: GithubIssue[] = [
    { id: 1, node_id: "i1", number: 2, title: "G4.S5.T1", state: "closed", html_url: "", user_login: "a", body: null, labels: [], assignees: [] },
    { id: 2, node_id: "i2", number: 3, title: "G4.S5.T2", state: "open", html_url: "", user_login: "a", body: null, labels: [], assignees: [] },
    { id: 3, node_id: "i3", number: 4, title: "G4.S5.T3", state: "closed", html_url: "", user_login: "a", body: null, labels: [], assignees: [] },
    // Not a sub-issue of G4.S5: a sibling spec's ticket + the spec issue itself.
    { id: 4, node_id: "i4", number: 5, title: "G4.S5.T10", state: "closed", html_url: "", user_login: "a", body: null, labels: [], assignees: [] },
    { id: 5, node_id: "i5", number: 6, title: "G4.S5 Workbench", state: "open", html_url: "", user_login: "a", body: null, labels: [], assignees: [] },
    { id: 6, node_id: "i6", number: 7, title: "G4.S6.T1", state: "closed", html_url: "", user_login: "a", body: null, labels: [], assignees: [] },
  ];
  // G4.S5 sub-issues: T1/T3/T10 closed, T2 open → 3/4 = 75%. The spec issue
  // itself ("G4.S5 Workbench") and a sibling spec's ticket (G4.S6.T1) don't count.
  assert.deepEqual(subTaskProgress("G4.S5", issues), { done: 3, total: 4, percent: 75 });
  assert.deepEqual(subTaskProgress("G4.S6", issues), { done: 1, total: 1, percent: 100 });
  assert.deepEqual(subTaskProgress("G4.S9", issues), { done: 0, total: 0, percent: 0 });
  assert.deepEqual(subTaskProgress(null, issues), { done: 0, total: 0, percent: 0 });
});

// ---------------------------------------------------------------------------
// G4.S5.T8 — Spec card sub-issues (detail panel list)
// ---------------------------------------------------------------------------

function tIssue(id: number, number: number, title: string, state: string): GithubIssue {
  return { id, node_id: `I_${number}`, number, title, state, html_url: "", user_login: "alice", body: null, labels: [], assignees: [] };
}

test("subIssuesForSpec lists a Spec's ticket sub-issues (ref/title/status/number) (G4.S5.T8)", () => {
  const issues: GithubIssue[] = [
    tIssue(1, 2, "G4.S5.T1 GitHub GraphQL client", "closed"),
    tIssue(2, 3, "G4.S5.T2 md→GitHub projection", "open"),
    tIssue(3, 4, "G4.S5.T3 Feedback loop", "open"),
    tIssue(4, 5, "G4.S5.T10 Workbench", "open"),
    // The Spec issue itself + a sibling spec's ticket are NOT sub-issues.
    tIssue(5, 6, "G4.S5 Workbench", "open"),
    tIssue(6, 7, "G4.S6.T1 KB lifecycle", "closed"),
  ];
  // closed → status "done"; sorted by ref so T1..T10 read in order.
  assert.deepEqual(subIssuesForSpec("G4.S5", issues), [
    { ref: "G4.S5.T1", title: "G4.S5.T1 GitHub GraphQL client", status: "done", number: 2 },
    { ref: "G4.S5.T2", title: "G4.S5.T2 md→GitHub projection", status: "open", number: 3 },
    { ref: "G4.S5.T3", title: "G4.S5.T3 Feedback loop", status: "open", number: 4 },
    { ref: "G4.S5.T10", title: "G4.S5.T10 Workbench", status: "open", number: 5 },
  ]);
  assert.deepEqual(subIssuesForSpec(null, issues), []);
  assert.deepEqual(subIssuesForSpec("G4.S9", issues), []);
});

test("buildGithubProjectBoard populates progress + subIssues for ANY card whose issue is a parent of sub-issues (non-Gx.Sy) (G4.S5.T18)", () => {
  const project: GithubProject = {
    id: "PVT_abap",
    title: "Abaplorer Project",
    number: 9,
    url: "https://github.com/orgs/caleo/projects/9",
  };
  const items: GithubProjectItem[] = [
    // abaplorer #201 'ABAP Object Import' — plain title, NO Gx.Sy ref, but the
    // parent of 9 sub-issues (#202-#210). T18: it must show progress + the list.
    { id: "PVTI_201", issueId: "I_201", issueNumber: 201, title: "ABAP Object Import", status: "Done" },
    // A sub-issue card (#202) is on the board too — it must stay plain.
    { id: "PVTI_202", issueId: "I_202", issueNumber: 202, title: "Import tables", status: "Done" },
  ];
  const sub = (id: number, number: number, title: string, state: string): GithubIssue => ({
    id,
    node_id: `I_${number}`,
    number,
    title,
    state,
    html_url: "",
    user_login: "alice",
    body: null,
    labels: [],
    assignees: [],
    // GitHub sub-issues relationship: each sub-issue's parent_issue_url → #201.
    parent_issue_url: "https://api.github.com/repos/caleo/abaplorer/issues/201",
  });
  const issues: GithubIssue[] = [
    { id: 201, node_id: "I_201", number: 201, title: "ABAP Object Import", state: "open", html_url: "", user_login: "alice", body: null, labels: [], assignees: [] },
    sub(202, 202, "Import tables", "closed"),
    sub(203, 203, "Import BADI", "closed"),
    sub(204, 204, "Import user-exits", "open"),
  ];
  const board = buildGithubProjectBoard(
    project,
    items,
    issues,
    (n) => `https://github.com/caleo/abaplorer/issues/${n}`,
  );
  const card = board.columns[0].cards[0];
  assert.equal(card.ref, null, "no Gx.Sy ref parsed from a plain parent title");
  assert.equal(card.title, "ABAP Object Import");
  // Progress from the ACTUAL sub-issues (2 closed / 3 total) regardless of naming.
  assert.deepEqual(card.progress, { done: 2, total: 3, percent: 67 });
  assert.deepEqual(card.subIssues, [
    { ref: null, title: "Import tables", status: "done", number: 202 },
    { ref: null, title: "Import BADI", status: "done", number: 203 },
    { ref: null, title: "Import user-exits", status: "open", number: 204 },
  ]);
  // The sub-issue card (#202) is plain: no progress, no nested sub-issues.
  const subCard = board.columns[0].cards[1];
  assert.equal(subCard.ref, null);
  assert.deepEqual(subCard.progress, { done: 0, total: 0, percent: 0 });
  assert.deepEqual(subCard.subIssues, []);
});

test("buildGithubProjectBoard carries each Spec card's subIssues + renders ticket cards spread across columns (G4.S5.T8/T9)", () => {
  const project: GithubProject = { id: "PVT_1", title: "athena-agent", number: 3, url: "" };
  const items: GithubProjectItem[] = [
    { id: "PVTI_1", issueId: "I_1", issueNumber: 1, title: "G4.S5 Workbench", status: "Backlog" },
    // T9 (revert T6): a ticket item IS a card now — it lands in its own Status column.
    { id: "PVTI_2", issueId: "I_2", issueNumber: 2, title: "G4.S5.T1", status: "Done" },
  ];
  const issues: GithubIssue[] = [
    tIssue(1, 2, "G4.S5.T1 GitHub GraphQL client", "closed"),
    tIssue(2, 3, "G4.S5.T2 md→GitHub projection", "open"),
    tIssue(3, 4, "G4.S5.T3 Feedback loop", "open"),
  ];
  const board = buildGithubProjectBoard(
    project,
    items,
    issues,
    (n) => `https://github.com/zouhanhai/athena-agent/issues/${n}`,
  );
  // The Spec card sits in Backlog; the ticket sub-issue card in its Done column.
  assert.deepEqual(
    board.columns.map((c) => c.cards.map((card) => card.ref)),
    [["G4.S5"], ["G4.S5.T1"]],
  );
  const card = board.columns[0].cards[0];
  assert.equal(card.ref, "G4.S5");
  assert.deepEqual(card.subIssues, [
    { ref: "G4.S5.T1", title: "G4.S5.T1 GitHub GraphQL client", status: "done", number: 2 },
    { ref: "G4.S5.T2", title: "G4.S5.T2 md→GitHub projection", status: "open", number: 3 },
    { ref: "G4.S5.T3", title: "G4.S5.T3 Feedback loop", status: "open", number: 4 },
  ]);
  // The ticket card is plain: no sub-task progress, no nested sub-issues.
  const ticket = board.columns[1].cards[0];
  assert.equal(ticket.ref, "G4.S5.T1");
  assert.equal(ticket.status, "Done");
  assert.deepEqual(ticket.progress, { done: 0, total: 0, percent: 0 });
  assert.deepEqual(ticket.subIssues, []);
});
