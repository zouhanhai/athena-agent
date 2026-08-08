/**
 * G.S.T worker claim/report protocol + planning dispatch.
 *
 * The worker claims a ticket via git claim-lock (status/assignee/session_id
 * pushed to git = mutual exclusion), then reports done/in_review with a PR
 * number. The planning agent dispatches by notifying a worker which ticket
 * to take (dispatchNotice/dispatchNext).
 *
 * This module mutates the board md only; the git commit + push that makes a
 * claim/report mutually exclusive lives in ./git-lock.ts (GitClaimLock).
 */

import { readTicketFile, writeBoardFile } from "./board.js";
import { scanBoard, type KanbanBoard, type BoardTicket } from "./scan.js";
import { transitionsTo } from "./state-machine.js";
import type { TicketFrontmatter, TicketStatus } from "./schema.js";

/** Thrown when a ticket cannot be claimed because it is not claimable. */
export class ClaimError extends Error {}

/** Thrown when a ticket cannot be reported (wrong state or missing fields). */
export class ReportError extends Error {}

/** Worker identity + session for a git claim-lock. */
export interface ClaimInput {
  assignee: string;
  /** OpenCode serve session handling this ticket (parallel workers). */
  sessionId: string;
  /** Date used for started_at + log entry; defaults to today (YYYY-MM-DD). */
  now?: string;
}

export interface ClaimResult {
  ref: string;
  /** The log entry appended to the ticket body. */
  log: string;
}

/** A status a worker can report after claiming: implementation done, or PR open. */
export type ReportStatus = "done" | "in_review";

export interface ReportInput {
  status: ReportStatus;
  /** GitHub PR number; required when status is in_review. */
  pr?: number;
  branch?: string;
  note?: string;
  /** Date used for completed_at + log entry; defaults to today (YYYY-MM-DD). */
  now?: string;
}

export interface ReportResult {
  ref: string;
  log: string;
}

/** In which statuses a worker may report each status — derived from the state machine. */
const REPORTABLE: Record<ReportStatus, readonly TicketStatus[]> = {
  done: transitionsTo("done"),
  in_review: transitionsTo("in_review"),
};

/** Statuses that resolve a blocker, i.e. the blocking ticket no longer blocks. */
const DONE_STATUSES: readonly TicketStatus[] = ["done", "approved"];

function today(now: string | undefined): string {
  return now ?? new Date().toISOString().slice(0, 10);
}

/** Load the board file at ref, failing when it is not a ticket (layer T). */
async function loadTicket(
  root: string,
  ref: string,
  fail: (message: string) => Error,
): Promise<{ doc: Awaited<ReturnType<typeof readTicketFile>>["doc"]; ticket: TicketFrontmatter }> {
  try {
    return await readTicketFile(root, ref);
  } catch (err) {
    throw fail(err instanceof Error ? err.message : String(err));
  }
}

/** Append a `## Log` entry to a ticket body; creates the section when missing. */
export function appendLog(body: string, date: string, entry: string): string {
  const trimmed = body.replace(/\s+$/, "");
  const line = `[${date}] ${entry}`;
  if (!/^## Log/m.test(trimmed)) {
    return `${trimmed}\n\n## Log\n\n${line}\n`;
  }
  return `${trimmed}\n\n${line}\n`;
}

/**
 * Worker claims a ticket: validates it is claimable (backlog, unassigned to
 * someone else, never rejected), then writes status/assignee/session_id/
 * started_at and appends a Log entry. The caller (GitClaimLock) makes the
 * write mutually exclusive by git-pushing it.
 */
export async function claimTicket(
  root: string,
  ref: string,
  input: ClaimInput,
): Promise<ClaimResult> {
  const { doc, ticket } = await loadTicket(root, ref, (msg) => new ClaimError(msg));
  if (ticket.status === "rejected") {
    throw new ClaimError(
      `ticket ${ref} is rejected and cannot be claimed directly; notify the Eng Director to re-decompose`,
    );
  }
  if (ticket.status !== "backlog") {
    throw new ClaimError(
      `ticket ${ref} cannot be claimed: status is ${ticket.status}, expected backlog`,
    );
  }
  if (ticket.assignee !== "" && ticket.assignee !== input.assignee) {
    throw new ClaimError(
      `ticket ${ref} cannot be claimed: assignee is ${ticket.assignee}, not ${input.assignee}`,
    );
  }
  if (!input.assignee || input.assignee.trim() === "") {
    throw new ClaimError(`assignee is required to claim ${ref}`);
  }

  const date = today(input.now);
  const updated: TicketFrontmatter = {
    ...ticket,
    status: "in_progress",
    assignee: input.assignee,
    session_id: input.sessionId,
    started_at: ticket.started_at || date,
  };
  const log = appendLog(doc.body, date, `${input.assignee} claimed ${ref} (session ${input.sessionId})`);
  await writeBoardFile(root, { ref, frontmatter: updated, body: log });
  return { ref, log };
}

/**
 * Worker reports completion: done (implementation complete) or in_review
 * (a PR is open and pending review). Records pr/branch/completed_at and
 * appends a Log entry.
 */
