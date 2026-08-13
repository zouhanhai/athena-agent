/**
 * Auto-claim orchestration for the OpenCode worker plugin (G4.S4.T1).
 *
 * The plugin claims a ticket on the first tool call so the git push — the
 * mutual-exclusion lock — takes effect BEFORE any work. This reuses the server's
 * `GitClaimLock` (git-lock.ts) + `buildIndexFile` (index-file.ts); it does NOT
 * reimplement the git-lock logic. The claim is ONE commit: ticket md + the
 * regenerated kanban index together (git-kanban-design.md §11).
 *
 * The claim row is appended to the ticket's `## Progress Log` table before the
 * lock commits, so it is committed WITH the claim (git strategy §44: "The claim
 * row is committed with the claim.").
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GitClaimLock, ClaimConflictError } from "../../server/src/kanban/git-lock.js";
import { refToPath, readTicketFile } from "../../server/src/kanban/board.js";
import { ClaimError } from "../../server/src/kanban/protocol.js";
import { appendProgressRow } from "./progress-log.js";

export { ClaimConflictError };

export interface ClaimWithIndexOptions {
  /** The git working tree root (where .git lives). */
  repoDir: string;
  /** Board root; defaults to <repoDir>/docs/kanban. */
  boardRoot?: string;
  /** The ticket ref to claim (Gx.Sy.Tz). */
  ref: string;
  /** The worker identity (assignee) to record. */
  assignee: string;
  /** The OpenCode session id distinguishing this worker. */
  sessionId: string;
  /** Clock override for tests; defaults to the real wall clock. */
  now?: () => Date;
}

/**
 * Claim a ticket through the git claim-lock and push it. Writes the claim row
 * to the Progress Log, sets status/assignee/session_id, regenerates the kanban
 * index, and commits ticket + index in ONE commit, then pushes. On a lost race
 * the local board is resynced and a `ClaimConflictError` is thrown.
 */
export async function claimTicketWithIndex(options: ClaimWithIndexOptions): Promise<{ ref: string }> {
  const boardRoot = options.boardRoot ?? path.join(options.repoDir, "docs", "kanban");
  const now = options.now ?? (() => new Date());
  const claimRow = `${options.assignee} claimed ${options.ref} (session ${options.sessionId})`;

  // Append the claim row to the Progress Log BEFORE the lock commits, so the
  // claim commit carries it (committed with the claim, §44).
  const filePath = refToPath(options.ref, boardRoot);
  const body = await readFile(filePath, "utf8");
  await writeFile(
    filePath,
    appendProgressRow(body, {
      timestamp: now().toISOString(),
      status: "in_progress",
      progress: claimRow,
    }),
    "utf8",
  );

  const lock = new GitClaimLock({
    repoDir: options.repoDir,
    boardRoot,
    commitIndexOnClaim: true,
  });
  try {
    return await lock.claim(options.ref, { assignee: options.assignee, sessionId: options.sessionId });
  } catch (err) {
    // A plain ClaimError (status already moved / assignee mismatch) means another
    // worker won the race on the current board — surface it as a conflict so the
    // worker backs off (no double-claim).
    if (err instanceof ClaimError && !(err instanceof ClaimConflictError)) {
      const doc = await readTicketFile(boardRoot, options.ref);
      const status = doc.ticket.status;
      throw new ClaimConflictError(
        `claim of ${options.ref} lost: another worker claimed it first (status: ${status})`,
      );
    }
    throw err;
  }
}
