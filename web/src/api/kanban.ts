/**
 * Frontend API layer for the kanban board (G3.S6.T6 + G3.S4.T4 + G3.S4.T7).
 * Types mirror the server root index schema (server/src/kanban/index-file.ts),
 * which /api/kanban serves from a single kanban-index.json (fast refresh).
 * Scoped to the signed-in employee via their session token.
 */

import type { GithubIssue, GithubIssueComment } from "@/api/github";

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
  progress_status?: string;
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

/** A sub-issue (ticket) of a Spec card, for the detail panel's Sub-issues list (G4.S5.T8). */
export interface GithubProjectSubIssue {
  ref: string;
  title: string;
  /** Closed sub-issues read as "done"; everything else is "open". */
  status: string;
  number: number;
}

/**
 * A card on the synced GitHub Project board (G4.S5.T4 + T6). Since T6 the board
 * shows ONE Spec card per Spec (tickets are sub-issues); each card carries its
 * sub-task progress (done/total + percent) for the segmented progress bar and,
 * since T8, its sub-issues list for the detail panel.
 */
export interface GithubProjectCard {
  issueNumber: number;
  /** The spec ref parsed from the issue title (e.g. "G4.S5"), or null. */
  ref: string | null;
  /** The issue title with any ref prefix stripped. */
  title: string;
  /** The Project Status option name, or null when unset. */
  status: string | null;
  /** Link to the GitHub issue. */
  url: string;
  /** Sub-task progress: N sub-issues, done filled (GitHub-native X/N + percent). */
  progress: { done: number; total: number; percent: number };
  /** The Spec's sub-issues (ref/title/status/number) for the detail panel. */
  subIssues: GithubProjectSubIssue[];
}

/** A linked GitHub Project (v2) board, as listed for the project selector (G4.S5.T12). */
export interface GithubProject {
  /** GraphQL node id of the project. */
  id: string;
  title: string;
  number: number;
  url: string;
}

/** A Status column of the synced GitHub Project board. */
export interface GithubProjectColumn {
  status: string;
  cards: GithubProjectCard[];
}

/** The synced GitHub Project board served by GET /api/kanban/github-project. */
export interface GithubProjectBoard {
  project: { id: string; title: string; number: number; url: string } | null;
  columns: GithubProjectColumn[];
  generated_at: string;
}

/**
 * GET /api/kanban/github-projects?repo=owner/repo → the repo's OPEN linked
 * Projects (closed ones are filtered out server-side), for the project selector
 * (G4.S5.T12). Throws the server error message on failure.
 */
export async function fetchGithubProjects(
  sessionToken: string,
  repo: string,
): Promise<GithubProject[]> {
  const params = new URLSearchParams({ repo });
  const res = await fetch(`/api/kanban/github-projects?${params.toString()}`, {
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
  const data = (await res.json()) as { projects: GithubProject[] };
  return data.projects;
}

/**
 * GET /api/kanban/github-project?repo=owner/repo[&project=<id>] → the selected
 * repo's synced GitHub Project v2 board (GraphQL-backed via the employee's
 * token). `projectId` picks a specific linked project; when omitted the server
 * serves the first open one. Throws the server error message on failure (e.g.
 * 404 "no linked GitHub Project").
 */
export async function fetchGithubProjectBoard(
  sessionToken: string,
  repo: string,
  projectId?: string,
): Promise<GithubProjectBoard> {
  const params = new URLSearchParams({ repo });
  if (projectId) {
    params.set("project", projectId);
  }
  const res = await fetch(`/api/kanban/github-project?${params.toString()}`, {
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
  return (await res.json()) as GithubProjectBoard;
}

/**
 * GET /api/kanban/github-issue?repo=...&issueNumber=N → the GitHub issue itself
 * (title, body, state, labels, assignees), for the GitHub-view detail panel
 * (G4.S5.T16). The detail panel renders `body` so it matches the Issues panel.
 * Scoped to the signed-in employee via their session token.
 */
export async function fetchGithubIssueBody(
  sessionToken: string,
  repo: string,
  issueNumber: number,
): Promise<GithubIssue> {
  const params = new URLSearchParams({ repo, issueNumber: String(issueNumber) });
  const res = await fetch(`/api/kanban/github-issue?${params.toString()}`, {
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
  const data = (await res.json()) as { issue: GithubIssue };
  return data.issue;
}

/**
 * GET /api/kanban/github-issue-comments?repo=...&issueNumber=N → the GitHub
 * issue's comment thread, for the GitHub-view local detail panel (G4.S5.T4).
 * Scoped to the signed-in employee via their session token.
 */
export async function fetchGithubIssueComments(
  sessionToken: string,
  repo: string,
  issueNumber: number,
): Promise<GithubIssueComment[]> {
  const params = new URLSearchParams({ repo, issueNumber: String(issueNumber) });
  const res = await fetch(`/api/kanban/github-issue-comments?${params.toString()}`, {
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
  const data = (await res.json()) as { comments: GithubIssueComment[] };
  return data.comments;
}

/**
 * POST /api/kanban/github-issue-comments → create a new comment on a GitHub
 * issue via the employee's token (G4.S5.T8). Returns the created comment so
 * the detail panel can append it to the thread.
 */
export async function postGithubIssueComment(
  sessionToken: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<GithubIssueComment> {
  const res = await fetch("/api/kanban/github-issue-comments", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ repo, issueNumber, body }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    const message =
      detail && typeof (detail as { error?: unknown }).error === "string"
        ? (detail as { error: string }).error
        : `Request failed with status ${res.status}`;
    throw new Error(message);
  }
  const data = (await res.json()) as { comment: GithubIssueComment };
  return data.comment;
}
