/**
 * G.S.T board schema — the three-layer markdown protocol.
 *
 * Types + validation for Goal (`G{N}/Goal.md`), Spec (`G{N}/S{N}/Spec.md`)
 * and Ticket (`G{N}/S{N}/T{N}.md`) frontmatter, standardizing the structure
 * defined in docs/git-kanban-design.md.
 */

import type { FrontmatterMap } from "./frontmatter.js";

/** The three board layers. */
export const LAYERS = ["G", "S", "T"] as const;
export type BoardLayer = (typeof LAYERS)[number];

/** Ticket statuses follow the state machine: backlog→in_progress→done→in_review→approved, or →rejected/canceled. */
export const TICKET_STATUSES = ["backlog", "in_progress", "done", "in_review", "approved", "rejected", "canceled"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/**
 * Spec statuses follow the Spec state machine (G4.S5.T7): the planning phase
 * (`backlog → decomposed`), execution (`in_progress → done`), review
 * (`done → in_review → approved/rejected`, rejected re-decomposes) and
 * `canceled` terminal.
 */
export const SPEC_STATUSES = [
  "backlog",
  "decomposed",
  "in_progress",
  "done",
  "in_review",
  "approved",
  "rejected",
  "canceled",
] as const;
export type SpecStatus = (typeof SPEC_STATUSES)[number];

/**
 * Legacy Spec status aliases absorbed on parse (G4.S5.T7 backward compat): the
 * historical `active` status ≡ `in_progress`, so existing Specs still parse.
 */
const SPEC_STATUS_ALIASES: Readonly<Record<string, SpecStatus>> = {
  active: "in_progress",
};

/** Map a raw Spec status to its canonical value; throws when it is unknown. */
export function normalizeSpecStatus(raw: string): SpecStatus {
  const status = SPEC_STATUS_ALIASES[raw] ?? raw;
  if (!(SPEC_STATUSES as readonly string[]).includes(status)) {
    throw new BoardSchemaError(`status must be one of: ${SPEC_STATUSES.join(", ")}`);
  }
  return status as SpecStatus;
}

/** Thrown when frontmatter does not conform to the G.S.T schema. */
export class BoardSchemaError extends Error {}

function requireString(fm: FrontmatterMap, key: string): string {
  const value = fm[key];
  if (typeof value !== "string") {
    throw new BoardSchemaError(`${key} must be a string`);
  }
  return value;
}

function optionalString(fm: FrontmatterMap, key: string): string | undefined {
  const value = fm[key];
  if (value === undefined) return undefined;
  return requireString(fm, key);
}

function optionalNumber(fm: FrontmatterMap, key: string): number | undefined {
  const value = fm[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number") {
    throw new BoardSchemaError(`${key} must be a number`);
  }
  return value;
}

function requireStringArray(fm: FrontmatterMap, key: string): string[] {
  const value = fm[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new BoardSchemaError(`${key} must be a list of strings`);
  }
  return value as string[];
}

/** Fields common to every layer. */
function requireCommon(fm: FrontmatterMap): { id: string; title: string; owner: string; status: string } {
  return {
    id: requireString(fm, "id"),
    title: requireString(fm, "title"),
    owner: requireString(fm, "owner"),
    status: requireString(fm, "status"),
  };
}

/** Validate a Goal (`layer: G`) frontmatter. */
export function parseGoal(fm: FrontmatterMap): GoalFrontmatter {
  const common = requireCommon(fm);
  if (fm.layer !== "G") throw new BoardSchemaError("Goal frontmatter must have layer: G");
  return {
    ...common,
    layer: "G",
    created_at: optionalString(fm, "created_at"),
    milestone: optionalString(fm, "milestone"),
    acceptance_criteria: requireStringArray(fm, "acceptance_criteria"),
  };
}

/** Validate a Spec (`layer: S`) frontmatter. */
export function parseSpec(fm: FrontmatterMap): SpecFrontmatter {
  const common = requireCommon(fm);
  if (fm.layer !== "S") throw new BoardSchemaError("Spec frontmatter must have layer: S");
  const status = normalizeSpecStatus(common.status);
  return {
    id: common.id,
    title: common.title,
    owner: common.owner,
    layer: "S",
    parent: requireString(fm, "parent"),
    milestone: optionalString(fm, "milestone"),
    acceptance_criteria: requireStringArray(fm, "acceptance_criteria"),
    status,
  };
}

/** Validate a Ticket (`layer: T`) frontmatter. */
export function parseTicket(fm: FrontmatterMap): TicketFrontmatter {
  const common = requireCommon(fm);
  if (fm.layer !== "T") throw new BoardSchemaError("Ticket frontmatter must have layer: T");
  const status = common.status;
  if (!(TICKET_STATUSES as readonly string[]).includes(status)) {
    throw new BoardSchemaError(`status must be one of: ${TICKET_STATUSES.join(", ")}`);
  }
  return {
    ...common,
    layer: "T",
    parent: requireString(fm, "parent"),
    status: status as TicketStatus,
    assignee: requireString(fm, "assignee"),
    session_id: optionalString(fm, "session_id"),
    started_at: optionalString(fm, "started_at"),
    completed_at: optionalString(fm, "completed_at"),
    blocked_by: requireStringArray(fm, "blocked_by"),
    acceptance_criteria: requireStringArray(fm, "acceptance_criteria"),
    pr: optionalNumber(fm, "pr"),
    branch: optionalString(fm, "branch"),
    parent_id: optionalString(fm, "parent_id"),
    qa_feedback: optionalString(fm, "qa_feedback"),
    reopen_reason: optionalString(fm, "reopen_reason"),
  };
}

/** Validate frontmatter by dispatching on its `layer`. */
export function parseBoardFrontmatter(fm: FrontmatterMap): BoardFrontmatter {
  if (fm.layer === "G") return parseGoal(fm);
  if (fm.layer === "S") return parseSpec(fm);
  if (fm.layer === "T") return parseTicket(fm);
  throw new BoardSchemaError(`layer must be one of: ${LAYERS.join(", ")}`);
}

/** Base fields shared by all three layers. */
export interface BoardFrontmatterBase {
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
  status: SpecStatus;
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
  pr?: number;
  branch?: string;
  parent_id?: string;
  qa_feedback?: string;
  reopen_reason?: string;
}

export type BoardFrontmatter = GoalFrontmatter | SpecFrontmatter | TicketFrontmatter;
