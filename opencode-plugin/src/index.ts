/**
 * OpenCode worker plugin for the athena git-kanban protocol (G4.S4.T1).
 *
 * Global/resident: loaded at opencode serve startup from `.opencode/plugins/`
 * (git-kanban-design.md §18). Distinguishes workers by sessionID, parses the
 * ticket ref from the first dispatch message, auto-claims on the first tool
 * call (git push = mutual-exclusion lock), and appends Progress Log rows with
 * REAL wall-clock UTC timestamps, rate-limited, on real changes only.
 *
 * Plugin contract (opencode classic plugin API): default export { id, server }.
 * The types are declared structurally to keep the plugin self-contained and
 * unit-testable without an installed @opencode-ai/plugin package.
 */

import path from "node:path";
import { access } from "node:fs/promises";
import { parseTicketRef } from "./ticket-ref.js";
import { claimTicketWithIndex, ClaimConflictError } from "./claim.js";
import { ProgressAppender } from "./progress-log.js";

/** Minimal structural subset of the opencode plugin context (classic API). */
export interface WorkerPluginContext {
  /** The current project info. */
  project: { id: string };
  /** The current working directory (project root). */
  directory: string;
  /** The git worktree path. */
  worktree: string;
  /** An opencode SDK client for interacting with the AI. */
  client: {
    session: {
      messages(args: {
        path: { id: string };
        query?: { limit?: number };
      }): Promise<Array<{ info: { role?: string }; parts: Array<{ type?: string; text?: string }> }>>;
    };
    app: {
      log(args: {
        body: { service?: string; level: string; message: string; extra?: Record<string, unknown> };
      }): Promise<unknown>;
    };
  };
}

/** Hooks returned by the plugin's server function. */
export interface WorkerHooks {
  "chat.message"?: (
    input: { sessionID: string; agent?: string; messageID?: string },
    output: { message: unknown; parts: Array<{ type?: string; text?: string }> },
  ) => Promise<void>;
  "tool.execute.before"?: (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: unknown },
  ) => Promise<void>;
  "tool.execute.after"?: (
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title: string; output: string; metadata: unknown },
  ) => Promise<void>;
}

/** Per-session worker state. */
export interface WorkerState {
  ref?: string;
  claimed: boolean;
  conflicted?: string;
}

export interface WorkerPluginOptions {
  /** Worker identity recorded as assignee on claims. Defaults to "opencode". */
  assignee?: string;
  /** Override the repo dir (defaults to the plugin's project directory). */
  repoDir?: string;
  /** Progress Log rate-limit window in ms. */
  minIntervalMs?: number;
}

const DEFAULT_ASSIGNEE = "opencode";

/** True when the repo actually has a kanban board (docs/kanban). */
async function isAthenaRepo(repoDir: string): Promise<boolean> {
  try {
    await access(path.join(repoDir, "docs", "kanban"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the plugin instance. Returns a hooks object consumed by opencode serve.
 */
export function createWorkerHooks(
  ctx: WorkerPluginContext,
  options: WorkerPluginOptions = {},
): WorkerHooks {
  const assignee = options.assignee ?? DEFAULT_ASSIGNEE;
  const repoDir = options.repoDir ?? ctx.directory;
  const boardRoot = path.join(repoDir, "docs", "kanban");
  const minIntervalMs = options.minIntervalMs ?? 30_000;

  const sessions = new Map<string, WorkerState>();
  const appender = new ProgressAppender({ boardRoot, minIntervalMs });

  function state(sessionID: string): WorkerState {
    let s = sessions.get(sessionID);
    if (!s) {
      s = { claimed: false };
      sessions.set(sessionID, s);
    }
    return s;
  }

  function textOf(parts: Array<{ type?: string; text?: string }>): string {
    return (parts ?? [])
      .filter((part) => part?.type === "text" && part.text)
      .map((part) => part.text as string)
      .join("\n");
  }

  return {
    // First dispatch message carries the structured prompt (§13): capture the ref.
    "chat.message": async (input, output) => {
      const s = state(input.sessionID);
      if (s.ref) return;
      const ref = parseTicketRef(textOf(output.parts));
      if (ref) s.ref = ref;
    },

    // Auto-claim on the first tool call: the git push takes effect before work.
    "tool.execute.before": async (input) => {
      const s = state(input.sessionID);
      if (!s.ref || s.claimed) return;
      if (s.conflicted) {
        throw new Error(`ClaimConflictError: ${s.conflicted}`);
      }
      if (!(await isAthenaRepo(repoDir))) return;

      try {
        await claimTicketWithIndex({
          repoDir,
          boardRoot,
          ref: s.ref,
          assignee,
          sessionId: input.sessionID,
        });
        s.claimed = true;
        await ctx.client.app.log({
          body: {
            service: "athena.worker",
            level: "info",
            message: `claimed ${s.ref} (session ${input.sessionID})`,
          },
        });
      } catch (err) {
        if (err instanceof ClaimConflictError) {
          s.conflicted = err.message;
          throw new Error(`ClaimConflictError: ${err.message}`);
        }
        throw err;
      }
    },

    // Append a Progress Log row on a real change (a tool ran), rate-limited,
    // stamped with the real wall-clock time.
    "tool.execute.after": async (input) => {
      const s = state(input.sessionID);
      if (!s.ref || !s.claimed) return;
      await appender.append(s.ref, "in_progress", `ran ${input.tool}`);
    },
  };
}

/** The plugin module default export, loaded from .opencode/plugins/. */
export default {
  id: "athena.worker",
  server: async (input: WorkerPluginContext, options: WorkerPluginOptions = {}) =>
    createWorkerHooks(input, options),
};
