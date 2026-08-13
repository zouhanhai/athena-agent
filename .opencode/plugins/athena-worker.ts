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
import { parseTicketRef } from "../../opencode-plugin/src/ticket-ref.js";
import { claimTicketWithIndex, ClaimConflictError } from "../../opencode-plugin/src/claim.js";
import { ProgressAppender } from "../../opencode-plugin/src/progress-log.js";

const DEFAULT_ASSIGNEE = "opencode";
const DEFAULT_MIN_INTERVAL_MS = 30_000;

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

    const sessions = new Map<string, { ref?: string; claimed: boolean; conflicted?: string }>();
    const appender = new ProgressAppender({ boardRoot, minIntervalMs });

    function state(sessionID: string): { ref?: string; claimed: boolean; conflicted?: string } {
      let s = sessions.get(sessionID);
      if (!s) {
        s = { claimed: false };
        sessions.set(sessionID, s);
      }
      return s;
    }

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

        try {
          await claimTicketWithIndex({
            repoDir,
            boardRoot,
            ref: s.ref,
            assignee,
            sessionId: input.sessionID,
          });
          s.claimed = true;
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
