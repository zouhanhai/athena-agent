import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderBoardMd } from "../../server/src/kanban/frontmatter.js";
import { refToPath, readTicketFile, writeTicketFile } from "../../server/src/kanban/board.js";
import { buildIndexFile } from "../../server/src/kanban/index-file.js";
import { createWorkerHooks } from "../src/index.js";

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
];

async function setupGitRepo(): Promise<{ base: string; repo: string; remote: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "plugin-done-"));
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

function makeCtx(repo: string, logs: string[] = []): never {
  return {
    directory: repo,
    project: { id: "p" },
    worktree: repo,
    client: {
      app: {
        log: async (args: { body?: { message?: string } }) => {
          logs.push(args.body?.message ?? "");
        },
      },
    },
  } as never;
}

const DISPATCH = "TICKET: G1.S1.T1\nPATH: docs/kanban/G1/S1/T1.md\nImplement it.";
const SESSION = "ses_done";

async function markDone(repo: string, regenIndex: boolean): Promise<void> {
  const boardRoot = path.join(repo, "docs", "kanban");
  const { doc, ticket } = await readTicketFile(boardRoot, "G1.S1.T1");
  await writeTicketFile(boardRoot, { ref: doc.ref, frontmatter: { ...ticket, status: "done" }, body: doc.body });
  if (regenIndex) {
    await buildIndexFile(boardRoot);
  }
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "done G1.S1.T1 (worker)"]);
  await git(repo, ["push", "origin", "master"]);
}

function ticketStatusInIndex(index: { goals: Array<{ specs: Array<{ tickets: Array<{ id: string; status: string }> }> }> }, id: string): string {
  for (const goal of index.goals) {
    for (const spec of goal.specs) {
      for (const t of spec.tickets) {
        if (t.id === id) return t.status;
      }
    }
  }
  throw new Error(`ticket ${id} not in index`);
}

test("session.idle on a done ticket produces a SEPARATE index commit (done double-commit)", async () => {
  const { base, repo, remote } = await setupGitRepo();
  try {
    const hooks = createWorkerHooks(makeCtx(repo), { repoDir: repo });
    await hooks["chat.message"]!(
      { sessionID: SESSION, agent: "build", messageID: "m1" },
      { message: {}, parts: [{ type: "text", text: DISPATCH }] },
    );
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: SESSION, callID: "c1" }, { args: {} });

    // The worker's own done commit (does NOT regenerate the index).
    await markDone(repo, false);

    const before = Number(await git(repo, ["rev-list", "--count", "HEAD"]));
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: SESSION } } });
    const after = Number(await git(repo, ["rev-list", "--count", "HEAD"]));
    assert.equal(after, before + 1, "exactly one plugin index commit on session.idle");

    const lastMsg = await git(repo, ["log", "-1", "--format=%s"]);
    assert.equal(lastMsg, "index done G1.S1.T1");
    // The plugin commit touches ONLY the index, never the ticket (worker's file).
    const files = await git(repo, ["show", "--name-only", "--format=", "HEAD"]);
    assert.match(files, /kanban-index\.json/);
    assert.doesNotMatch(files, /G1\/S1\/T1\.md/);

    // The regenerated index reflects done.
    const index = JSON.parse(
      await readFile(path.join(repo, "docs", "kanban", "kanban-index.json"), "utf8"),
    ) as { goals: Array<{ specs: Array<{ tickets: Array<{ id: string; status: string }> }> }> };
    assert.equal(ticketStatusInIndex(index, "g1.s1.t1"), "done");

    // Pushed: a fresh clone sees the index commit on top of the worker's done commit.
    const worker = path.join(base, "verify");
    await git(base, ["clone", remote, "verify"]);
    await git(worker, ["config", "user.name", "opencode"]);
    await git(worker, ["config", "user.email", "opencode@athena"]);
    const recent = await git(worker, ["log", "-2", "--format=%s"]);
    const lines = recent.split("\n").filter(Boolean);
    assert.equal(lines[0], "index done G1.S1.T1");
    assert.equal(lines[1], "done G1.S1.T1 (worker)");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("session.idle does NOT commit when the ticket is not done", async () => {
  const { base, repo } = await setupGitRepo();
  try {
    const hooks = createWorkerHooks(makeCtx(repo), { repoDir: repo });
    await hooks["chat.message"]!(
      { sessionID: SESSION, agent: "build", messageID: "m1" },
      { message: {}, parts: [{ type: "text", text: DISPATCH }] },
    );
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: SESSION, callID: "c1" }, { args: {} });

    const before = Number(await git(repo, ["rev-list", "--count", "HEAD"]));
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: SESSION } } });
    const after = Number(await git(repo, ["rev-list", "--count", "HEAD"]));
    assert.equal(after, before, "no commit while the ticket is in_progress");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("session.idle does NOT commit when the index already reflects done", async () => {
  const { base, repo } = await setupGitRepo();
  try {
    const hooks = createWorkerHooks(makeCtx(repo), { repoDir: repo });
    await hooks["chat.message"]!(
      { sessionID: SESSION, agent: "build", messageID: "m1" },
      { message: {}, parts: [{ type: "text", text: DISPATCH }] },
    );
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: SESSION, callID: "c1" }, { args: {} });

    // Worker marks done AND regenerates the index in its own commit.
    await markDone(repo, true);

    const before = Number(await git(repo, ["rev-list", "--count", "HEAD"]));
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: SESSION } } });
    const after = Number(await git(repo, ["rev-list", "--count", "HEAD"]));
    assert.equal(after, before, "index already current — no second commit");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("session.idle for an unclaimed session does NOT commit", async () => {
  const { base, repo } = await setupGitRepo();
  try {
    const hooks = createWorkerHooks(makeCtx(repo), { repoDir: repo });
    await hooks["chat.message"]!(
      { sessionID: SESSION, agent: "build", messageID: "m1" },
      { message: {}, parts: [{ type: "text", text: DISPATCH }] },
    );
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: SESSION, callID: "c1" }, { args: {} });
    await markDone(repo, false);

    const before = Number(await git(repo, ["rev-list", "--count", "HEAD"]));
    // A different session idles — the plugin only acts on the session it claimed.
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_other" } } });
    const after = Number(await git(repo, ["rev-list", "--count", "HEAD"]));
    assert.equal(after, before, "foreign session idle must not trigger the index commit");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
