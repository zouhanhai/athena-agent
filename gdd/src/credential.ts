/**
 * GDD credential resolution — LOCAL-token-first, so the `gdd` package runs
 * standalone on the user's machine (no athena server / DB / employee store):
 *
 *   1. an explicit `token` override (plugin/CLI option)
 *   2. `gh auth token` — the gh CLI's authenticated token (gh CLI / hosts.yml)
 *   3. `GITHUB_TOKEN` env
 *   4. the athena employee store ONLY as an optional fallback, via an injected
 *      `employeeReader` (wired when running inside athena; absent standalone)
 *
 * GDD never imports athena's employees/github-client statically — the fallback
 * is injected so a fresh machine with just a local gh token works unchanged.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GithubCredential } from "./github/types.js";

const execFileAsync = promisify(execFile);

/** The default employee whose stored credential is the last-resort fallback. */
export const DEFAULT_SYNC_EMPLOYEE = "zouha108@caleo.com";

/** The optional athena employee-store reader, injected when running inside athena. */
export type EmployeeCredentialReader = (
  email: string,
) => Promise<{ type: "token"; value: string } | null>;

export interface ResolveCredentialOptions {
  /** Explicit token override (plugin/CLI option); wins over everything. */
  token?: string;
  /**
   * Pre-resolved `gh auth token` output for tests. When `undefined` the real
   * gh CLI is probed; pass `null` to simulate a gh failure without probing.
   */
  ghToken?: string | null;
  /** When false, the gh CLI is never probed. */
  ghEnabled?: boolean;
  /** Employee for the athena-store fallback (default GITHUB_EMPLOYEE env). */
  employeeEmail?: string;
  /** Optional athena employee-store reader (wired when running inside athena). */
  employeeReader?: EmployeeCredentialReader;
}

/** Probe `gh auth token`; returns the trimmed token or null when unavailable. */
export async function ghAuthToken(ghBin = "gh"): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(ghBin, ["auth", "token"]);
    const token = stdout.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** The athena employee to try in the fallback (GITHUB_EMPLOYEE env → default). */
export function defaultEmployeeEmail(override?: string): string {
  return override ?? process.env.GITHUB_EMPLOYEE ?? DEFAULT_SYNC_EMPLOYEE;
}

/**
 * Resolve the GitHub credential LOCAL-token-first (gh auth → GITHUB_TOKEN env →
 * optional athena employee store). Throws a helpful error when nothing resolves.
 */
export async function resolveGithubCredential(
  options: ResolveCredentialOptions = {},
): Promise<GithubCredential> {
  const { token, employeeReader } = options;
  if (token) {
    return { type: "token", value: token, source: "env" };
  }

  const gh = options.ghEnabled !== false
    ? options.ghToken !== undefined
      ? options.ghToken
      : await ghAuthToken()
    : null;
  if (gh) {
    return { type: "token", value: gh, source: "gh" };
  }

  const envToken = process.env.GITHUB_TOKEN;
  if (envToken) {
    return { type: "token", value: envToken, source: "env" };
  }

  if (employeeReader) {
    const email = defaultEmployeeEmail(options.employeeEmail);
    const stored = await employeeReader(email);
    if (stored?.value) {
      return { type: "token", value: stored.value, source: "athena-employee" };
    }
    throw new Error(
      `no GitHub credential for "${email}" in the athena employee store ` +
        "(set GITHUB_TOKEN or a gh auth token, or use GITHUB_EMPLOYEE)",
    );
  }

  throw new Error(
    "no GitHub credential found: set GITHUB_TOKEN or run `gh auth login` (gh auth token) — " +
      "when running inside athena the employee store is used as a last resort (GITHUB_EMPLOYEE)",
  );
}
