import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderBoardMd } from "../src/kanban/frontmatter.js";
import { refToPath, readBoardFile } from "../src/kanban/board.js";
import { GitClaimLock, ClaimConflictError } from "../src/kanban/git-lock.js";

const run = promisify(execFile);

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: dir });
  return stdout.trim();
}

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

function goalFm(ref: string): Record<string, unknown> {
  return {
    id: ref.toLowerCase(),
    title: `${ref}: goal`,
    layer: "G",
    owner: "consultant",
    status: "active",
    milestone: "M3",
    acceptance_criteria: ["done"],
  };
}

function specFm(ref: string): Record<string, unknown> {
  return {
    id: ref.toLowerCase(),
    title: `${ref}: spec`,
    layer: "S",
    parent: ref.split(".")[0],
    owner: "pm",
    status: "active",
    milestone: "M3",
    acceptance_criteria: ["done"],
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

const BOARD_DOCS: Array<[string, Record<string, unknown>]> = [
  ["G1", goalFm("G1")],
  ["G1.S1", specFm("G1.S1")],
  ["G1.S1.T1", ticketFm("G1.S1.T1")],
  ["G1.S1.T2", ticketFm("G1.S1.T2")],
  ["G1.S1.T3", ticketFm("G1.S1.T3", { assignee: "eng-director" })],
];

/** Create a git repo (with board docs committed + pushed to a bare remote). */
async function setupGitRepo(): Promise<{ base: string; repo: string; remote: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "kanban-gitlock-"));
  const repo = path.join(base, "repo");
  const remote = path.join(base, "remote.git");
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "-b", "master"]);
  await git(repo, ["config", "user.name", "opencode"]);
  await git(repo, ["config", "user.email", "opencode@athena"]);

  const boardRoot = path.join(repo, "docs", "kanban");
  for (const [ref, fm] of BOARD_DOCS) {
    await writeDoc(boardRoot, ref, fm);
  }
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "initial board"]);
  await git(repo, ["init", "--bare", remote]);
  await git(repo, ["remote", "add", "origin", remote]);
  await git(repo, ["push", "-u", "origin", "master"]);
  return { base, repo, remote };
}

/** Clone a worker working tree from the bare remote. */
async function cloneWorker(base: string, remote: string, name: string): Promise<string> {
  const dir = path.join(base, name);
  await git(base, ["clone", remote, name]);
  await git(dir, ["config", "user.name", "opencode"]);
  await git(dir, ["config", "user.email", "opencode@athena"]);
  return dir;
}

test("GitClaimLock.claim writes the claim and pushes it to the remote", async () => {
  const { base, repo, remote } = await setupGitRepo();
  try {
    const lock = new GitClaimLock({ repoDir: repo });
    const result = await lock.claim("G1.S1.T1", {
      assignee: "opencode",
      sessionId: "ses_abc",
      now: "2026-08-08",
    });
    assert.equal(result.ref, "G1.S1.T1");

    const commitMsg = await git(repo, ["log", "-1", "--format=%s"]);
    assert.match(commitMsg, /claim G1\.S1\.T1/);

    const worker = await cloneWorker(base, remote, "verify");
    const doc = await readBoardFile(path.join(worker, "docs", "kanban"), "G1.S1.T1");
    assert.equal(doc.frontmatter.status, "in_progress");
    assert.equal(doc.frontmatter.assignee, "opencode");
    assert.equal(doc.frontmatter.session_id, "ses_abc");
    assert.match(doc.body, /## Log/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("claim succeeds over the eng-director pre-claim placeholder", async () => {
  const { base, repo, remote } = await setupGitRepo();
  try {
    const lock = new GitClaimLock({ repoDir: repo });
    // G1.S1.T3 is created with assignee: "eng-director" (unclaimed tickets sit
    // in the Eng Director's court) — a worker claim must overwrite it.
    const result = await lock.claim("G1.S1.T3", {
      assignee: "opencode",
      sessionId: "ses_xyz",
      now: "2026-08-21",
    });
    assert.equal(result.ref, "G1.S1.T3");

    const doc = await readBoardFile(path.join(repo, "docs", "kanban"), "G1.S1.T3");
    assert.equal(doc.frontmatter.status, "in_progress");
    assert.equal(doc.frontmatter.assignee, "opencode");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a second worker loses the claim race: push conflicts and the stale worker backs off", async () => {
  const { base, remote, repo } = await setupGitRepo();
  try {
    const workerA = await cloneWorker(base, remote, "workerA");
    const workerB = await cloneWorker(base, remote, "workerB");

    const lockA = new GitClaimLock({ repoDir: workerA });
    await lockA.claim("G1.S1.T1", { assignee: "pi-a", sessionId: "ses_a", now: "2026-08-08" });

    const lockB = new GitClaimLock({ repoDir: workerB });
    await assert.rejects(
      () => lockB.claim("G1.S1.T1", { assignee: "pi-b", sessionId: "ses_b", now: "2026-08-08" }),
      (err: unknown) => err instanceof ClaimConflictError,
    );

    const docB = await readBoardFile(path.join(workerB, "docs", "kanban"), "G1.S1.T1");
    assert.equal(docB.frontmatter.status, "in_progress");
    assert.equal(docB.frontmatter.assignee, "pi-a");
    assert.equal(docB.frontmatter.session_id, "ses_a");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("GitClaimLock.report marks done with pr + branch and pushes it", async () => {
  const { base, repo } = await setupGitRepo();
  try {
    const lock = new GitClaimLock({ repoDir: repo });
    await lock.claim("G1.S1.T1", { assignee: "opencode", sessionId: "ses_abc", now: "2026-08-08" });
    await lock.report("G1.S1.T1", {
      status: "in_review",
      pr: 7,
      branch: "feat/t1",
      now: "2026-08-09",
    });

    const commitMsg = await git(repo, ["log", "-1", "--format=%s"]);
    assert.match(commitMsg, /report G1\.S1\.T1/);

    const doc = await readBoardFile(path.join(repo, "docs", "kanban"), "G1.S1.T1");
    assert.equal(doc.frontmatter.status, "in_review");
    assert.equal(doc.frontmatter.pr, 7);
    assert.equal(doc.frontmatter.branch, "feat/t1");
    assert.equal(doc.frontmatter.completed_at, "2026-08-09");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("claim that would report is validated against the pushed board state", async () => {
  const { base, remote, repo } = await setupGitRepo();
  try {
    const workerA = await cloneWorker(base, remote, "workerA");
    await new GitClaimLock({ repoDir: workerA }).claim("G1.S1.T2", {
      assignee: "pi-a",
      sessionId: "ses_a",
      now: "2026-08-08",
    });

    const lock = new GitClaimLock({ repoDir: repo });
    await assert.rejects(
      () => lock.claim("G1.S1.T2", { assignee: "pi-b", sessionId: "ses_b", now: "2026-08-08" }),
      ClaimConflictError,
    );
    const doc = await readBoardFile(path.join(repo, "docs", "kanban"), "G1.S1.T2");
    assert.equal(doc.frontmatter.assignee, "pi-a");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
