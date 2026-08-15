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
 *
 * This is the SYNC half of the former server/src/kanban/github-sync.ts (G4.S6.T3):
 * the md → GitHub projection used by sync-github CLI + the auto-sync plugin. The
 * READ half (buildGithubProjectBoard + Project-tab helpers) lives in athena's
 * server/src/github/project-board.ts. GDD carries its own GitHub types + client
 * (../github/), so this module never imports athena's employees/github-client.
 */

import type {
  GithubCredential,
  GithubIssue,
  GithubProject,
  GithubProjectItem,
  GitHubApi,
  ProjectV2StatusOptionInput,
} from "../github/types.js";
import type { GoalFrontmatter, SpecFrontmatter, SpecStatus, TicketStatus } from "./schema.js";
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
 * The Project Status single-select options the Spec cards need (G4.S5.T7 +
 * G4.S6.T2). Spec statuses project onto Backlog / In Progress / Done / In
 * Review / Approved / Rejected — the full lifecycle columns.
 */
export const KANBAN_SPEC_STATUS_OPTIONS: ProjectV2StatusOptionInput[] = [
  { name: "Backlog", color: "GRAY", description: "Spec defined, no tickets claimed yet" },
  { name: "In Progress", color: "BLUE", description: "First ticket claimed / executing" },
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
  // Fallback: find the ticket's existing issue by its bare ref PREFIX
  // (e.g. "G4.S6.T1") so a title change updates the existing issue in place
  // instead of creating a duplicate. getIssueByTitle is exact-match, so here we
  // search the ref and match any title starting with "<ref> " or equal to ref.
  return github.getIssueByTitlePrefix(credential, owner, repo, `${ticketRef} `);
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
  // Find the spec's main issue by its stable ref prefix (`G4.S7`) instead of the full
  // title, so a spec title change updates the existing issue in place instead of
  // creating a duplicate. (Bug 2026-08-15: full-title lookup re-created the spec when
  // the title changed, and the spec-status machine pointed at the duplicate.)
  const existingSpec =
    (await github.getIssueByTitlePrefix(credential, owner, repo, `${specRef} `)) ??
    (await github.getIssueByTitlePrefix(credential, owner, repo, specRef)) ??
    (await github.getIssueByTitle(credential, owner, repo, payload.title));
  let specIssue: GithubIssue;
  let created: boolean;
  if (existingSpec) {
    specIssue = await github.updateIssue(credential, owner, repo, existingSpec.number, {
      title: payload.title,
      body: payload.body,
      labels: payload.labels,
      // Sync the spec MAIN ISSUE open/closed to the md spec status (G4.S6.T2):
      // done/approved → closed, else open — so the Project Status column and the
      // issue-list open/closed agree (previously the spec issue stayed open forever).
      state: specIssueState(spec.status),
    });
    created = false;
  } else {
    specIssue = await github.createIssue(credential, owner, repo, payload);
    created = true;
    // A freshly created issue starts open; a done/approved Spec's main issue
    // closes immediately so the issue list matches the Spec status.
    await github.updateIssue(credential, owner, repo, specIssue.number, {
      state: specIssueState(spec.status),
    });
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

/** The GitHub issue open/closed a SPEC's main issue should carry (G4.S6.T2). */
export function specIssueState(status: SpecStatus): "open" | "closed" {
  // done/approved/canceled are terminal → close the spec MAIN issue so the issue
  // list (open view) drops it and the Project Status column (Done) agrees.
  // backlog/in_progress/in_review/rejected stay open (still active / discussable).
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
