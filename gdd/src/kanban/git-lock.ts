/**
 * Git claim-lock for the worker claim/report protocol (G3.S6.T3).
 *
 * A worker claims a ticket by writing status/assignee/session_id and pushing
 * to git — git push atomicity is the mutual-exclusion lock. This class wraps
 * the md-level protocol (./protocol.ts) with add → commit → push. A rejected
 * push (non-fast-forward) means another worker pushed first: we resync to the
 * remote and, if the ticket is no longer claimable, back off with a
 * ClaimConflictError.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { refToPath, readBoardFile } from "./board.js";
import {
  claimTicket,
  reportTicket,
  ClaimError,
  ReportError,
  type ClaimInput,
  type ClaimResult,
  type ReportInput,
  type ReportResult,
} from "./protocol.js";

const execFileAsync = promisify(execFile);

/** The Spec ref (`Gx.Sy`) containing a ticket ref (`Gx.Sy.Tz`). */
function specRefOf(ref: string): string {
  return ref.split(".").slice(0, 2).join(".");
}

/** Thrown when a git push reveals another worker claimed the ticket first. */
export class ClaimConflictError extends ClaimError {}

/** Options for the git-backed claim/report lock. */
export interface GitClaimLockOptions {
  /** The git working tree root (where .git lives). */
  repoDir: string;
  /** Board root; defaults to <repoDir>/docs/kanban. */
  boardRoot?: string;
}

const MAX_PUSH_ATTEMPTS = 3;

/** Git author used for claim/report commits. */
const AUTHOR = { name: "opencode", email: "opencode@athena" };

/**
 * Worker claim/report via git claim-lock. Every claim/report is written to
 * the board md, committed, and pushed. A rejected push (non-fast-forward)
 * means the board moved on: we resync to the remote and re-read the ticket,
 * re-claiming when it is still claimable or throwing ClaimConflictError when
 * another worker won the race.
 */
export class GitClaimLock {
  private readonly repoDir: string;
  private readonly boardRoot: string;

  constructor(options: GitClaimLockOptions) {
    this.repoDir = options.repoDir;
    this.boardRoot = options.boardRoot ?? path.join(options.repoDir, "docs", "kanban");
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd: this.repoDir });
    return stdout.trim();
  }

  private async branch(): Promise<string> {
    return this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
  }

  private async commitFiles(files: string[], message: string): Promise<void> {
    const rels = files.map((file) => path.relative(this.repoDir, file));
    await this.git(["add", "--", ...rels]);
    await this.git([
      "-c",
      `user.name=${AUTHOR.name}`,
      "-c",
      `user.email=${AUTHOR.email}`,
      "commit",
      "-m",
      message,
    ]);
  }

  private async commitFile(filePath: string, message: string): Promise<void> {
    await this.commitFiles([filePath], message);
  }

  /** Discard local work and resync the working tree to the remote branch. */
  private async resync(): Promise<void> {
    const branch = await this.branch();
    await this.git(["fetch", "origin"]).catch(() => undefined);
    await this.git(["rebase", "--abort"]).catch(() => undefined);
    await this.git(["reset", "--hard", `origin/${branch}`]).catch(() => undefined);
  }

  /**
   * Claim a ticket and push the claim. On a lost race the local board is
   * reset to the remote state and a ClaimConflictError is thrown.
   */
  async claim(ref: string, input: ClaimInput): Promise<ClaimResult> {
    const file = refToPath(ref, this.boardRoot);
    // G4.S6.T2: the claim may also auto-advance the containing Spec
    // (backlog → in_progress), so the spec file is committed with the claim.
    const specFile = refToPath(specRefOf(ref), this.boardRoot);
    for (let attempts = 0; ; attempts++) {
      const result = await claimTicket(this.boardRoot, ref, input);
      await this.commitFiles([file, specFile], `claim ${ref} (in_progress)`);
      try {
        await this.git(["push", "origin", await this.branch()]);
        return result;
      } catch (err) {
        if (attempts >= MAX_PUSH_ATTEMPTS) {
          throw new ClaimError(
            `could not push claim for ${ref}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        await this.resync();
        const doc = await readBoardFile(this.boardRoot, ref);
        if (doc.frontmatter.layer === "T" && doc.frontmatter.status !== "backlog") {
          throw new ClaimConflictError(
            `claim of ${ref} lost: another worker claimed it first (status: ${doc.frontmatter.status})`,
          );
        }
        // still claimable on the fresh board → re-claim and retry the push
      }
    }
  }

  /**
   * Report done/in_review + PR number and push. On a conflict the local board
   * is resynced and the report is re-applied to the fresh state.
   */
  async report(ref: string, input: ReportInput): Promise<ReportResult> {
    const file = refToPath(ref, this.boardRoot);
    for (let attempts = 0; ; attempts++) {
      const result = await reportTicket(this.boardRoot, ref, input);
      await this.commitFile(file, `report ${ref} (${input.status})`);
      try {
        await this.git(["push", "origin", await this.branch()]);
        return result;
      } catch (err) {
        if (attempts >= MAX_PUSH_ATTEMPTS) {
          throw new ReportError(
            `could not push report for ${ref}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        await this.resync();
        // loop re-applies the report to the fresh board and retries the push
      }
    }
  }
}
