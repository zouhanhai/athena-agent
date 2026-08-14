/**
 * md → GitHub auto-sync for the OpenCode worker plugin (G4.S5.T10).
 *
 * When a worker marks a ticket `done`, the session.idle handler runs the md →
 * GitHub sync for the ticket's parent Spec so the GitHub Project board's Status
 * columns update automatically — no manual `sync-github sync <specRef>` needed.
 *
 * The sync is best-effort: a failure is logged by the caller and never blocks
 * the done commit. Credential resolution mirrors the `sync-github` CLI
 * (server/scripts/sync-github.ts): an explicit token → `GITHUB_TOKEN` env → the
 * athena employee GitHub credential store. The owner/repo come from explicit
 * options → `GITHUB_OWNER`/`GITHUB_REPO` env → the `origin` remote.
 */

import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scanBoard } from "../../server/src/kanban/scan.js";
import { createSpecIssue } from "../../server/src/kanban/github-sync.js";
import {
  GithubRestClient,
  type GithubProject,
} from "../../server/src/github/client.js";
import {
  defaultSecretCipher,
} from "../../server/src/employees/crypto.js";
import {
  MemoryEmployeeRegistry,
  PostgresEmployeeRegistry,
  type EmployeeRegistry,
  type GithubCredential,
} from "../../server/src/employees/employees.js";

const execFileAsync = promisify(execFile);

/** The employee whose stored GitHub credential the auto-sync uses by default. */
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
 * `GITHUB_REPO` env → the `origin` git remote (github.com URLs only).
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
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd: repoDir,
    });
    const match = stdout.trim().match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
  } catch {
    // no origin remote → fall through to the error below
  }
  throw new Error(
    `unable to determine the GitHub owner/repo for ${repoDir} ` +
      "(set GITHUB_OWNER/GITHUB_REPO or configure a github.com origin remote)",
  );
}

/** The default employee registry (Postgres when DATABASE_URL is set, else in-memory). */
function employeeRegistry(): EmployeeRegistry {
  const cipher = defaultSecretCipher();
  const connectionString = process.env.DATABASE_URL;
  return connectionString
    ? new PostgresEmployeeRegistry({ connectionString, cipher })
    : new MemoryEmployeeRegistry([], { cipher });
}

/**
 * Resolve a GitHub credential: an explicit token → `GITHUB_TOKEN` env → the
 * athena employee GitHub credential store (default employee `zouha108@caleo.com`,
 * override with `GITHUB_EMPLOYEE`).
 */
export async function resolveGithubCredential(
  token?: string,
  employeeEmail?: string,
): Promise<GithubCredential> {
  const value = token ?? process.env.GITHUB_TOKEN;
  if (value) {
    return { type: "token", value };
  }
  const email = employeeEmail ?? process.env.GITHUB_EMPLOYEE ?? DEFAULT_SYNC_EMPLOYEE;
  const registry = employeeRegistry();
  try {
    await registry.seed();
    const credential = await registry.getGithubCredential(email);
    if (!credential) {
      throw new Error(
        `no GitHub credential for "${email}" in the athena employee store ` +
          "(set GITHUB_TOKEN or GITHUB_EMPLOYEE)",
      );
    }
    return credential;
  } finally {
    await registry.close();
  }
}

/** The Project board for the repo: reuse by title, else create. */
async function resolveProject(
  github: GithubRestClient,
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
  /** GitHub token override (default GITHUB_TOKEN env, else the employee store). */
  token?: string;
  /** Employee whose stored credential is used (default GITHUB_EMPLOYEE env). */
  employeeEmail?: string;
}

/**
 * Run the md → GitHub sync for a Spec (idempotent createSpecIssue: Spec main
 * issue + ticket sub-issues + Status columns + blocked_by deps). Resolves the
 * credential and owner/repo, scans the board, and pushes the projection.
 */
export async function syncSpecOnDone(options: SyncSpecOnDoneOptions): Promise<void> {
  const boardRoot = options.boardRoot ?? path.join(options.repoDir, "docs", "kanban");
  const { owner, repo } = await resolveGithubRepo(options.repoDir, options.owner, options.repo);
  const credential = await resolveGithubCredential(options.token, options.employeeEmail);
  const github = new GithubRestClient();
  const board = await scanBoard(boardRoot, { includeBody: true });
  const project = await resolveProject(github, credential, owner, repo);
  await createSpecIssue(github, credential, owner, repo, board, options.specRef, project);
}
