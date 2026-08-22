/**
 * Done-requires-push guard (G4.S8.T18).
 *
 * Motivation: T14 and T17 were both marked `done` while their ticket commits
 * sat UNPUSHED — "done" silently lied. This module hard-verifies that the
 * worker's HEAD commit is actually reachable on the canonical remote branch
 * (`caleo/master`) before the plugin accepts a done state: `git fetch` +
 * ancestry check (`git merge-base --is-ancestor HEAD <remoteRef>`). An unpushed
 * HEAD throws `DoneRequiresPushError` so the worker is told to push first.
 */

import { execFile } from "node:child_process";

/** The remote branch done-tickets must be reachable on (remote/branch). */
export const DEFAULT_REMOTE_REF = "caleo/master";

export interface VerifyHeadPushedOptions {
  /** The git working tree root (where .git lives). */
  repoDir: string;
  /** The remote ref HEAD must be reachable on. Default: caleo/master. */
  remoteRef?: string;
  /** Injectable command runner (tests). Defaults to child_process.execFile git. */
  run?: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
}

export class DoneRequiresPushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DoneRequiresPushError";
  }
}

const defaultRun = (args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`git ${args.join(" ")} failed: ${String(stderr || err.message).trim()}`));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

/**
 * Verify HEAD is reachable on `<remote>/<branch>` (default caleo/master):
 * fetches the remote tip, then requires `merge-base --is-ancestor` to succeed.
 * Throws `DoneRequiresPushError` when HEAD is local-only or the verification
 * itself fails (fail-closed: an unverifiable state never counts as pushed).
 */
export async function verifyHeadPushed(options: VerifyHeadPushedOptions): Promise<void> {
  const remoteRef = options.remoteRef ?? DEFAULT_REMOTE_REF;
  const run = options.run ?? defaultRun;
  const slash = remoteRef.indexOf("/");
  if (slash <= 0) throw new DoneRequiresPushError(`invalid remote ref "${remoteRef}" — expected <remote>/<branch>`);
  const remote = remoteRef.slice(0, slash);
  const branch = remoteRef.slice(slash + 1);

  let head = "";
  try {
    await run(["fetch", "--quiet", remote, branch], options.repoDir);
    const headOut = await run(["rev-parse", "HEAD"], options.repoDir);
    head = headOut.stdout.trim();
    await run(["merge-base", "--is-ancestor", "HEAD", remoteRef], options.repoDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DoneRequiresPushError(
      `done-requires-push: could not verify HEAD ${head || "(unresolved)"} is reachable on ${remoteRef} — ${message}`,
    );
  }
}
