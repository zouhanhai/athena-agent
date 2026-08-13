/**
 * Done double-commit (G4.S4.T3, D29) for the OpenCode worker plugin.
 *
 * When a worker marks a ticket `done`, the plugin must regenerate + commit the
 * kanban index as a SEPARATE commit — the worker's done commit + the plugin's
 * index commit = two commits. This is a fallback so the board stays current
 * even if the worker forgets to regen the index (git-kanban-design.md §11/§49).
 *
 * The plugin subscribes to opencode's `session.idle` event hook (the server
 * emits `{type:"session.idle", properties:{sessionID}}` when a worker session
 * becomes idle) and calls `commitDoneIndex` for the ticket that session claimed.
 *
 * No-op safety: skipped when the ticket is not `done`, the idling session did
 * not claim it, or the committed index already reflects `done` (no diff) — so
 * repeated `session.idle` events and workers that already regen the index do
 * not produce spurious commits.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { buildIndexFile, indexFilePath } from "../../server/src/kanban/index-file.js";
import { readTicketFile } from "../../server/src/kanban/board.js";

const execFileAsync = promisify(execFile);

/** Git author used for the plugin's index commits (matches GitClaimLock). */
const AUTHOR = { name: "opencode", email: "opencode@athena" };

const MAX_PUSH_ATTEMPTS = 3;

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repoDir });
  return stdout.trim();
}

/**
 * True when the freshly regenerated index differs from the committed index.
 * `generated_at` is ignored — it changes on every rescan, so comparing it
 * would always see a diff and produce spurious "already current" commits.
 */
async function indexDiffers(repoDir: string, boardRoot: string): Promise<boolean> {
  const file = indexFilePath(boardRoot);
  const rel = path.relative(repoDir, file);
  let committed: Record<string, unknown>;
  try {
    const { stdout } = await execFileAsync("git", ["show", `HEAD:${rel}`], { cwd: repoDir });
    committed = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    // Not committed yet → the on-disk index is untracked/new → it differs.
    return true;
  }
  let onDisk: Record<string, unknown>;
  try {
    onDisk = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return true;
  }
  const { generated_at: _a, ...committedState } = committed;
  const { generated_at: _b, ...onDiskState } = onDisk;
  return JSON.stringify(committedState) !== JSON.stringify(onDiskState);
}

export interface CommitDoneIndexOptions {
  /** The git working tree root (where .git lives). */
  repoDir: string;
  /** Board root; defaults to <repoDir>/docs/kanban. */
  boardRoot?: string;
  /** The ticket ref the idling session claimed (Gx.Sy.Tz). */
  ref: string;
  /** The OpenCode session id that went idle. */
  sessionId: string;
}

/**
 * Regenerate the kanban index and commit it as a SEPARATE commit when the
 * claimed ticket is `done`. Pushes the commit. Returns true when an index
 * commit was created, false when it was a no-op.
 */
export async function commitDoneIndex(options: CommitDoneIndexOptions): Promise<boolean> {
  const boardRoot = options.boardRoot ?? path.join(options.repoDir, "docs", "kanban");
  const { ticket } = await readTicketFile(boardRoot, options.ref);
  if (ticket.status !== "done") return false;
  // Only act on the session that claimed the ticket (never a foreign session).
  if (ticket.session_id && ticket.session_id !== options.sessionId) return false;

  const branch = await git(options.repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const indexFile = indexFilePath(boardRoot);
  for (let attempts = 0; ; attempts++) {
    await buildIndexFile(boardRoot);
    if (!(await indexDiffers(options.repoDir, boardRoot))) return false;

    await git(options.repoDir, ["add", "--", path.relative(options.repoDir, indexFile)]);
    await git(options.repoDir, [
      "-c",
      `user.name=${AUTHOR.name}`,
      "-c",
      `user.email=${AUTHOR.email}`,
      "commit",
      "-m",
      `index done ${options.ref}`,
    ]);
    try {
      await git(options.repoDir, ["push", "origin", branch]);
      return true;
    } catch (err) {
      if (attempts >= MAX_PUSH_ATTEMPTS) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      // Someone pushed first — rebase the index commit on top of the remote.
      await git(options.repoDir, ["fetch", "origin"]).catch(() => undefined);
      try {
        await git(options.repoDir, ["rebase", `origin/${branch}`]);
      } catch {
        await git(options.repoDir, ["rebase", "--abort"]).catch(() => undefined);
      }
    }
  }
}
