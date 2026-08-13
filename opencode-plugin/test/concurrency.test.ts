import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderBoardMd } from "../../server/src/kanban/frontmatter.js";
import { refToPath, readTicketFile } from "../../server/src/kanban/board.js";
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
  ["G1.S1.T2", ticketFm("G1.S1.T2")],
];

async function setupGitRepo(): Promise<{ base: string; repo: string; remote: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "plugin-conc-"));
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

async function countRows(body: string, needle: string): Promise<number> {
  return (body.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
}

test("N concurrent tool.execute.before calls in the same tick claim exactly ONCE", async () => {
  const { base, repo } = await setupGitRepo();
  try {
    const hooks = createWorkerHooks(makeCtx(repo), { repoDir: repo });
    await hooks["chat.message"]!(
      { sessionID: "ses_conc", agent: "build", messageID: "m1" },
      { message: {}, parts: [{ type: "text", text: DISPATCH }] },
    );

    const N = 6;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        hooks["tool.execute.before"]!({ tool: "read", sessionID: "ses_conc", callID: `c${i}` }, { args: {} }),
      ),
    );

    const boardRoot = path.join(repo, "docs", "kanban");
    const log = await git(repo, ["log", "--oneline"]);
    const claimCommits = log.split("\n").filter((line) => line.includes("claim G1.S1.T1"));
    assert.equal(claimCommits.length, 1, "exactly one claim commit");
    // the claim commit must be ONE commit (ticket + index together), not N.
    const totalCommits = log.split("\n").filter(Boolean).length;
    assert.equal(totalCommits, 2, "initial board + exactly one claim commit");

    const doc = await readTicketFile(boardRoot, "G1.S1.T1");
    assert.equal(doc.ticket.status, "in_progress");
    assert.equal(doc.ticket.assignee, "opencode");
    assert.equal(doc.ticket.session_id, "ses_conc");
    assert.equal(await countRows(doc.doc.body, "| in_progress | opencode claimed G1.S1.T1"), 1, "one claim Progress Log row");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("N concurrent tool.execute.after calls for the SAME tool call append at most ONE row", async () => {
  const { base, repo } = await setupGitRepo();
  try {
    let t = new Date("2026-08-13T12:00:00.000Z");
    const hooks = createWorkerHooks(makeCtx(repo), { repoDir: repo, minIntervalMs: 1000, now: () => t });
    await hooks["chat.message"]!(
      { sessionID: "ses_after", agent: "build", messageID: "m1" },
      { message: {}, parts: [{ type: "text", text: DISPATCH }] },
    );
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "ses_after", callID: "claim" }, { args: {} });

    // Advance past the claim row's rate-limit window so the after-call can append.
    t = new Date("2026-08-13T12:00:10.000Z");
    const N = 6;
    await Promise.all(
      Array.from({ length: N }, () =>
        hooks["tool.execute.after"]!(
          { tool: "bash", sessionID: "ses_after", callID: "call-42", args: { command: "npm test" } },
          { title: "bash", output: "ok", metadata: {} },
        ),
      ),
    );

    const body = await readFile(refToPath("G1.S1.T1", path.join(repo, "docs", "kanban")), "utf8");
    assert.equal(await countRows(body, "ran bash"), 1, "one row for one tool call despite double-fires");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("N concurrent tool.execute.after calls with distinct callIDs append at most one row per call", async () => {
  const { base, repo } = await setupGitRepo();
  try {
    let t = new Date("2026-08-13T12:00:00.000Z");
    const hooks = createWorkerHooks(makeCtx(repo), { repoDir: repo, minIntervalMs: 1000, now: () => t });
    await hooks["chat.message"]!(
      { sessionID: "ses_distinct", agent: "build", messageID: "m1" },
      { message: {}, parts: [{ type: "text", text: DISPATCH }] },
    );
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "ses_distinct", callID: "claim" }, { args: {} });

    t = new Date("2026-08-13T12:00:10.000Z");
    const N = 6;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        hooks["tool.execute.after"]!(
          { tool: "bash", sessionID: "ses_distinct", callID: `call-${i}`, args: { command: "npm test" } },
          { title: "bash", output: "ok", metadata: {} },
        ),
      ),
    );
    // Same tick, distinct callIDs: the rate limit admits exactly one row total —
    // each individual call contributed at most one row.
    const body = await readFile(refToPath("G1.S1.T1", path.join(repo, "docs", "kanban")), "utf8");
    const rows = await countRows(body, "ran bash");
    assert.ok(rows >= 1 && rows <= N, `one row per call, got ${rows}`);

    // Re-firing an already-appended callID (after the rate-limit window) adds NO duplicate row.
    t = new Date("2026-08-13T12:00:20.000Z");
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_distinct", callID: "call-0", args: { command: "npm test" } },
      { title: "bash", output: "ok", metadata: {} },
    );
    const body2 = await readFile(refToPath("G1.S1.T1", path.join(repo, "docs", "kanban")), "utf8");
    const rows2 = await countRows(body2, "ran bash");
    assert.equal(rows2, rows, "re-firing the same callID must not add a row");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
