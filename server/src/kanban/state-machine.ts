/**
 * The ticket state machine (G3.S6.T4) — backlog → in_progress → done →
 * in_review → approved, or ↘ rejected → Eng Director re-decomposes into a new
 * backlog ticket. Rejected tickets have no outgoing transition on the same
 * ticket: the fix enters the board as a new ticket via reDecompose (./lifecycle.ts).
 *
 * Matches docs/git-kanban-design.md §6 + §11.
 */

import type { TicketStatus } from "./schema.js";
import type { RoleId } from "./roles.js";

/** Edges of the ticket state machine: from-state → reachable to-states. */
export const STATE_MACHINE: Record<TicketStatus, readonly TicketStatus[]> = {
  backlog: ["in_progress"],
  in_progress: ["done", "in_review"],
  done: ["in_review"],
  in_review: ["approved", "rejected"],
  approved: [],
  rejected: [],
  canceled: [],
};

/** Named transitions of the state machine. */
export type TransitionId =
  | "claim"
  | "report-done"
  | "report-in_review"
  | "approve"
  | "reject";

/** The soul role that performs each transition. */
export const TRANSITION_ACTOR: Record<TransitionId, RoleId> = {
  claim: "worker",
  "report-done": "worker",
  "report-in_review": "worker",
  approve: "reviewer",
  reject: "reviewer",
};

/** True when the state machine allows from → to. */
export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return STATE_MACHINE[from].includes(to);
}

/** The states reachable directly from a state ([] for terminal states). */
export function transitionsFrom(from: TicketStatus): readonly TicketStatus[] {
  return STATE_MACHINE[from];
}

/** The from-states that can reach `to` (the inverse of transitionsFrom). */
export function transitionsTo(to: TicketStatus): TicketStatus[] {
  return (Object.entries(STATE_MACHINE) as [TicketStatus, readonly TicketStatus[]][])
    .filter(([, tos]) => tos.includes(to))
    .map(([from]) => from);
}

/** Name a transition edge, or null when it is not a valid edge. */
export function transitionId(from: TicketStatus, to: TicketStatus): TransitionId | null {
  if (!canTransition(from, to)) return null;
  if (to === "in_review") return "report-in_review";
  if (to === "done") return "report-done";
  if (to === "approved") return "approve";
  if (to === "rejected") return "reject";
  if (to === "in_progress") return "claim";
  return null;
}

/** The soul role that performs from → to, or null for an invalid edge. */
export function actorFor(from: TicketStatus, to: TicketStatus): RoleId | null {
  const id = transitionId(from, to);
  return id === null ? null : TRANSITION_ACTOR[id];
}
