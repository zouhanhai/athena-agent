/**
 * The ticket state machine (G3.S6.T4) — backlog → in_progress → done →
 * in_review → approved, or ↘ rejected → Eng Director re-decomposes into a new
 * backlog ticket. Rejected tickets have no outgoing transition on the same
 * ticket: the fix enters the board as a new ticket via reDecompose (./lifecycle.ts).
 *
 * Matches docs/gdd/design.md §6 + §11.
 */

import type { SpecStatus, TicketStatus } from "./schema.js";
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

/**
 * Edges of the Spec state machine (G4.S5.T7, simplified G4.S6.T2) — `decomposed`
 * removed. backlog → in_progress (auto, ticket-driven: first ticket claim) →
 * done → in_review → approved/rejected. Rejection re-decomposes into new
 * tickets / a new backlog; canceled is terminal. done is NOT auto (waits for
 * review, may add tickets). Transitions are triggered by a plan agent / human
 * reviewer.
 */
export const SPEC_STATE_MACHINE: Record<SpecStatus, readonly SpecStatus[]> = {
  backlog: ["in_progress"],
  in_progress: ["done"],
  done: ["in_review"],
  in_review: ["approved", "rejected"],
  approved: [],
  rejected: ["backlog", "in_progress"],
  canceled: [],
};

/** Which state machine a transition belongs to. */
export type StateMachineKind = "ticket" | "spec";

/** Any status the state machine layer can reason about. */
export type KanbanStatus = TicketStatus | SpecStatus;

/** The named transitions of the ticket state machine. */
export type TransitionId =
  | "claim"
  | "report-done"
  | "report-in_review"
  | "approve"
  | "reject";

/** The named transitions of the Spec state machine. */
export type SpecTransitionId =
  | "start"
  | "report-done"
  | "report-in_review"
  | "approve"
  | "reject"
  | "re-decompose";

/** The soul role that performs each ticket transition. */
export const TRANSITION_ACTOR: Record<TransitionId, RoleId> = {
  claim: "worker",
  "report-done": "worker",
  "report-in_review": "worker",
  approve: "reviewer",
  reject: "reviewer",
};

/**
 * The soul role that performs each Spec transition (G4.S5.T7): the Eng
 * Director (plan agent) decomposes/re-decomposes/advances the spec, the
 * Reviewer gives the acceptance verdict.
 */
export const SPEC_TRANSITION_ACTOR: Record<SpecTransitionId, RoleId> = {
  start: "eng-director",
  "report-done": "eng-director",
  "report-in_review": "eng-director",
  approve: "reviewer",
  reject: "reviewer",
  "re-decompose": "eng-director",
};

function machineFor(kind: StateMachineKind): Readonly<Record<string, readonly string[]>> {
  return kind === "spec" ? SPEC_STATE_MACHINE : STATE_MACHINE;
}

/** True when the ticket state machine allows from → to. */
export function canTransition(from: TicketStatus, to: TicketStatus): boolean;
/** True when the Spec state machine allows from → to. */
export function canTransition(from: SpecStatus, to: SpecStatus, kind: "spec"): boolean;
export function canTransition(
  from: KanbanStatus,
  to: KanbanStatus,
  kind: StateMachineKind = "ticket",
): boolean {
  return machineFor(kind)[from]?.includes(to) ?? false;
}

/** The ticket states reachable directly from a state ([] for terminal states). */
export function transitionsFrom(from: TicketStatus): readonly TicketStatus[];
/** The Spec states reachable directly from a state ([] for terminal states). */
export function transitionsFrom(from: SpecStatus, kind: "spec"): readonly SpecStatus[];
export function transitionsFrom(
  from: KanbanStatus,
  kind: StateMachineKind = "ticket",
): readonly KanbanStatus[] {
  return (machineFor(kind)[from] ?? []) as readonly KanbanStatus[];
}

/** The ticket from-states that can reach `to` (the inverse of transitionsFrom). */
export function transitionsTo(to: TicketStatus): TicketStatus[];
/** The Spec from-states that can reach `to` (the inverse of transitionsFrom). */
export function transitionsTo(to: SpecStatus, kind: "spec"): SpecStatus[];
export function transitionsTo(
  to: KanbanStatus,
  kind: StateMachineKind = "ticket",
): KanbanStatus[] {
  const machine = machineFor(kind);
  return (Object.entries(machine) as [KanbanStatus, readonly KanbanStatus[]][])
    .filter(([, tos]) => (tos as readonly string[]).includes(to))
    .map(([from]) => from);
}

/** Name a ticket transition edge, or null when it is not a valid edge. */
function ticketTransitionId(from: TicketStatus, to: TicketStatus): TransitionId | null {
  if (!canTransition(from, to)) return null;
  if (to === "in_review") return "report-in_review";
  if (to === "done") return "report-done";
  if (to === "approved") return "approve";
  if (to === "rejected") return "reject";
  if (to === "in_progress") return "claim";
  return null;
}

/** Name a Spec transition edge, or null when it is not a valid edge. */
export function specTransitionId(from: SpecStatus, to: SpecStatus): SpecTransitionId | null {
  if (!canTransition(from, to, "spec")) return null;
  if (from === "rejected") return "re-decompose";
  if (to === "in_progress") return "start";
  if (to === "done") return "report-done";
  if (to === "in_review") return "report-in_review";
  if (to === "approved") return "approve";
  if (to === "rejected") return "reject";
  return null;
}

/** Name a ticket transition edge, or null when it is not a valid edge. */
export function transitionId(from: TicketStatus, to: TicketStatus): TransitionId | null;
/** Name a Spec transition edge, or null when it is not a valid edge. */
export function transitionId(
  from: SpecStatus,
  to: SpecStatus,
  kind: "spec",
): SpecTransitionId | null;
export function transitionId(
  from: KanbanStatus,
  to: KanbanStatus,
  kind: StateMachineKind = "ticket",
): TransitionId | SpecTransitionId | null {
  return kind === "spec"
    ? specTransitionId(from as SpecStatus, to as SpecStatus)
    : ticketTransitionId(from as TicketStatus, to as TicketStatus);
}

/** The soul role that performs a ticket transition, or null for an invalid edge. */
export function actorFor(from: TicketStatus, to: TicketStatus): RoleId | null;
/** The soul role that performs a Spec transition, or null for an invalid edge. */
export function actorFor(from: SpecStatus, to: SpecStatus, kind: "spec"): RoleId | null;
export function actorFor(
  from: KanbanStatus,
  to: KanbanStatus,
  kind: StateMachineKind = "ticket",
): RoleId | null {
  if (kind === "spec") {
    const id = specTransitionId(from as SpecStatus, to as SpecStatus);
    return id === null ? null : SPEC_TRANSITION_ACTOR[id];
  }
  const id = ticketTransitionId(from as TicketStatus, to as TicketStatus);
  return id === null ? null : TRANSITION_ACTOR[id];
}
