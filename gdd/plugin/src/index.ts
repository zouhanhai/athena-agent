/**
 * OpenCode worker plugin for the athena git-kanban protocol (G4.S4.T1/T3).
 *
 * Global/resident: loaded at opencode serve startup from `.opencode/plugins/`
 * (git-kanban-design.md §18) and deployed to `~/.config/opencode/plugins/`
 * (G4.S4.T3). Distinguishes workers by sessionID, parses the ticket ref from
 * the first dispatch message, auto-claims on the first tool call (git push =
 * mutual-exclusion lock, exactly once per session even under concurrent tool
 * calls), appends Progress Log rows with REAL wall-clock UTC timestamps
 * (rate-limited + callID-deduped so one tool call appends at most one row),
 * and on `session.idle` runs the md → GitHub auto-sync for the ticket's parent
 * Spec when the claimed ticket is `done` (G4.S5.T10).
 *
 * Plugin contract (opencode classic plugin API): default export { id, server }.
 * The types are declared structurally to keep the plugin self-contained and
 * unit-testable without an installed @opencode-ai/plugin package.
 */

import path from "node:path";
import { access } from "node:fs/promises";
import { readTicketFile } from "../../src/kanban/board.js";
import { parseTicketRef } from "./ticket-ref.js";
import { claimTicketWithIndex, ClaimConflictError } from "./claim.js";
import { ProgressAppender } from "./progress-log.js";
import {
  specRefFromTicketRef,
  syncSpecOnDone,
  type SyncSpecOnDoneOptions,
} from "./auto-sync.js";

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
  event?: (input: { event: { type?: string; properties?: { sessionID?: string } } }) => Promise<void>;
}

/** Per-session worker state. */
export interface WorkerState {
  ref?: string;
  claimed: boolean;
  conflicted?: string;
  /** In-flight claim promise — dedupes concurrent tool calls in the same tick. */
  claimPromise?: Promise<void>;
  /** callIDs already appended to the Progress Log — one row per tool call. */
  appended?: Set<string>;
}

export interface WorkerPluginOptions {
  /** Worker identity recorded as assignee on claims. Defaults to "opencode". */
  assignee?: string;
  /** Override the repo dir (defaults to the plugin's project directory). */
  repoDir?: string;
  /** Progress Log rate-limit window in ms. */
  minIntervalMs?: number;
  /** Clock override for tests; defaults to the real wall clock. */
  now?: () => Date;
  /**
   * md → GitHub auto-sync run after the index done commit for the done ticket's
   * parent Spec (G4.S5.T10). Defaults to the real sync; tests inject a mock to
   * assert the invocation and simulate best-effort failures.
   */
  syncSpecOnDone?: (options: SyncSpecOnDoneOptions) => Promise<unknown>;
}

const DEFAULT_ASSIGNEE = "opencode";
const DEFAULT_MIN_INTERVAL_MS = 30_000;

// Module-level state — opencode re-invokes server() per event/call, so any
// state that must persist across a session's tool calls CANNOT live inside the
// server()/createWorkerHooks closure (it would reset on every call and the
// plugin would re-attempt the claim forever / duplicate Progress Log rows).
const sessions = new Map<string, WorkerState>();
const appenders = new Map<string, ProgressAppender>();

/** True when the repo actually has a kanban board (docs/kanban). */
async function isAthenaRepo(repoDir: string): Promise<boolean> {
  try {
    await access(path.join(repoDir, "docs", "kanban"));
    return true;
  } catch {
    return false;
  }
}

function state(sessionID: string): WorkerState {
  let s = sessions.get(sessionID);
  if (!s) {
    s = { claimed: false, appended: new Set() };
    sessions.set(sessionID, s);
  }
  return s;
}

