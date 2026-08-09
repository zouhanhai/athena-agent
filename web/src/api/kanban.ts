/**
 * Frontend API layer for the kanban board (G3.S6.T6 + G3.S4.T4 + G3.S4.T7).
 * Types mirror the server root index schema (server/src/kanban/index-file.ts),
 * which /api/kanban serves from a single kanban-index.json (fast refresh).
 * Scoped to the signed-in employee via their session token.
 */

/** Ticket statuses follow the git-driven state machine. */
export type TicketStatus =
  | "backlog"
  | "in_progress"
  | "done"
  | "in_review"
  | "approved"
  | "rejected"
  | "canceled";

/** The six ticket status columns in kanban order. */
export const TICKET_STATUSES: TicketStatus[] = [
  "backlog",
  "in_progress",
  "done",
  "in_review",
  "approved",
  "rejected",
  "canceled",
];

/** A cached ticket: every field the Workbench needs, incl. live Progress Log state. */
export interface KanbanIndexTicket {
  ref: string;
  id: string;
  title: string;
  owner: string;
  status: TicketStatus;
  assignee: string;
  session_id?: string;
  blocked_by: string[];
  acceptance_criteria: string[];
  started_at?: string;
  completed_at?: string;
  progress_last_row?: string;
  progress_updated_at?: string;
}

/** A cached spec with its child tickets. */
export interface KanbanIndexSpec {
  ref: string;
  id: string;
  title: string;
  owner: string;
  status: string;
  milestone?: string;
  tickets: KanbanIndexTicket[];
}

/** A cached goal with its child specs. */
export interface KanbanIndexGoal {
  ref: string;
  id: string;
  title: string;
  owner: string;
  status: string;
  created_at?: string;
  milestone?: string;
  specs: KanbanIndexSpec[];
}

export interface KanbanIndexError {
  file: string;
  error: string;
}

/** The root index document served by GET /api/kanban. */
export interface KanbanIndex {
  version: number;
  generated_at: string;
  goals: KanbanIndexGoal[];
  errors: KanbanIndexError[];
}

/**
 * GET /api/kanban → the board served from the root index file (fast).
 * `repo` selects a remote repo's board (via the employee's credential);
 * `rescan=true` forces the server to re-scan the md files and rebuild the index.
 */
export async function fetchBoard(
  sessionToken: string,
  repo?: string,
  rescan?: boolean,
): Promise<KanbanIndex> {
  const params = new URLSearchParams();
  if (repo) {
    params.set("repo", repo);
  }
  if (rescan) {
    params.set("rescan", "1");
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const res = await fetch(`/api/kanban${suffix}`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    const message =
      detail && typeof (detail as { error?: unknown }).error === "string"
        ? (detail as { error: string }).error
        : `Request failed with status ${res.status}`;
    throw new Error(message);
  }
  return (await res.json()) as KanbanIndex;
}
