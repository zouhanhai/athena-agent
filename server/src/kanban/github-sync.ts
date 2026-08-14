/**
 * md → GitHub Project projection (G4.S5.T2).
 *
 * Turns the local md kanban (the single source of truth) into the GitHub
 * Project v2 board:
 *
 * - **Spec** → a main Issue (title `G4.S5 <spec title>`, body = the spec
 *   description + link to docs/kanban/<ref>.md + a `## Sub-tasks` checklist
 *   mirroring its tickets).
 * - **Ticket** → a sub-issue (title `G4.S5.T2`, body = description/status/
 *   assignee/blocked_by + link to the md). The minute-level **Progress Log is
 *   never pushed** — it stays in md only.
 * - **Goal** → a Milestone + a Label (`G4`) applied to the issues.
 * - **blocked_by** → GitHub "blocked by" issue dependencies.
 * - **status** → the Project Status single-select column (status-map.ts).
 *
 * The sync functions are idempotent: they resolve an issue by title first and
 * update in place instead of creating a duplicate.
 */

import type { GithubCredential } from "../employees/employees.js";
import type {
  GithubIssue,
  GithubProject,
  GithubProjectItem,
  ProjectV2StatusOptionInput,
} from "../github/client.js";
import type { GitHubApi } from "../github/client.js";
import type { GoalFrontmatter, SpecFrontmatter, TicketStatus } from "./schema.js";
import type { BoardTicket, KanbanBoard } from "./scan.js";
import { kanbanSpecStatusToProjectStatus, kanbanStatusToProjectStatus } from "./status-map.js";

/**
 * The Project Status single-select options the kanban board needs. GitHub's
 * default Status field ships only Todo/In Progress/Done, so the sync ensures
 * the full kanban set exists (see createSpecIssue + ensureStatusFieldOptions).
 */
export const KANBAN_STATUS_OPTIONS: ProjectV2StatusOptionInput[] = [
  { name: "Backlog", color: "GRAY", description: "Not started" },
  { name: "In Progress", color: "BLUE", description: "Active work" },
  { name: "Done", color: "GREEN", description: "Implementation complete" },
  { name: "In Review", color: "YELLOW", description: "Reviewer review" },
  { name: "Approved", color: "GREEN", description: "Approved and merged" },
  { name: "Rejected", color: "RED", description: "Rejected by reviewer" },
  { name: "Canceled", color: "GRAY", description: "No longer planned" },
];

/**
 * The Project Status single-select options the Spec cards need (G4.S5.T7).
 * Spec statuses project onto Backlog / In Progress / Done / In Review /
 * Approved / Rejected — the full lifecycle columns.
 */
export const KANBAN_SPEC_STATUS_OPTIONS: ProjectV2StatusOptionInput[] = [
  { name: "Backlog", color: "GRAY", description: "Spec defined, tickets not yet decomposed" },
  { name: "In Progress", color: "BLUE", description: "Tickets decomposed / executing" },
  { name: "Done", color: "GREEN", description: "Tickets complete" },
  { name: "In Review", color: "YELLOW", description: "Acceptance review" },
  { name: "Approved", color: "GREEN", description: "Spec accepted" },
  { name: "Rejected", color: "RED", description: "Spec rejected — re-decompose" },
];

/**
 * Every Status option the board needs (tickets + Specs), deduplicated by name
 * (ticket entries win for shared column names). ensureStatusFieldOptions adds
 * exactly these to the Project board's Status field.
 */
export function statusFieldOptions(): ProjectV2StatusOptionInput[] {
  const byName = new Map<string, ProjectV2StatusOptionInput>();
  for (const option of [...KANBAN_STATUS_OPTIONS, ...KANBAN_SPEC_STATUS_OPTIONS]) {
    byName.set(option.name, option);
  }
  return [...byName.values()];
}

/** Strip a `Gx.Sy.Tz:` (or `Gx.Sy:`) ref prefix from an md title, if present. */
export function stripRefPrefix(title: string, ref: string): string {
  const prefix = `${ref}:`;
  return title.startsWith(prefix) ? title.slice(prefix.length).trim() : title;
}

/** The GitHub main Issue title for a Spec: `G4.S5 <spec title>` (ref prefix stripped). */
export function specIssueTitle(specRef: string, spec: SpecFrontmatter): string {
  return `${specRef} ${stripRefPrefix(spec.title, specRef)}`;
}

