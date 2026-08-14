/**
 * md → GitHub auto-sync for the OpenCode worker plugin (G4.S5.T10).
 *
 * When a worker marks a ticket `done`, the session.idle handler runs the md →
 * GitHub sync for the ticket's parent Spec so the GitHub Project board's Status
 * columns update automatically — no manual `sync-github sync <specRef>` needed.
 *
 * The sync is best-effort: a failure is logged by the caller and never blocks
 * the done commit. Credential resolution is LOCAL-token-first (gdd/src/
 * credential.ts): an explicit token → `gh auth token` (gh CLI) → `GITHUB_TOKEN`
 * env → the athena employee store ONLY as an optional fallback when running
 * inside athena (gdd/src/athena-employee.ts). The owner/repo come from explicit
 * options → `GITHUB_OWNER`/`GITHUB_REPO` env → the `origin` remote.
 */

import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scanBoard } from "../../src/kanban/scan.js";
import { createSpecIssue } from "../../src/kanban/github-sync.js";
import { GithubClient } from "../../src/github/client.js";
import type { GithubCredential, GithubProject } from "../../src/github/types.js";
import { athenaEmployeeReader } from "../../src/athena-employee.js";
import { resolveGithubCredential as resolveLocalCredential } from "../../src/credential.js";

const execFileAsync = promisify(execFile);

/** The employee whose stored GitHub credential is used as a last-resort fallback. */
export const DEFAULT_SYNC_EMPLOYEE = "zouha108@caleo.com";

const TICKET_REF = /^G(\d+)\.S(\d+)\.T(\d+)$/;

/**
 * Derive a ticket's parent Spec ref: `G4.S5.T9` → `G4.S5`. Returns null for a
 * ref that is not a ticket ref (goals/specs have no parent Spec to sync).
 */
export function specRefFromTicketRef(ref: string): string | null {
  const match = TICKET_REF.exec(ref.trim());
  return match ? `G${match[1]}.S${match[2]}` : null;
}

/**
 * Resolve the GitHub owner/repo to sync: explicit options → `GITHUB_OWNER` /
 * `GITHUB_REPO` env → the `caleo` remote (primary), falling back to `origin`
 * (zouhanhai shadow). github.com URLs only.
 */
export async function resolveGithubRepo(
  repoDir: string,
  owner?: string,
  repo?: string,
): Promise<{ owner: string; repo: string }> {
  const ownerName = owner ?? process.env.GITHUB_OWNER;
  const repoName = repo ?? process.env.GITHUB_REPO;
  if (ownerName && repoName) {
    return { owner: ownerName, repo: repoName };
  }
  // caleo is the PRIMARY repo (2026-08-14); origin is the zouhanhai shadow.
  for (const remoteName of ["caleo", "origin"]) {
    try {
      const { stdout } = await execFileAsync("git", ["remote", "get-url", remoteName], {
        cwd: repoDir,
      });
      const match = stdout.trim().match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (match) {
        return { owner: match[1], repo: match[2] };
      }
    } catch {
      // no such remote → try the next
    }
  }
  throw new Error(
    "unable to determine the GitHub owner/repo for " + repoDir +
      " (set GITHUB_OWNER/GITHUB_REPO or configure a github.com caleo/origin remote)",
  );
}

/**
 * Resolve a GitHub credential LOCAL-token-first: an explicit token → `gh auth
 * token` (gh CLI) → `GITHUB_TOKEN` env → the athena employee store ONLY as an
 * optional fallback when running inside athena (gdd/src/athena-employee.ts).
 */
export async function resolveGithubCredential(token?: string): Promise<GithubCredential> {
  const employeeReader = await athenaEmployeeReader();
  return resolveLocalCredential({ token, employeeReader });
}

/** The Project board for the repo: reuse by title, else create. */
async function resolveProject(
  github: GithubClient,
  credential: GithubCredential,
  owner: string,
  repo: string,
): Promise<GithubProject> {
  const title = process.env.GITHUB_PROJECT ?? `${owner}/${repo}`;
  const existing = await github.getProjectByTitle(credential, owner, title);
  if (existing) {
    return existing;
  }
  return github.createProject(credential, owner, title);
}

export interface SyncSpecOnDoneOptions {
  /** The git working tree root (where .git lives). */
  repoDir: string;
  /** Board root; defaults to <repoDir>/docs/kanban. */
  boardRoot?: string;
  /** The parent Spec ref to sync (G4.S5.T9 → G4.S5). */
  specRef: string;
  /** GitHub owner override (default GITHUB_OWNER env, else the origin remote). */
  owner?: string;
  /** GitHub repo override (default GITHUB_REPO env, else the origin remote). */
  repo?: string;
  /** GitHub token override (default GITHUB_TOKEN env, else gh CLI / athena store). */
  token?: string;
}

/**
 * Run the md → GitHub sync for a Spec (idempotent createSpecIssue: Spec main
 * issue + ticket sub-issues + Status columns + blocked_by deps). Resolves the
 * credential and owner/repo, scans the board, and pushes the projection.
 */
export async function syncSpecOnDone(options: SyncSpecOnDoneOptions): Promise<void> {
  const boardRoot = options.boardRoot ?? path.join(options.repoDir, "docs", "kanban");
  const { owner, repo } = await resolveGithubRepo(options.repoDir, options.owner, options.repo);
  const credential = await resolveGithubCredential(options.token);
  const github = new GithubClient();
  const board = await scanBoard(boardRoot, { includeBody: true });
  const project = await resolveProject(github, credential, owner, repo);
  await createSpecIssue(github, credential, owner, repo, board, options.specRef, project);
}
