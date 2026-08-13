import type { TicketStatus } from "./schema.js";

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
