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
import { kanbanStatusToProjectStatus } from "./status-map.js";

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
 * Build the Ticket sub-issue payload: title `G4.S5.T2`, body = status /
 * assignee / blocked_by + the ticket description (Context/Task/Acceptance)
 * + a link to the md. The Progress Log is deliberately excluded.
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
  return { title: ticketRef, body };
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
  const { goal, tickets } = findSpecInBoard(board, specRef);

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
    const existing = await github.getIssueByTitle(credential, owner, repo, ticketPayload.title);
    let issue: GithubIssue;
    let ticketCreated: boolean;
    if (existing) {
      issue = await github.updateIssue(credential, owner, repo, existing.number, {
        title: ticketPayload.title,
        body: ticketPayload.body,
      });
      ticketCreated = false;
    } else {
      issue = await github.createSubIssue(credential, owner, repo, specIssue.number, ticketPayload);
      ticketCreated = true;
    }
    await github.addIssueToProject(credential, project.id, issue.node_id);
    await applyGoalAttrs(github, credential, owner, repo, issue.number, milestoneNumber, payload.labels);
    issues.set(ticket.ref, issue);
    ticketOutcomes.push({ ref: ticket.ref, number: issue.number, created: ticketCreated });
  }

  // Phase B needs every issue resolved: status columns + blocked_by dependencies.
  await github.ensureStatusFieldOptions(credential, project.id, KANBAN_STATUS_OPTIONS);
  const items = await github.getProjectItems(credential, project.id);
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
 * Move a ticket's card to its Project Status column. `items` can be passed to
 * avoid a redundant getProjectItems round-trip when the caller already fetched
 * the board; the card is added to the Project when missing.
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
