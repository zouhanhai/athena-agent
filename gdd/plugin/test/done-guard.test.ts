import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderBoardMd } from "../../src/kanban/frontmatter.js";
import { refToPath } from "../../src/kanban/board.js";
import type { WorkerHooks } from "../src/index.js";

const run = promisify(execFile);

/**
 * G4.S8.T18 — done-requires-push guard wiring in the athena.worker plugin:
 * a ticket marked done whose commit is NOT on the remote BLOCKS (throws to the
 * worker) until the push lands; the session.idle md→GitHub sync is skipped too.
 */

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: dir });
  return stdout.trim();
}

const TICKET_REF = "G9.S9.T9";

async function setupRepo(): Promise<{ base: string; repo: string; remote: string; ticketPath: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "plugin-done-guard-"));
  const repo = path.join(base, "repo");
  const remote = path.join(base, "remote.git");
  await mkdir(path.join(repo), { recursive: true });
  await git(repo, ["init", "-b", "master"]);
  await git(repo, ["config", "user.name", "opencode"]);
  await git(repo, ["config", "user.email", "opencode@athena"]);
  const boardRoot = path.join(repo, "docs", "kanban");
  const ticketPath = refToPath(TICKET_REF, boardRoot);
  await mkdir(path.dirname(ticketPath), { recursive: true });
  // The claim-lock commits the ticket + its parent Spec together.
  const specPath = path.join(boardRoot, "G9", "S9", "Spec.md");
  await mkdir(path.dirname(specPath), { recursive: true });
  await writeFile(
    specPath,
    renderBoardMd(
      {
        id: "s9",
        title: "G9.S9: spec",
        layer: "S",
        parent: "G9",
        owner: "pm",
        status: "active",
        milestone: "M4",
        acceptance_criteria: ["done"],
      },
      "# body\n",
    ),
    "utf8",
  );
  await writeFile(
    ticketPath,
    renderBoardMd(
      {
        id: TICKET_REF.toLowerCase(),
        title: `${TICKET_REF}: ticket`,
        layer: "T",
        parent: "G9.S9",
        owner: "eng-director",
        status: "backlog",
        assignee: "",
        blocked_by: [],
        acceptance_criteria: ["done"],
      },
      "# body\n\n## Progress Log\n| UTC timestamp | status | one-line progress |\n| --- | --- | --- |\n",
    ),
    "utf8",
  );
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "initial board"]);
  // The claim-lock pushes to the upstream remote — a bare origin keeps the
  // claim flow working exactly like the real board.
  await git(repo, ["init", "--bare", remote]);
  await git(repo, ["remote", "add", "origin", remote]);
  await git(repo, ["push", "-u", "origin", "master"]);
  return { base, repo, remote, ticketPath };
}

interface Setup {
  hooks: WorkerHooks;
  logs: string[];
  verifyCalls: number;
  setPushed: (pushed: boolean) => void;
}

async function setupHooks(repo: string): Promise<Setup> {
  let pushed = true;
  let verifyCalls = 0;
  const logs: string[] = [];
  const hooks = (
    await import("../src/index.js")
  ).createWorkerHooks(
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
    {
      repoDir: repo,
      remoteRef: "origin/master",
      verifyPushed: async () => {
        verifyCalls += 1;
        if (!pushed) throw new Error("HEAD not reachable on origin/master");
      },
    },
  );
  return {
    hooks,
    logs,
    get verifyCalls() {
      return verifyCalls;
    },
    setPushed: (v: boolean) => {
      pushed = v;
    },
  };
}

test("done + unpushed → tool.execute.after THROWS the guard error; after pushing it passes", async () => {
  const { base, repo, ticketPath } = await setupRepo();
  try {
    const setup = await setupHooks(repo);
    const { hooks } = setup;
    await hooks["chat.message"]!(
      { sessionID: "s1", agent: "build", messageID: "m1" },
      { message: {}, parts: [{ type: "text", text: `TICKET: ${TICKET_REF}\nPATH: docs/kanban/G9/S9/T9.md` }] },
    );
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "s1", callID: "c1" }, { args: {} });

    // Not done yet → no guard invocation.
    await hooks["tool.execute.after"]!(
      { tool: "read", sessionID: "s1", callID: "c1", args: {} },
      { title: "", output: "", metadata: {} },
    );
    assert.equal(setup.verifyCalls, 0);

    // The worker marks the ticket done WITHOUT pushing.
    const raw = await readFile(ticketPath, "utf8");
    await writeFile(
      ticketPath,
      raw.replace(/^status: in_progress$/m, "status: done").replace(/^assignee: ""$/m, 'assignee: "opencode"'),
      "utf8",
    );

    setup.setPushed(false);
    await assert.rejects(
      () =>
        hooks["tool.execute.after"]!(
          { tool: "edit", sessionID: "s1", callID: "c2", args: {} },
          { title: "", output: "", metadata: {} },
        ),
      /NOT verified on origin\/master.*PUSH first/s,
    );

    // The push lands → the SAME check passes and progress rows resume.
    setup.setPushed(true);
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "s1", callID: "c3", args: {} },
      { title: "", output: "", metadata: {} },
    );
    assert.ok(setup.verifyCalls >= 2);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("session.idle skips the md→GitHub sync for an unpushed done ticket and logs the block", async () => {
  const { base, repo, ticketPath } = await setupRepo();
  try {
    let syncRuns = 0;
    let pushed = true;
    const logs: string[] = [];
    const mod = await import("../src/index.js");
    const hooks = mod.createWorkerHooks(
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
      {
        repoDir: repo,
        remoteRef: "origin/master",
        verifyPushed: async () => {
          if (!pushed) throw new Error("unpushed");
        },
        syncSpecOnDone: async () => {
          syncRuns += 1;
        },
      },
    );
    await hooks["chat.message"]!(
      { sessionID: "s2", agent: "build", messageID: "m2" },
      { message: {}, parts: [{ type: "text", text: `TICKET: ${TICKET_REF}\nPATH: docs/kanban/G9/S9/T9.md` }] },
    );
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "s2", callID: "d1" }, { args: {} });

    const raw = await readFile(ticketPath, "utf8");
    await writeFile(ticketPath, raw.replace(/^status: in_progress$/m, "status: done"), "utf8");

    // Unpushed → sync skipped + error logged (best-effort, idle never crashes).
    pushed = false;
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "s2" } } });
    assert.equal(syncRuns, 0);
    assert.ok(logs.some((l) => l.includes("done-requires-push") && l.includes("sync skipped")));

    // Pushed → sync runs.
    pushed = true;
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "s2" } } });
    assert.equal(syncRuns, 1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
