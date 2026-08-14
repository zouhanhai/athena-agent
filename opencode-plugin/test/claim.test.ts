import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderBoardMd } from "../../server/src/kanban/frontmatter.js";
import { refToPath, readTicketFile } from "../../server/src/kanban/board.js";
import { claimTicketWithIndex, ClaimConflictError } from "../src/claim.js";

const run = promisify(execFile);

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: dir });
  return stdout.trim();
}

function goalFm(ref: string): Record<string, unknown> {
  return {
    id: ref.toLowerCase(),
    title: `${ref}: goal`,
    layer: "G",
    owner: "consultant",
    status: "active",
    milestone: "M4",
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
    milestone: "M4",
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

async function writeDoc(root: string, ref: string, fm: Record<string, unknown>, body = "# body\n"): Promise<void> {
  const filePath = refToPath(ref, root);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, renderBoardMd(fm, body), "utf8");
}

const BOARD_DOCS: Array<[string, Record<string, unknown>]> = [
  ["G1", goalFm("G1")],
  ["G1.S1", specFm("G1.S1")],
  ["G1.S1.T1", ticketFm("G1.S1.T1")],
  ["G1.S1.T2", ticketFm("G1.S1.T2")],
];

async function setupGitRepo(): Promise<{ base: string; repo: string; remote: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "plugin-claim-"));
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

async function cloneWorker(base: string, remote: string, name: string): Promise<string> {
  const dir = path.join(base, name);
  await git(base, ["clone", remote, name]);
  await git(dir, ["config", "user.name", "opencode"]);
  await git(dir, ["config", "user.email", "opencode@athena"]);
  return dir;
}

test("claim happy path: status/assignee/session_id + claim row in ONE commit, pushed", async () => {
  const { base, remote, repo } = await setupGitRepo();
  try {
    await claimTicketWithIndex({
      repoDir: repo,
      ref: "G1.S1.T1",
      assignee: "opencode",
      sessionId: "ses_abc",
    });

    // The claim commit must be a SINGLE commit (the ticket md + claim row).
    const recent = await git(repo, ["log", "--oneline", "-3"]);
    const lines = recent.split("\n").filter(Boolean);
    assert.equal(await git(repo, ["log", "-1", "--format=%s"]), "claim G1.S1.T1 (in_progress)");
    assert.equal(lines.length, 2); // initial board + claim
    // The claim commit touches ONLY the ticket md — no local board index.
    const files = await git(repo, ["show", "--name-only", "--format=", "HEAD"]);
    assert.match(files, /docs\/kanban\/G1\/S1\/T1\.md/);
    assert.doesNotMatch(files, /kanban-index\.json/);

    const worker = await cloneWorker(base, remote, "verify");
    const doc = await readTicketFile(path.join(worker, "docs", "kanban"), "G1.S1.T1");
    assert.equal(doc.ticket.status, "in_progress");
    assert.equal(doc.ticket.assignee, "opencode");
    assert.equal(doc.ticket.session_id, "ses_abc");
    // claim row appears in the Progress Log table
    assert.match(doc.doc.body, /## Progress Log/);
    assert.match(doc.doc.body, /opencode claimed G1\.S1\.T1/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("lost claim race: the stale worker surfaces ClaimConflictError and the board keeps the winner", async () => {
  const { base, remote, repo } = await setupGitRepo();
  try {
    const workerA = await cloneWorker(base, remote, "workerA");
    const workerB = await cloneWorker(base, remote, "workerB");

    await claimTicketWithIndex({
      repoDir: workerA,
      ref: "G1.S1.T1",
      assignee: "pi-a",
      sessionId: "ses_a",
    });

    await assert.rejects(
      claimTicketWithIndex({
        repoDir: workerB,
        ref: "G1.S1.T1",
        assignee: "pi-b",
        sessionId: "ses_b",
      }),
      (err: unknown) => err instanceof ClaimConflictError,
    );

    const docB = await readTicketFile(path.join(workerB, "docs", "kanban"), "G1.S1.T1");
    assert.equal(docB.ticket.status, "in_progress");
    assert.equal(docB.ticket.assignee, "pi-a");
    assert.equal(docB.ticket.session_id, "ses_a");
    void repo;
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