/** The projection payload for the Spec main Issue. */
export interface IssuePayload {
  title: string;
  body: string;
  labels: string[];
}

/** A spec located in the scanned board, with its goal + tickets. */
export interface SpecProjection {
  goal: GoalFrontmatter;
  spec: SpecFrontmatter;
  /** The spec markdown body (after frontmatter), when the scan carried it. */
  specBody?: string;
  tickets: BoardTicket[];
}

/** Locate a Spec (`Gx.Sy`) in a scanned board; throws when it is absent. */
export function findSpecInBoard(board: KanbanBoard, specRef: string): SpecProjection {
  const parts = specRef.split(".");
  if (parts.length !== 2 || !/^G\d+$/.test(parts[0]) || !/^S\d+$/.test(parts[1])) {
    throw new Error(`invalid spec ref "${specRef}": expected Gx.Sy`);
  }
  const goal = board.goals.find((g) => g.ref === parts[0]);
  if (!goal) {
    throw new Error(`goal "${parts[0]}" not found in the board`);
  }
  const spec = goal.specs.find((s) => s.ref === specRef);
  if (!spec) {
    throw new Error(`spec "${specRef}" not found in the board`);
  }
  return { goal: goal.goal, spec: spec.spec, specBody: spec.body, tickets: spec.tickets };
}

/**
 * Build the Spec main Issue payload: title `G4.S5 <title>`, body = the spec
 * description + link to docs/kanban/<ref>.md + a `## Sub-tasks` checklist of
 * its tickets (checked when done/approved), labels = the Goal label.
 */
export function buildIssueForSpec(board: KanbanBoard, specRef: string): IssuePayload {
  const { goal, spec, specBody, tickets } = findSpecInBoard(board, specRef);
  const { label } = goalToMilestoneAndLabel(goal);
  const body =
    `${specBody?.trim() ?? ""}\n\n` +
    `**Board file:** \`docs/kanban/${specRef.replace(/\./g, "/")}/Spec.md\`\n\n` +
    `## Sub-tasks\n` +
    tickets
      .map((ticket) => {
        const checked = ticket.ticket.status === "done" || ticket.ticket.status === "approved";
        return `- [${checked ? "x" : " "}] ${ticket.ref} ${stripRefPrefix(ticket.ticket.title, ticket.ref)}`;
      })
      .join("\n");
  return { title: specIssueTitle(specRef, spec), body, labels: label ? [label] : [] };
}

/**
 * Drop the `## Progress Log` (and trailing `## Log`) section from a ticket
 * body — the Progress Log stays in md only and is never pushed to GitHub.
 */
