/**
 * athena worker OpenCode plugin — auto-claim + Progress Log appender (G4.S4.T1).
 *
 * Loaded at opencode serve startup from `.opencode/plugins/` (git-kanban-design.md
 * §18): global/resident, distinguishes workers by sessionID, parses the ticket
 * ref from the first dispatch message, auto-claims on the first tool call (git
 * push = mutual-exclusion lock), and appends Progress Log rows with real
 * wall-clock UTC timestamps, rate-limited, on real changes only.
 *
 * Classic V1 plugin module: `export default { id, server }`.
 */

import { access } from "node:fs/promises";
import path from "node:path";
// ABSOLUTE paths — this plugin is deployed GLOBALLY (~/.config/opencode/plugins/)
// so it loads for any project regardless of serve cwd. The core logic lives in the
// athena-agent repo and is imported by absolute path (git-kanban-design.md §18).
const CORE_DIR = "/home/hh/athena-agent/opencode-plugin/src";
const { parseTicketRef } = await import(path.join(CORE_DIR, "ticket-ref.js"));
const { claimTicketWithIndex, ClaimConflictError } = await import(path.join(CORE_DIR, "claim.js"));
const { ProgressAppender } = await import(path.join(CORE_DIR, "progress-log.js"));

const DEFAULT_ASSIGNEE = "opencode";
const DEFAULT_MIN_INTERVAL_MS = 30_000;

// Module-level per-session state — MUST live OUTSIDE the server() function so it
// persists across tool calls. opencode re-invokes server() per event/call; if the
// Map lived inside, s.claimed would reset on every tool call and the plugin would
// re-attempt the claim forever, throwing ClaimConflictError on every invocation.
const sessions = new Map<string, { ref?: string; claimed: boolean; conflicted?: string }>();

/** True when the repo actually has a kanban board (docs/kanban). */
async function boardPresent(boardRoot: string): Promise<boolean> {
  try {
    await access(boardRoot);
    return true;
  } catch {
    return false;
  }
}

async function textOf(parts: Array<{ type?: string; text?: string }>): Promise<string> {
  return (parts ?? [])
    .filter((part) => part?.type === "text" && part.text)
    .map((part) => part.text as string)
    .join("\n");
}

function state(sessionID: string): { ref?: string; claimed: boolean; conflicted?: string } {
  let s = sessions.get(sessionID);
  if (!s) {
    s = { claimed: false };
    sessions.set(sessionID, s);
  }
  return s;
}

export default {
  id: "athena.worker",

  server: async (
    ctx: {
      directory: string;
      project: { id: string };
      worktree: string;
      client?: { app?: { log?: (args: unknown) => Promise<unknown> } };
    },
    options: { assignee?: string; repoDir?: string; minIntervalMs?: number } = {},
  ) => {
    const assignee = options.assignee ?? DEFAULT_ASSIGNEE;
    const repoDir = options.repoDir ?? ctx.directory;
    const boardRoot = path.join(repoDir, "docs", "kanban");
    const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;

    const appender = new ProgressAppender({ boardRoot, minIntervalMs });

    return {
      // First dispatch message carries the structured prompt (§13): capture the ref.
      "chat.message": async (input: { sessionID: string }, output: { parts: Array<{ type?: string; text?: string }> }) => {
        const s = state(input.sessionID);
        if (s.ref) return;
        const ref = parseTicketRef(await textOf(output.parts));
        if (ref) s.ref = ref;
      },

      // Auto-claim on the first tool call: the git push takes effect before work.
      "tool.execute.before": async (input: { tool: string; sessionID: string; callID: string }) => {
        const s = state(input.sessionID);
        if (!s.ref || s.claimed) return;
        if (s.conflicted) {
          throw new Error(`ClaimConflictError: ${s.conflicted}`);
        }
        if (!(await boardPresent(boardRoot))) return;

        // Optimistically mark claimed BEFORE the (slow) git claim so concurrent
        // tool calls in the same tick can't re-enter and double-claim. If the
        // claim genuinely fails we set conflicted (worker backs off); we never
        // retry the claim in the same session.
        s.claimed = true;
        try {
          await claimTicketWithIndex({
            repoDir,
            boardRoot,
            ref: s.ref,
            assignee,
            sessionId: input.sessionID,
          });
          await ctx.client?.app?.log?.({
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

      // Append a Progress Log row on a real change (a tool ran), rate-limited.
      "tool.execute.after": async (input: { tool: string; sessionID: string }) => {
        const s = state(input.sessionID);
        if (!s.ref || !s.claimed) return;
        await appender.append(s.ref, "in_progress", `ran ${input.tool}`);
      },
    };
  },
};
