import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderBoardMd } from "../src/kanban/frontmatter.js";
import { refToPath } from "../src/kanban/board.js";
import {
  scanBoard,
  scanRemoteBoard,
  defaultBoardRoot,
  type KanbanBoard,
  type RemoteBoardSource,
} from "../src/kanban/scan.js";
import type { GithubFileContent, GithubTreeEntry } from "../src/github/client.js";
import type { GithubCredential } from "../src/employees/employees.js";

/** Write a board document at its ref-derived path under root. */
async function writeDoc(
  root: string,
  ref: string,
  frontmatter: Record<string, unknown>,
  body = "# body\n",
): Promise<void> {
  const filePath = refToPath(ref, root);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, renderBoardMd(frontmatter, body), "utf8");
}

function goalFm(ref: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ref.toLowerCase(),
    title: `${ref}: goal`,
    layer: "G",
    owner: "consultant",
    status: "active",
    milestone: "M3",
    acceptance_criteria: ["done"],
    ...over,
  };
}

function specFm(ref: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ref.toLowerCase(),
    title: `${ref}: spec`,
    layer: "S",
    parent: ref.split(".")[0],
    owner: "pm",
    status: "active",
    milestone: "M3",
    acceptance_criteria: ["done"],
    ...over,
  };
}

function ticketFm(ref: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ref.toLowerCase(),
    title: `${ref}: ticket`,
    layer: "T",
    parent: ref.split(".").slice(0, 2).join("."),
    owner: "eng-director",
    status: "backlog",
    assignee: "",
    blocked_by: [],
    acceptance_criteria: ["done"],
    ...over,
  };
}

async function tempBoard(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "kanban-scan-"));
}