export function stripProgressLog(body: string): string {
  const lines = body.split("\n");
  const kept: string[] = [];
  let drop = false;
  for (const raw of lines) {
    const heading = raw.match(/^##\s+([^\n]*)$/);
    if (heading) {
      const name = (heading[1] ?? "").trim();
      drop = /progress\s*log/i.test(name) || /^log$/i.test(name);
    }
    if (!drop) {
      kept.push(raw);
    }
  }
  return kept.join("\n").trim();
}

/**
 * Build the Ticket sub-issue payload: title `G4.S5.T2 <ticket title>` (ref +
 * stripped title, matching how Spec main-issue titles are built — G4.S5.T10),
 * body = status / assignee / blocked_by + the ticket description
 * (Context/Task/Acceptance) + a link to the md. The Progress Log is
 * deliberately excluded.
 */
export function buildIssueForTicket(
  board: KanbanBoard,
  specRef: string,
  ticketRef: string,
): { title: string; body: string } {
  const { tickets } = findSpecInBoard(board, specRef);
  const ticket = tickets.find((t) => t.ref === ticketRef);
  if (!ticket) {
    throw new Error(`ticket "${ticketRef}" not found under spec "${specRef}"`);
  }
  const fm = ticket.ticket;
  const blocked = fm.blocked_by.length > 0 ? `\n**Blocked by:** ${fm.blocked_by.join(", ")}` : "";
  const body =
    `**Status:** ${fm.status}\n` +
    `**Assignee:** ${fm.assignee}${blocked}\n\n` +
    `${stripProgressLog(ticket.body ?? "")}\n\n` +
    `**Board file:** \`docs/kanban/${ticketRef.replace(/\./g, "/")}.md\``;
  return { title: `${ticketRef} ${stripRefPrefix(fm.title, ticketRef)}`, body };
}

/**
 * Resolve an existing ticket sub-issue for an idempotent update. Pre-T10 syncs
 * created sub-issues whose title was the bare ref (`G4.S5.T1`); since T10 the
 * title is `G4.S5.T1 <title>`. Try the new title first, then fall back to the
 * bare ref so a re-sync updates those legacy sub-issues in place instead of
 * creating a duplicate (G4.S5.T10).
 */
export async function findExistingTicketIssue(
  github: GitHubApi,
  credential: GithubCredential,
  owner: string,
  repo: string,
  ticketRef: string,
  title: string,
): Promise<GithubIssue | null> {
  const byTitle = await github.getIssueByTitle(credential, owner, repo, title);
  if (byTitle) {
    return byTitle;
  }
  if (title === ticketRef) {
    return null;
  }
  return github.getIssueByTitle(credential, owner, repo, ticketRef);
}

/** Kanban status → the Project Status single-select option name (status-map.ts). */
export function statusToColumn(status: TicketStatus): string {
  return kanbanStatusToProjectStatus(status);
}

/**
 * Resolve a ticket's blocked_by refs to GitHub issue ids (the ids the issue
 * dependencies API expects). Refs that resolve to null are skipped.
 */
export function blockedByToDeps(
  blockedBy: string[],
  resolveIssueId: (ticketRef: string) => number | null,
): number[] {
  return blockedBy
    .map((ref) => resolveIssueId(ref))
    .filter((id): id is number => id !== null && id > 0);
}

/** Goal → `{ milestone, label }`: the md milestone + the goal ref (`G4`) as the label. */
export function goalToMilestoneAndLabel(goal: GoalFrontmatter): {
  milestone: string | null;
  label: string;
} {
  return { milestone: goal.milestone ?? null, label: goal.id.toUpperCase() };
}

/** One ticket's sync outcome. */
export interface SyncTicketOutcome {
  ref: string;
  number: number;
  created: boolean;
}

/** The result of createSpecIssue. */
export interface SyncResult {
  specRef: string;
  specIssue: { number: number; title: string };
  created: boolean;
  tickets: SyncTicketOutcome[];
}

/**
 * Create (or update in place, idempotent) the Spec main Issue + its Ticket
 * sub-issues on the Project board, applying the Goal milestone/label and each
 * ticket's status column + blocked_by dependencies.
 */
export async function createSpecIssue(
  github: GitHubApi,
  credential: GithubCredential,
  owner: string,
  repo: string,
  board: KanbanBoard,
  specRef: string,
  project: GithubProject,
): Promise<SyncResult> {
  const { goal, spec, tickets } = findSpecInBoard(board, specRef);

  let milestoneNumber: number | null = null;
  const { milestone, label } = goalToMilestoneAndLabel(goal);
  if (milestone) {
    milestoneNumber = await github.getMilestoneByTitle(credential, owner, repo, milestone);
    if (milestoneNumber === null) {
      milestoneNumber = await github.createMilestone(credential, owner, repo, milestone);
    }
  }

  const payload = buildIssueForSpec(board, specRef);
  const existingSpec = await github.getIssueByTitle(credential, owner, repo, payload.title);
  let specIssue: GithubIssue;
  let created: boolean;
  if (existingSpec) {
    specIssue = await github.updateIssue(credential, owner, repo, existingSpec.number, {
      title: payload.title,
      body: payload.body,
      labels: payload.labels,
    });
    created = false;
  } else {
    specIssue = await github.createIssue(credential, owner, repo, payload);
    created = true;
  }

  await github.addIssueToProject(credential, project.id, specIssue.node_id);
  await applyGoalAttrs(github, credential, owner, repo, specIssue.number, milestoneNumber, payload.labels);

  const issues = new Map<string, GithubIssue>();
  issues.set(specRef, specIssue);

  const ticketOutcomes: SyncTicketOutcome[] = [];
  for (const ticket of tickets) {
    const ticketPayload = buildIssueForTicket(board, specRef, ticket.ref);
    const existing = await findExistingTicketIssue(
      github,
      credential,
      owner,
      repo,
      ticket.ref,
      ticketPayload.title,
    );
    let issue: GithubIssue;
    let ticketCreated: boolean;
    if (existing) {
      issue = await github.updateIssue(credential, owner, repo, existing.number, {
        title: ticketPayload.title,
        body: ticketPayload.body,
        state: ticketState(ticket.ticket.status),
      });
      ticketCreated = false;
    } else {
      issue = await github.createSubIssue(credential, owner, repo, specIssue.number, ticketPayload);
      ticketCreated = true;
      // Newly created sub-issues are open; a done ticket's sub-issue closes so
      // GitHub's native sub-task progress and the board's segmented bar reflect it.
      await syncTicketIssueState(github, credential, owner, repo, issue.number, ticket.ticket.status);
    }
    // T9 (revert T6): every ticket sub-issue is ALSO a Project card — added to
    // the board so the ticket cards spread across their Status columns
    // (GitHub-native behavior) alongside the Spec card's aggregated progress.
    await github.addIssueToProject(credential, project.id, issue.node_id);
    await applyGoalAttrs(github, credential, owner, repo, issue.number, milestoneNumber, payload.labels);
    issues.set(ticket.ref, issue);
    ticketOutcomes.push({ ref: ticket.ref, number: issue.number, created: ticketCreated });
  }

  // Phase B: the Spec card's Status column = the md Spec status; each ticket
  // sub-issue card syncs to its own Status column (syncTicketStatus).
  await github.ensureStatusFieldOptions(credential, project.id, statusFieldOptions());
  const items = await github.getProjectItems(credential, project.id);
  await syncSpecStatus(github, credential, owner, repo, project, specIssue.number, spec.status, items);
  for (const ticket of tickets) {
    const issue = issues.get(ticket.ref)!;
    await syncTicketStatus(github, credential, owner, repo, project, issue.number, ticket.ticket.status, items);
    await syncBlockedBy(
      github,
      credential,
      owner,
      repo,
      issue.number,
      ticket.ticket.blocked_by,
      (ref) => issues.get(ref)?.id ?? null,
    );
  }

  return {
    specRef,
    specIssue: { number: specIssue.number, title: payload.title },
    created,
    tickets: ticketOutcomes,
  };
}

/** Apply the Goal milestone + label to an issue. */
async function applyGoalAttrs(
  github: GitHubApi,
  credential: GithubCredential,
  owner: string,
  repo: string,
  issueNumber: number,
  milestoneNumber: number | null,
  labels: string[],
): Promise<void> {
  if (milestoneNumber !== null) {
    await github.setMilestone(credential, owner, repo, issueNumber, milestoneNumber);
  }
  for (const label of labels) {
    await github.addLabel(credential, owner, repo, issueNumber, label);
  }
}

/**
 * The GitHub issue state a ticket's sub-issue should carry: done/approved →
 * "closed" (GitHub-native + board segmented progress), everything else "open".
 */
export function ticketState(status: TicketStatus): "open" | "closed" {
  // done/approved/canceled are terminal — close the sub-issue so it drops out of
  // GitHub's native sub-task progress (X/N) and our segmented bar. canceled
  // tickets must NOT keep counting toward the progress (was: open → showed 8/9).
  return status === "done" || status === "approved" || status === "canceled"
    ? "closed"
    : "open";
}

/**
 * Sync a ticket sub-issue's open/closed state. Done/approved tickets close
 * (feeding GitHub's native sub-task progress X/N and our segmented bar); any
 * other status reopens the sub-issue.
 */
async function syncTicketIssueState(
  github: GitHubApi,
  credential: GithubCredential,
  owner: string,
  repo: string,
  issueNumber: number,
  status: TicketStatus,
): Promise<void> {
  await github.updateIssue(credential, owner, repo, issueNumber, { state: ticketState(status) });
}

/**
 * Move a Spec card to its Project Status column matching the md Spec status
 * (backlog/active/done → Backlog/In Progress/Done). `items` can be passed to
 * avoid a redundant getProjectItems round-trip; the card is added to the
 * Project when missing. Unknown Spec statuses leave the card untouched.
 */
export async function syncSpecStatus(
  github: GitHubApi,
  credential: GithubCredential,
  owner: string,
  repo: string,
  project: GithubProject,
  specIssueNumber: number,
  status: string,
  items?: GithubProjectItem[],
): Promise<void> {
  const column = kanbanSpecStatusToProjectStatus(status);
  if (!column) {
    return;
  }
  const projectItems = items ?? (await github.getProjectItems(credential, project.id));
  let item: GithubProjectItem | undefined = projectItems.find((it) => it.issueNumber === specIssueNumber);
  if (!item) {
    const issue = await github.getIssue(credential, owner, repo, specIssueNumber);
    await github.addIssueToProject(credential, project.id, issue.node_id);
    const refreshed = await github.getProjectItems(credential, project.id);
    item = refreshed.find((it) => it.issueNumber === specIssueNumber);
    if (!item) {
      throw new Error(`issue #${specIssueNumber} is not on Project "${project.title}"`);
    }
  }
  await github.setItemStatusField(credential, project.id, item.id, column);
}

/**
 * Move a ticket's card to its Project Status column. `items` can be passed to
 * avoid a redundant getProjectItems round-trip when the caller already fetched
 * the board; the card is added to the Project when missing.
 *
 * createSpecIssue calls this for each ticket sub-issue (G4.S5.T9) so ticket
 * cards spread across their Status columns — GitHub-native board behavior.
 */
export async function syncTicketStatus(
  github: GitHubApi,
  credential: GithubCredential,
  owner: string,
  repo: string,
  project: GithubProject,
  ticketIssueNumber: number,
  status: TicketStatus,
  items?: GithubProjectItem[],
): Promise<void> {
  const projectItems = items ?? (await github.getProjectItems(credential, project.id));
  let item: GithubProjectItem | undefined = projectItems.find((it) => it.issueNumber === ticketIssueNumber);
  if (!item) {
    const issue = await github.getIssue(credential, owner, repo, ticketIssueNumber);
    await github.addIssueToProject(credential, project.id, issue.node_id);
    const refreshed = await github.getProjectItems(credential, project.id);
    item = refreshed.find((it) => it.issueNumber === ticketIssueNumber);
    if (!item) {
      throw new Error(`issue #${ticketIssueNumber} is not on Project "${project.title}"`);
    }
  }
  await github.setItemStatusField(credential, project.id, item.id, statusToColumn(status));
}

/**
 * Set an issue's "blocked by" dependencies from the ticket's blocked_by refs.
 * Refs that do not resolve to a created issue are skipped.
 */
export async function syncBlockedBy(
  github: GitHubApi,
  credential: GithubCredential,
  owner: string,
  repo: string,
  issueNumber: number,
  blockedBy: string[],
  resolveIssueId: (ticketRef: string) => number | null,
): Promise<void> {
  const deps = blockedByToDeps(blockedBy, resolveIssueId);
  if (deps.length === 0) {
    return;
  }
  await github.setIssueDependencies(credential, owner, repo, issueNumber, deps);
}

// ---------------------------------------------------------------------------
// G4.S5.T4 — GitHub Project board (read view)
// ---------------------------------------------------------------------------

/**
 * Parse a leading `Gx.Sy` / `Gx.Sy.Tz` ref off a GitHub issue title, or null
 * when the title does not start with one (e.g. a free-form discussion issue).
 */
export function parseIssueRef(title: string): string | null {
  const match = /^(G\d+\.S\d+(?:\.T\d+)?)(?=\s|$)/.exec(title.trim());
  return match ? match[1] : null;
}

/** A card on the GitHub Project board as shown in the Workbench GitHub view. */
export interface GithubProjectCard {
  /** The linked issue number (draft cards carry none and are skipped). */
  issueNumber: number;
  /** The spec ref parsed from the issue title (e.g. "G4.S5"), or null. */
  ref: string | null;
  /** The issue title with any ref prefix stripped (e.g. "Workbench" for "G4.S5 Workbench"). */
  title: string;
  /** The Project Status option name, or null when the card has no status. */
  status: string | null;
  /** Link to the GitHub issue for discussion. */
  url: string;
  /**
   * Sub-task progress of the card's sub-issues (G4.S5.T6): total = the card's
   * sub-issues, done = closed sub-issues (GitHub-native X/N), percent rounded
   * to a whole number. Since G4.S5.T18 the source is the issue's ACTUAL
   * sub-issues (GitHub `sub_issues` relationship) for ANY parent card, not just
   * Gx.Sy-named Specs; the Gx.Sy title-matching path remains as a fallback.
   * `{ done: 0, total: 0, percent: 0 }` for cards with no sub-issues.
   */
  progress: { done: number; total: number; percent: number };
  /**
   * The card's sub-issues (G4.S5.T8): ref + title + status + issue number for
   * the detail panel's clickable Sub-issues list. Populated for ANY card whose
   * issue is a parent of sub-issues (G4.S5.T18). Empty for cards with none.
   */
  subIssues: GithubProjectSubIssue[];
}

/** A sub-issue of a board card, for the detail panel's Sub-issues list (G4.S5.T8). */
export interface GithubProjectSubIssue {
  /**
   * The `Gx.Sy` / `Gx.Sy.Tz` ref parsed from the sub-issue's title, or null for
   * a plain-titled sub-issue (G4.S5.T18, e.g. abaplorer #202 "Import tables").
   */
  ref: string | null;
  title: string;
  /** Closed sub-issues read as "done"; everything else is "open". */
  status: string;
  number: number;
}

/** A Status column on the GitHub Project board. */
export interface GithubProjectColumn {
  /** Column title: the Status option name, or "No status" for unset cards. */
  status: string;
  cards: GithubProjectCard[];
}

/** The GitHub Project board served by GET /api/kanban/github-project. */
export interface GithubProjectBoard {
  project: GithubProject;
  columns: GithubProjectColumn[];
  generated_at: string;
}

/** Column label for a card's Status value; null → "No status" (GitHub's native board column). */
export function statusColumnName(status: string | null): string {
  return status ?? "No status";
}

/** True for a ticket ref like `G4.S5.T1` (a sub-issue card on the board). */
function isTicketRef(ref: string): boolean {
  return /^G\d+\.S\d+\.T\d+$/.test(ref);
}

/**
 * Sub-task progress for a Spec card from the repo's issues: total = the Spec's
 * ticket sub-issues (title ref `Gx.Sy.Tz`), done = the closed ones. Mirrors
 * GitHub's native sub-task progress X/N and ABAPlorer's `4 / 5 · 80%`.
 */
export function subTaskProgress(
  specRef: string | null,
  issues: GithubIssue[],
): { done: number; total: number; percent: number } {
  if (!specRef) {
    return { done: 0, total: 0, percent: 0 };
  }
  const prefix = `${specRef}.`;
  const subs = issues.filter((issue) => {
    const ref = parseIssueRef(issue.title ?? "");
    return ref !== null && ref.startsWith(prefix) && isTicketRef(ref);
  });
  const done = subs.filter((issue) => issue.state === "closed").length;
  const total = subs.length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return { done, total, percent };
}

/**
 * The Spec's ticket sub-issues (title ref `Gx.Sy.Tz`) as card detail entries
 * (G4.S5.T8): ref, title, status (closed → "done", else "open") and the issue
 * number. Sorted by ticket number (T1, T2, … T10) so the panel lists tickets
 * in kanban order. A Spec with no sub-issues — or a non-Spec card (ref null) —
 * yields `[]`.
 */
export function subIssuesForSpec(
  specRef: string | null,
  issues: GithubIssue[],
): GithubProjectSubIssue[] {
  if (!specRef) {
    return [];
  }
  const ticketIndex = (ref: string): number => {
    const match = /^G\d+\.S\d+\.T(\d+)$/.exec(ref);
    return match ? Number(match[1]) : 0;
  };
  const prefix = `${specRef}.`;
  return issues
    .filter((issue) => {
      const ref = parseIssueRef(issue.title ?? "");
      return ref !== null && ref.startsWith(prefix) && isTicketRef(ref);
    })
    .map((issue) => ({
      ref: parseIssueRef(issue.title ?? "")!,
      title: issue.title ?? "",
      status: issue.state === "closed" ? "done" : "open",
      number: issue.number,
    }))
    .sort((a, b) => ticketIndex(a.ref) - ticketIndex(b.ref));
}

/**
 * The raw issues a Gx.Sy Spec card counts as its sub-issues by title-matching
 * (`Gx.Sy.Tz` ref prefix). This is the athena-specific fallback used when the
 * issue has no real GitHub sub-issues relationship (G4.S5.T18).
 */
function issuesForRef(ref: string | null, issues: GithubIssue[]): GithubIssue[] {
  if (!ref) {
    return [];
  }
  const prefix = `${ref}.`;
  return issues.filter((issue) => {
    const parsed = parseIssueRef(issue.title ?? "");
    return parsed !== null && parsed.startsWith(prefix) && isTicketRef(parsed);
  });
}

/** Sub-task progress from an issue's actual sub-issues: done = closed, total = count. */
function progressFromSubIssues(subs: GithubIssue[]): { done: number; total: number; percent: number } {
  const done = subs.filter((issue) => issue.state === "closed").length;
  const total = subs.length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return { done, total, percent };
}

/** A detail entry for one of an issue's actual sub-issues (G4.S5.T18). */
function subIssueFromIssue(issue: GithubIssue): GithubProjectSubIssue {
  return {
    ref: parseIssueRef(issue.title ?? ""),
    title: issue.title ?? "",
    status: issue.state === "closed" ? "done" : "open",
    number: issue.number,
  };
}

/**
 * Resolve a card's sub-issues (G4.S5.T18): first the issue's ACTUAL sub-issues
 * (GitHub `sub_issues` relationship, via `parent_issue_url`), then the Gx.Sy
 * title-matching fallback for athena Specs. Returns `{ subs, viaRelationship }`
 * so the caller can decide the progress source too.
 */
function resolveSubIssues(
  issueNumber: number,
  ref: string | null,
  issues: GithubIssue[],
): { subs: GithubIssue[]; viaRelationship: boolean } {
  const byParent = new Map<number, GithubIssue[]>();
  for (const issue of issues) {
    const parent = parentIssueNumber(issue);
    if (parent !== null) {
      const list = byParent.get(parent) ?? [];
      list.push(issue);
      byParent.set(parent, list);
    }
  }
  const actual = byParent.get(issueNumber) ?? [];
  if (actual.length > 0) {
    return { subs: actual, viaRelationship: true };
  }
  return { subs: issuesForRef(ref, issues), viaRelationship: false };
}

/** The parent issue number an issue belongs to as a sub-issue, or null. */
function parentIssueNumber(issue: GithubIssue): number | null {
  const url = issue.parent_issue_url;
  if (!url) {
    return null;
  }
  const match = /\/issues\/(\d+)\/?$/.exec(url);
  return match ? Number(match[1]) : null;
}

/**
 * Build the GitHub Project board from the Project cards, grouped into Status
 * columns. Spec issues and ticket sub-issues are ALL cards (G4.S5.T9 revert of
 * T6) — each sits in its own Status column, GitHub-native. Since G4.S5.T18 ANY
 * card whose issue is a parent of sub-issues carries its sub-task progress
 * (from the issue's actual GitHub sub-issues relationship, not just Gx.Sy
 * title-matching); ticket cards are plain. Known kanban statuses lead in kanban
 * order; unknown/unset statuses ("No status") trail, mirroring GitHub's native
 * board layout.
 */
export function buildGithubProjectBoard(
  project: GithubProject,
  items: GithubProjectItem[],
  issues: GithubIssue[],
  issueUrl: (issueNumber: number) => string,
  generatedAt = new Date().toISOString(),
): GithubProjectBoard {
  const columns = new Map<string, GithubProjectColumn>();
  for (const item of items) {
    if (item.issueNumber === null) {
      continue; // draft cards have no linked issue to discuss
    }
    const rawTitle = item.title ?? "";
    const ref = parseIssueRef(rawTitle);
    const displayTitle = ref ? rawTitle.slice(ref.length).trim() : rawTitle;
    const columnName = statusColumnName(item.status);
    let column = columns.get(columnName);
    if (!column) {
      column = { status: columnName, cards: [] };
      columns.set(columnName, column);
    }
    const { subs, viaRelationship } = resolveSubIssues(item.issueNumber, ref, issues);
    column.cards.push({
      issueNumber: item.issueNumber,
      ref,
      title: displayTitle,
      status: item.status,
      url: issueUrl(item.issueNumber),
      progress: viaRelationship ? progressFromSubIssues(subs) : subTaskProgress(ref, issues),
      subIssues: viaRelationship ? subs.map(subIssueFromIssue) : subIssuesForSpec(ref, issues),
    });
  }
  const ordered: GithubProjectColumn[] = [];
  const knownFirst = [...KANBAN_STATUS_OPTIONS.map((o) => o.name), statusColumnName(null)];
  for (const name of knownFirst) {
    const column = columns.get(name);
    if (column) {
      ordered.push(column);
      columns.delete(name);
    }
  }
  for (const column of columns.values()) {
    ordered.push(column);
  }
  return { project, columns: ordered, generated_at: generatedAt };
}