export async function reportTicket(
  root: string,
  ref: string,
  input: ReportInput,
): Promise<ReportResult> {
  const { doc, ticket } = await loadTicket(root, ref, (msg) => new ReportError(msg));
  const allowed = REPORTABLE[input.status];
  if (!allowed.includes(ticket.status)) {
    throw new ReportError(
      `cannot report ${input.status} on ${ref}: ticket is ${ticket.status}, expected ${allowed.join(" or ")}`,
    );
  }
  if (input.status === "in_review" && (input.pr === undefined || !Number.isInteger(input.pr) || input.pr <= 0)) {
    throw new ReportError(`reporting ${ref} as in_review requires a positive pr number`);
  }

  const date = today(input.now);
  const updated: TicketFrontmatter = {
    ...ticket,
    status: input.status,
    completed_at: date,
    ...(input.pr !== undefined ? { pr: input.pr } : {}),
    ...(input.branch ? { branch: input.branch } : {}),
  };
  const bits: string[] = [input.status];
  if (input.pr !== undefined) bits.push(`pr#${input.pr}`);
  if (input.note) bits.push(input.note);
  const log = appendLog(doc.body, date, `${ticket.assignee} reported ${bits.join(" ")} on ${ref}`);
  await writeBoardFile(root, { ref, frontmatter: updated, body: log });
  return { ref, log };
}

/** A ticket the planning agent can dispatch to a worker. */
export interface ClaimableTicket {
  ref: string;
  title: string;
  parent: string;
  acceptance_criteria: string[];
}

/** Statuses that resolve a blocker; a ticket is claimable when all blockers are resolved. */
function isResolved(status: TicketStatus | undefined): boolean {
  return status !== undefined && DONE_STATUSES.includes(status);
}

/** True when every blocked_by ref is done/approved (or the ticket has no blockers). */
function unblocked(board: KanbanBoard, ticket: TicketFrontmatter): boolean {
  return ticket.blocked_by.every((blocker) => isResolved(findTicket(board, blocker)?.ticket.status));
}

function findTicket(board: KanbanBoard, ref: string): BoardTicket | undefined {
  for (const goal of board.goals) {
    for (const spec of goal.specs) {
      const hit = spec.tickets.find((t) => t.ref === ref);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** Resolve the unresolved blocked_by refs of a ticket on a scanned board. */
function unresolvedBlockers(board: KanbanBoard, ticket: TicketFrontmatter): string[] {
  return ticket.blocked_by.filter((blocker) => !isResolved(findTicket(board, blocker)?.ticket.status));
}

/**
 * Tickets the planning agent can dispatch: backlog, unassigned, not rejected
 * and not blocked by an incomplete ticket. This is the "who should do what"
 * selection from git-kanban-design.md §10.
 */
export function claimableTickets(board: KanbanBoard): ClaimableTicket[] {
  const out: ClaimableTicket[] = [];
  for (const goal of board.goals) {
    for (const spec of goal.specs) {
      for (const { ref, ticket } of spec.tickets) {
        if (ticket.status !== "backlog" || ticket.assignee !== "") {
          continue;
        }
        if (!unblocked(board, ticket)) continue;
        out.push({ ref, title: ticket.title, parent: ticket.parent, acceptance_criteria: ticket.acceptance_criteria });
      }
    }
  }
  return out;
}

/** A planning-agent dispatch instruction for a worker to take a ticket. */
export interface DispatchNotice {
  ref: string;
  title: string;
  /** Unresolved blocker refs; empty when the ticket is claimable. */
  blockedBy: string[];
  /** Notification text the planning agent sends to the worker. */
  message: string;
}

const CLAIM_HINT = "Claim via git: set status=in_progress + assignee + session_id, then push";

/**
 * Build the notification the planning agent sends to dispatch a ticket to a
 * worker. Returns null for an unknown ticket or one not in backlog. A ticket
 * blocked by unfinished work is still described, but flagged as blocked.
 */
export function dispatchNotice(
  board: KanbanBoard,
  ref: string,
  worker?: string,
): DispatchNotice | null {
  const ticket = findTicket(board, ref);
  if (!ticket || ticket.ticket.status !== "backlog") {
    return null;
  }
  const blockedBy = unresolvedBlockers(board, ticket.ticket);
  const who = worker ? ` to ${worker}` : "";
  const message =
    blockedBy.length > 0
      ? `Take ${ref} blocked by ${blockedBy.join(", ")} — ${ticket.ticket.title}. ${CLAIM_HINT}.`
      : `Take ${ref}${who}: ${ticket.ticket.title}. ${CLAIM_HINT}.`;
  return { ref, title: ticket.ticket.title, blockedBy, message };
}

/**
 * Planning-agent dispatch: scan the board, pick the first claimable ticket and
 * return the notification for a worker. Returns null when nothing is claimable.
 */
export async function dispatchNext(root: string, worker?: string): Promise<DispatchNotice | null> {
  const board = await scanBoard(root);
  const next = claimableTickets(board)[0];
  if (!next) return null;
  return dispatchNotice(board, next.ref, worker);
}