test("scanBoard returns an empty board for an empty root", async () => {
  const root = await tempBoard();
  try {
    assert.deepEqual(await scanBoard(root), { goals: [], errors: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scanBoard constructs goals/specs/tickets with statuses", async () => {
  const root = await tempBoard();
  try {
    await writeDoc(root, "G1", goalFm("G1"));
    await writeDoc(root, "G1.S1", specFm("G1.S1"));
    await writeDoc(root, "G1.S1.T1", ticketFm("G1.S1.T1", { status: "done" }));
    await writeDoc(root, "G1.S1.T2", ticketFm("G1.S1.T2", { status: "in_progress" }));

    const board: KanbanBoard = await scanBoard(root);
    assert.equal(board.errors.length, 0);
    assert.equal(board.goals.length, 1);

    const goal = board.goals[0];
    assert.equal(goal.ref, "G1");
    assert.equal(goal.goal.status, "active");
    assert.equal(goal.goal.milestone, "M3");

    const spec = goal.specs[0];
    assert.equal(spec.ref, "G1.S1");
    assert.equal(spec.spec.parent, "G1");

    assert.equal(spec.tickets.length, 2);
    assert.equal(spec.tickets[0].ref, "G1.S1.T1");
    assert.equal(spec.tickets[0].ticket.status, "done");
    assert.equal(spec.tickets[1].ref, "G1.S1.T2");
    assert.equal(spec.tickets[1].ticket.status, "in_progress");
    assert.equal(spec.tickets[1].ticket.assignee, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scanBoard sorts goals, specs and tickets numerically", async () => {
  const root = await tempBoard();
  try {
    await writeDoc(root, "G10", goalFm("G10"));
    await writeDoc(root, "G2", goalFm("G2"));
    await writeDoc(root, "G1", goalFm("G1"));
    await writeDoc(root, "G1.S10", specFm("G1.S10"));
    await writeDoc(root, "G1.S2", specFm("G1.S2"));
    await writeDoc(root, "G1.S1", specFm("G1.S1"));
    await writeDoc(root, "G1.S1.T10", ticketFm("G1.S1.T10"));
    await writeDoc(root, "G1.S1.T2", ticketFm("G1.S1.T2"));
    await writeDoc(root, "G1.S1.T1", ticketFm("G1.S1.T1"));

    const board = await scanBoard(root);
    assert.deepEqual(board.goals.map((g) => g.ref), ["G1", "G2", "G10"]);
    assert.deepEqual(board.goals[0].specs.map((s) => s.ref), ["G1.S1", "G1.S2", "G1.S10"]);
    assert.deepEqual(board.goals[0].specs[0].tickets.map((t) => t.ref), ["G1.S1.T1", "G1.S1.T2", "G1.S1.T10"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scanBoard ignores non-goal files and non-board documents", async () => {
  const root = await tempBoard();
  try {
    await writeFile(path.join(root, "README.md"), "# not a board\n");
    await mkdir(path.join(root, "foo"), { recursive: true });
    await writeDoc(root, "G1", goalFm("G1"));
    await writeFile(path.join(root, "G1", "notes.md"), "no frontmatter\n");
    await writeDoc(root, "G1.S1", specFm("G1.S1"));
    await writeFile(path.join(root, "G1", "S1", "misc.txt"), "junk");
    await writeDoc(root, "G1.S1.T1", ticketFm("G1.S1.T1"));

    const board = await scanBoard(root);
    assert.deepEqual(board.goals.map((g) => g.ref), ["G1"]);
    assert.deepEqual(board.goals[0].specs.map((s) => s.ref), ["G1.S1"]);
    assert.deepEqual(board.goals[0].specs[0].tickets.map((t) => t.ref), ["G1.S1.T1"]);
    assert.equal(board.errors.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scanBoard records parse errors but keeps valid items", async () => {
  const root = await tempBoard();
  try {
    await mkdir(path.join(root, "G1"), { recursive: true });
    await writeFile(path.join(root, "G1", "Goal.md"), "# bad goal\n");
    await writeDoc(root, "G2", goalFm("G2"));
    await writeDoc(root, "G2.S1", specFm("G2.S1"));
    await writeDoc(root, "G2.S1.T1", ticketFm("G2.S1.T1", { status: "approved" }));
    await writeFile(
      path.join(root, "G2", "S1", "T2.md"),
      "---\nid: t2\ntitle: bad\nowner: eng\n---\n\nno layer or status\n",
    );

    const board = await scanBoard(root);
    assert.equal(board.goals.length, 1);
    assert.equal(board.goals[0].ref, "G2");
    assert.deepEqual(board.goals[0].specs[0].tickets.map((t) => t.ref), ["G2.S1.T1"]);
    assert.equal(board.errors.length, 2);
    assert.ok(board.errors.some((e) => e.file.endsWith("G1/Goal.md")));
    assert.ok(board.errors.some((e) => e.file.endsWith("T2.md")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scanBoard skips a goal directory that has no Goal.md", async () => {
  const root = await tempBoard();
  try {
    await mkdir(path.join(root, "G9", "S1"), { recursive: true });
    await writeDoc(root, "G9.S1.T1", ticketFm("G9.S1.T1"));
    const board = await scanBoard(root);
    assert.deepEqual(board.goals, []);
    assert.equal(board.errors.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scanBoard parses the live repo board", async () => {
  const board = await scanBoard(defaultBoardRoot());
  assert.ok(board.goals.length >= 3, "live board should have at least G1/G2/G3");

  const g3 = board.goals.find((g) => g.ref === "G3");
  assert.ok(g3, "G3 must be present");
  assert.equal(g3.goal.title, "G3: Multi-Agent Federation & Team Workbench");
  assert.equal(g3.goal.status, "active");

  const s6 = g3.specs.find((s) => s.ref === "G3.S6");
  assert.ok(s6, "G3.S6 must be present");
  const ticketRefs = s6.tickets.map((t) => t.ref);
  assert.ok(ticketRefs.includes("G3.S6.T1"), "T1 should be scanned");
  assert.ok(ticketRefs.includes("G3.S6.T6"), "T6 should be scanned");
  const t1 = s6.tickets.find((t) => t.ref === "G3.S6.T1");
  assert.equal(t1?.ticket.status, "done");
});

class FakeRemoteSource implements RemoteBoardSource {
  readonly fetched: string[] = [];
  readonly treeFetched = 0;
  constructor(
    private readonly tree: GithubTreeEntry[],
    private readonly contents: Record<string, string>,
  ) {}
  async listTree(
    _credential: GithubCredential,
    _owner: string,
    _repo: string,
    _ref?: string,
  ): Promise<GithubTreeEntry[]> {
    return this.tree;
  }
  async getFileContent(
    _credential: GithubCredential,
    _owner: string,
    _repo: string,
    p: string,
    _ref?: string,
  ): Promise<GithubFileContent> {
    this.fetched.push(p);
    const content = this.contents[p];
    if (content === undefined) {
      const err = new Error(`GitHub API error 404: ${p}`);
      Object.assign(err, { status: 404 });
      throw err;
    }
    return { path: p, sha: "sss", size: content.length, content };
  }
}

const CREDENTIAL: GithubCredential = { type: "token", value: "ghp_test" };

function remoteTree(): GithubTreeEntry[] {
  const tree = (
    type: string,
    path: string,
  ): GithubTreeEntry => ({ path, type, mode: "100644", sha: path, size: type === "blob" ? 12 : null });
  return [
    tree("tree", "docs"),
    tree("tree", "docs/kanban"),
    tree("tree", "docs/kanban/G1"),
    tree("blob", "docs/kanban/G1/Goal.md"),
    tree("tree", "docs/kanban/G1/S1"),
    tree("blob", "docs/kanban/G1/S1/Spec.md"),
    tree("blob", "docs/kanban/G1/S1/T1.md"),
    tree("blob", "docs/kanban/G1/S1/T2.md"),
    tree("blob", "README.md"),
  ];
}

function remoteContents(): Record<string, string> {
  return {
    "docs/kanban/G1/Goal.md": renderBoardMd(goalFm("G1"), "# body\n"),
    "docs/kanban/G1/S1/Spec.md": renderBoardMd(specFm("G1.S1"), "# body\n"),
    "docs/kanban/G1/S1/T1.md": renderBoardMd(
      ticketFm("G1.S1.T1", { status: "done", assignee: "opencode", session_id: "ses_remote" }),
      "# body\n",
    ),
    "docs/kanban/G1/S1/T2.md": renderBoardMd(ticketFm("G1.S1.T2", { status: "in_progress", assignee: "bob" }), "# body\n"),
  };
}

test("scanRemoteBoard scans a repo's docs/kanban via GitHub with live ticket status", async () => {
  const source = new FakeRemoteSource(remoteTree(), remoteContents());
  const board = await scanRemoteBoard(source, CREDENTIAL, "acme", "box");

  assert.equal(board.errors.length, 0);
  assert.equal(board.goals.length, 1);
  assert.equal(board.goals[0].ref, "G1");
  assert.equal(board.goals[0].goal.status, "active");

  const spec = board.goals[0].specs[0];
  assert.equal(spec.ref, "G1.S1");
  assert.equal(spec.tickets.length, 2);
  assert.equal(spec.tickets[0].ref, "G1.S1.T1");
  assert.equal(spec.tickets[0].ticket.status, "done");
  assert.equal(spec.tickets[0].ticket.assignee, "opencode");
  assert.equal(spec.tickets[0].ticket.session_id, "ses_remote");
  assert.equal(spec.tickets[1].ref, "G1.S1.T2");
  assert.equal(spec.tickets[1].ticket.status, "in_progress");

  const expected = [
    "docs/kanban/G1/Goal.md",
    "docs/kanban/G1/S1/Spec.md",
    "docs/kanban/G1/S1/T1.md",
    "docs/kanban/G1/S1/T2.md",
  ];
  assert.deepEqual([...source.fetched].sort(), expected);
});

test("scanRemoteBoard records parse errors but keeps valid items", async () => {
  const contents = remoteContents();
  contents["docs/kanban/G1/S1/T2.md"] = "---\nid: t2\ntitle: bad\nowner: eng\n---\n\nno status\n";
  const source = new FakeRemoteSource(remoteTree(), contents);
  const board = await scanRemoteBoard(source, CREDENTIAL, "acme", "box");

  assert.equal(board.goals[0].ref, "G1");
  assert.deepEqual(board.goals[0].specs[0].tickets.map((t) => t.ref), ["G1.S1.T1"]);
  assert.equal(board.errors.length, 1);
  assert.ok(board.errors[0].file.endsWith("T2.md"));
});

test("scanRemoteBoard sorts goals, specs and tickets numerically", async () => {
  const tree = (
    type: string,
    path: string,
  ): GithubTreeEntry => ({ path, type, mode: "100644", sha: path, size: type === "blob" ? 12 : null });
  const mk = (type: string, ...parts: string[]): GithubTreeEntry => tree(type, `docs/kanban/${parts.join("/")}`);
  const source = new FakeRemoteSource(
    [
      mk("tree", "G1"),
      mk("blob", "G1", "Goal.md"),
      mk("tree", "G1", "S1"),
      mk("blob", "G1", "S1", "Spec.md"),
      mk("blob", "G1", "S1", "T10.md"),
      mk("blob", "G1", "S1", "T2.md"),
      mk("blob", "G1", "S1", "T1.md"),
      mk("tree", "G10"),
      mk("blob", "G10", "Goal.md"),
      mk("tree", "G2"),
      mk("blob", "G2", "Goal.md"),
    ],
    {
      "docs/kanban/G1/Goal.md": renderBoardMd(goalFm("G1"), "# body\n"),
      "docs/kanban/G1/S1/Spec.md": renderBoardMd(specFm("G1.S1"), "# body\n"),
      "docs/kanban/G1/S1/T10.md": renderBoardMd(ticketFm("G1.S1.T10"), "# body\n"),
      "docs/kanban/G1/S1/T2.md": renderBoardMd(ticketFm("G1.S1.T2"), "# body\n"),
      "docs/kanban/G1/S1/T1.md": renderBoardMd(ticketFm("G1.S1.T1"), "# body\n"),
      "docs/kanban/G10/Goal.md": renderBoardMd(goalFm("G10"), "# body\n"),
      "docs/kanban/G2/Goal.md": renderBoardMd(goalFm("G2"), "# body\n"),
    },
  );
  const board = await scanRemoteBoard(source, CREDENTIAL, "acme", "box");
  assert.deepEqual(board.goals.map((g) => g.ref), ["G1", "G2", "G10"]);
  assert.deepEqual(board.goals[0].specs[0].tickets.map((t) => t.ref), ["G1.S1.T1", "G1.S1.T2", "G1.S1.T10"]);
});
