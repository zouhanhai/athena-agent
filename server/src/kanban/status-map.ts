import type { SpecStatus, TicketStatus } from "./schema.js";

/**
 * Maps kanban ticket statuses to GitHub Project v2 Status single-select option
 * names (G4.S5). The md kanban is the source of truth; GitHub option names are
 * the team-facing display surface.
 */
export const KANBAN_STATUS_TO_PROJECT_STATUS: Readonly<Record<TicketStatus, string>> = {
  backlog: "Backlog",
  in_progress: "In Progress",
  done: "Done",
  in_review: "In Review",
  approved: "Approved",
  rejected: "Rejected",
  canceled: "Canceled",
};

const PROJECT_STATUS_TO_KANBAN_STATUS = Object.entries(
  KANBAN_STATUS_TO_PROJECT_STATUS,
).reduce<Record<string, TicketStatus>>((acc, [status, option]) => {
  acc[option] = status as TicketStatus;
  return acc;
}, {});

/** Kanban status → Project Status single-select option name. */
export function kanbanStatusToProjectStatus(status: TicketStatus): string {
  return KANBAN_STATUS_TO_PROJECT_STATUS[status];
}

/** Project Status option name → kanban status; null when the option is not a known kanban status. */
export function projectStatusToKanbanStatus(optionName: string): TicketStatus | null {
  return PROJECT_STATUS_TO_KANBAN_STATUS[optionName] ?? null;
}

/**
 * Spec statuses → Project Status single-select option names (G4.S5.T6 + T7).
 * Specs use a coarser lifecycle than tickets (`backlog → decomposed → in_progress
 * → done → in_review → approved/rejected`; canceled), and the Spec card's Status
 * column reflects the md Spec status — not a per-ticket aggregate.
 */
export const KANBAN_SPEC_STATUS_TO_PROJECT_STATUS: Readonly<Record<SpecStatus, string>> = {
  backlog: "Backlog",
  decomposed: "In Progress",
  in_progress: "In Progress",
  done: "Done",
  in_review: "In Review",
  approved: "Approved",
  rejected: "Rejected",
  canceled: "Rejected",
};

/**
 * Legacy Spec status aliases accepted by the status map (G4.S5.T7 backward
 * compat): the historical `active` Spec status ≡ `in_progress`.
 */
const SPEC_STATUS_ALIASES: Readonly<Record<string, SpecStatus>> = {
  active: "in_progress",
};

/** Spec status → Project Status option name; null when the Spec status is unknown. */
export function kanbanSpecStatusToProjectStatus(status: string): string | null {
  const normalized = SPEC_STATUS_ALIASES[status] ?? status;
  return KANBAN_SPEC_STATUS_TO_PROJECT_STATUS[normalized] ?? null;
}
