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
];

async function setupGitRepo(): Promise<{ base: string; repo: string; remote: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "plugin-wiring-"));
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

test("chat.message captures the dispatch ref; first tool call auto-claims; tool execute appends progress", async () => {
  const { base, repo } = await setupGitRepo();
  try {
    const logs: string[] = [];
    const hooks = createWorkerHooks(
      {
        directory: repo,
        project: { id: "p" },
        worktree: repo,
        client: {
          app: {
            log: async (args: { body?: { message?: string } }) => {
              logs.push(args.body?.message ?? "");
            },
          },
        } as never,
      },
      { repoDir: repo },
    );

    // First dispatch message (§13 structured prompt) arrives.
    await hooks["chat.message"]!(
      { sessionID: "ses_1", agent: "build", messageID: "m1" },
      { message: {}, parts: [{ type: "text", text: "TICKET: G1.S1.T1\nPATH: docs/kanban/G1/S1/T1.md\nImplement." }] },
    );

    // First tool call → auto-claim.
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "ses_1", callID: "c1" }, { args: {} });

    const doc = await readTicketFile(path.join(repo, "docs", "kanban"), "G1.S1.T1");
    assert.equal(doc.ticket.status, "in_progress");
    assert.equal(doc.ticket.assignee, "opencode");
    assert.equal(doc.ticket.session_id, "ses_1");
    assert.match(logs.join("\n"), /claimed G1\.S1\.T1/);
    // claim row in the Progress Log table (committed with the claim)
    assert.match(doc.doc.body, /opencode claimed G1\.S1\.T1/);

    // A later tool call appends a rate-limited progress row.
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_1", callID: "c2", args: { command: "npm test" } },
      { title: "bash", output: "ok", metadata: {} },
    );
    const bodyAfter = await readFile(refToPath("G1.S1.T1", path.join(repo, "docs", "kanban")), "utf8");
    assert.match(bodyAfter, /ran bash/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("lost race: plugin surfaces ClaimConflictError on the second worker's first tool call", async () => {
  const { base, remote, repo } = await setupGitRepo();
  try {
    // worker A claims via the plugin.
    const hooksA = createWorkerHooks(
      {
        directory: repo,
        project: { id: "p" },
        worktree: repo,
        client: { app: { log: async () => undefined } } as never,
      },
      { repoDir: repo },
    );
    await hooksA["chat.message"]!(
      { sessionID: "ses_a", agent: "build", messageID: "m1" },
      { message: {}, parts: [{ type: "text", text: "TICKET: G1.S1.T1\nPATH: docs/kanban/G1/S1/T1.md" }] },
    );
    await hooksA["tool.execute.before"]!({ tool: "read", sessionID: "ses_a", callID: "c1" }, { args: {} });

    // worker B is a fresh clone; the push race must surface ClaimConflictError.
    const workerB = await git(base, ["clone", remote, "workerB"]).then(() => path.join(base, "workerB"));
    await git(workerB, ["config", "user.name", "opencode"]);
    await git(workerB, ["config", "user.email", "opencode@athena"]);

    const hooksB = createWorkerHooks(
      {
        directory: workerB,
        project: { id: "p" },
        worktree: workerB,
        client: { app: { log: async () => undefined } } as never,
      },
      { repoDir: workerB },
    );
    await hooksB["chat.message"]!(
      { sessionID: "ses_b", agent: "build", messageID: "m1" },
      { message: {}, parts: [{ type: "text", text: "TICKET: G1.S1.T1\nPATH: docs/kanban/G1/S1/T1.md" }] },
    );
    await assert.rejects(
      hooksB["tool.execute.before"]!({ tool: "read", sessionID: "ses_b", callID: "c1" }, { args: {} }),
      (err: unknown) => err instanceof Error && /ClaimConflictError/.test(err.message),
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
