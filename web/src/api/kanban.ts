/**
 * Frontend API layer for the kanban docs-scan board (G3.S6.T6 + G3.S4.T4).
 * Types mirror the server board schema (server/src/kanban/schema.ts + scan.ts).
 * Scoped to the signed-in employee via their session token.
 */

/** Ticket statuses follow the git-driven state machine. */
export type TicketStatus =
  | "backlog"
  | "in_progress"
  | "done"
  | "in_review"
  | "approved"
  | "rejected";

/** The six ticket status columns in kanban order. */
export const TICKET_STATUSES: TicketStatus[] = [
  "backlog",
  "in_progress",
  "done",
  "in_review",
  "approved",
  "rejected",
];

interface BoardFrontmatterBase {
  id: string;
  title: string;
  owner: string;
  status: string;
}

export interface GoalFrontmatter extends BoardFrontmatterBase {
  layer: "G";
  created_at?: string;
  milestone?: string;
  acceptance_criteria: string[];
}

export interface SpecFrontmatter extends BoardFrontmatterBase {
  layer: "S";
  parent: string;
  milestone?: string;
  acceptance_criteria: string[];
}

export interface TicketFrontmatter extends BoardFrontmatterBase {
  layer: "T";
  parent: string;
  status: TicketStatus;
  assignee: string;
  session_id?: string;
  started_at?: string;
  completed_at?: string;
  blocked_by: string[];
  acceptance_criteria: string[];
}

export interface BoardTicket {
  ref: string;
  ticket: TicketFrontmatter;
}

export interface BoardSpec {
  ref: string;
  spec: SpecFrontmatter;
  tickets: BoardTicket[];
}

export interface BoardGoal {
  ref: string;
  goal: GoalFrontmatter;
  specs: BoardSpec[];
}

export interface BoardError {
  file: string;
  error: string;
}

export interface KanbanBoard {
  goals: BoardGoal[];
  errors: BoardError[];
}

/** GET /api/kanban (optionally ?repo=owner/repo) → the docs-scanned board. */
export async function fetchBoard(sessionToken: string, repo?: string): Promise<KanbanBoard> {
  const params = new URLSearchParams();
  if (repo) {
    params.set("repo", repo);
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
  return (await res.json()) as KanbanBoard;
}