function appenderFor(
  boardRoot: string,
  options: { minIntervalMs: number; now?: () => Date },
): ProgressAppender {
  let appender = appenders.get(boardRoot);
  if (!appender) {
    appender = new ProgressAppender({
      boardRoot,
      minIntervalMs: options.minIntervalMs,
      now: options.now,
    });
    appenders.set(boardRoot, appender);
  }
  return appender;
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
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const syncSpec = options.syncSpecOnDone ?? syncSpecOnDone;

  const appender = appenderFor(boardRoot, { minIntervalMs, now: options.now });

  function textOf(parts: Array<{ type?: string; text?: string }>): string {
    return (parts ?? [])
      .filter((part) => part?.type === "text" && part.text)
      .map((part) => part.text as string)
      .join("\n");
  }

  async function runClaim(sessionID: string, ref: string): Promise<void> {
    if (!(await isAthenaRepo(repoDir))) return;
    await claimTicketWithIndex({
      repoDir,
      boardRoot,
      ref,
      assignee,
      sessionId: sessionID,
    });
    const s = state(sessionID);
    s.claimed = true;
    await ctx.client.app.log({
      body: {
        service: "athena.worker",
        level: "info",
        message: `claimed ${ref} (session ${sessionID})`,
      },
    });
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
    // Concurrent tool calls in the same tick share ONE in-flight claim promise
    // (set synchronously before any await), so the claim runs exactly once per
    // session — no duplicate claim rows / claim commits / ClaimConflictError.
    "tool.execute.before": async (input) => {
      const s = state(input.sessionID);
      if (!s.ref || s.claimed) return;
      if (s.conflicted) {
        throw new Error(`ClaimConflictError: ${s.conflicted}`);
      }
      if (!s.claimPromise) {
        s.claimPromise = runClaim(input.sessionID, s.ref).catch((err) => {
          if (err instanceof ClaimConflictError) {
            const s2 = state(input.sessionID);
            s2.conflicted = err.message;
            throw new Error(`ClaimConflictError: ${err.message}`);
          }
          throw err;
        });
      }
      await s.claimPromise;
    },

    // Append a Progress Log row on a real change (a tool ran), rate-limited and
    // callID-deduped so ONE tool call appends at most ONE row even if the
    // after-event double-fires. Stamped with the real wall-clock time.
    "tool.execute.after": async (input) => {
      const s = state(input.sessionID);
      if (!s.ref || !s.claimed) return;
      if (s.appended!.has(input.callID)) return;
      s.appended!.add(input.callID);
      if (s.appended!.size > 1024) s.appended!.clear();
      await appender.append(s.ref, "in_progress", `ran ${input.tool}`);
    },

    // md → GitHub auto-sync on done (G4.S5.T10): when the claimed ticket is
    // done, session.idle runs the sync for the ticket's parent Spec so the
    // GitHub board's Status columns update automatically — best-effort, a sync
    // failure is logged and never blocks the idling session.
    event: async (input) => {
      const evt = input.event;
      if (!evt || evt.type !== "session.idle") return;
      const sessionID = evt.properties?.sessionID;
      if (!sessionID) return;
      const s = sessions.get(sessionID);
      if (!s?.ref || !s.claimed) return;
      if (!(await isAthenaRepo(repoDir))) return;
      let ticketStatus = "";
      try {
        ticketStatus = (await readTicketFile(boardRoot, s.ref)).ticket.status;
      } catch {
        // Unreadable ticket file — nothing to sync.
        return;
      }
      if (ticketStatus !== "done") return;
      const specRef = specRefFromTicketRef(s.ref);
      if (!specRef) return;
      try {
        await syncSpec({ repoDir, boardRoot, specRef });
      } catch (err) {
        // Best-effort: log the failure, never block the idling session.
        await ctx.client.app.log({
          body: {
            service: "athena.worker",
            level: "error",
            message: `md→GitHub sync for ${specRef} failed (best-effort, done not blocked): ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        });
      }
    },
  };
}

/** The plugin module default export, loaded from .opencode/plugins/. */
export default {
  id: "athena.worker",
  server: async (input: WorkerPluginContext, options: WorkerPluginOptions = {}) =>
    createWorkerHooks(input, options),
};
