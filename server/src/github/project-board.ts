/**
 * GitHub Project v2 board — READ half of the former server/src/kanban/
 * github-sync.ts (G4.S6.T3 split). Builds the board the Workbench Project tab
 * shows from the Project's cards + repo issues, directly off athena's own
 * github client. The md → GitHub SYNC half (createSpecIssue & co) lives in the
 * GDD package (gdd/src/kanban/github-sync.ts); athena's read routes call THIS
 * builder, GDD's sync-github calls the GDD-side sync.
 */

import type {
  GithubIssue,
  GithubProject,
  GithubProjectItem,
} from "./client.js";

/** The known kanban Status columns, leading the board in kanban order (ticket + spec options). */
const KANBAN_COLUMN_ORDER = [
  "Backlog",
  "In Progress",
  "Done",
  "In Review",
  "Approved",
  "Rejected",
  "Canceled",
];

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
  const knownFirst = [...KANBAN_COLUMN_ORDER, statusColumnName(null)];
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
