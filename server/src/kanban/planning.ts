/**
 * Planning-agent onboarding flow (grill → to-spec → to-ticket).
 *
 * The platform provides the md writers + validation for the three soul roles:
 * - Consultant → grill → Goal.md
 * - PM        → to-spec → Spec.md
 * - Eng Dir   → to-ticket → T1..Tn.md
 *
 * Reuses the G.S.T md helpers (schema + board read/write) from G3.S6.T1.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { parseRef, writeBoardFile, writeTicketFile, type BoardFileBase, type TicketDocument } from "./board.js";
import type { GoalFrontmatter, SpecFrontmatter, TicketFrontmatter } from "./schema.js";
import { PLANNING_OWNER } from "./roles.js";

export { PLANNING_OWNER };

/** Thrown when a planning draft or plan fails validation. */
export class PlanningError extends Error {}

/** Consultant grill output: everything needed to write Goal.md. */
export interface GoalDraft {
  title: string;
  context?: string;
  created_at?: string;
  milestone?: string;
  owner?: string;
  acceptance_criteria: string[];
}

/** PM to-spec output: everything needed to write Spec.md. */
export interface SpecDraft {
  title: string;
  task?: string;
  milestone?: string;
  owner?: string;
  acceptance_criteria: string[];
}

/** Eng Director to-ticket output: everything needed to write T{n}.md. */
export interface TicketDraft {
  title: string;
  task?: string;
  owner?: string;
  blocked_by?: string[];
  acceptance_criteria: string[];
}

/** The three-layer plan with refs assigned, ready for validation + writing. */
export interface PlanTicket {
  ticketRef: string;
  ticket: TicketDraft;
}

export interface PlanSpec {
  specRef: string;
  spec: SpecDraft;
  tickets: PlanTicket[];
}

export interface Plan {
  goalRef: string;
  goal: GoalDraft;
  specs: PlanSpec[];
}

/** Planner input: the three layers before G/S/T refs are allocated. */
export interface PlanInputSpec {
  spec: SpecDraft;
  tickets: TicketDraft[];
}

export interface PlanInput {
  goal: GoalDraft;
  specs: PlanInputSpec[];
}

/** What planGoal produced: allocated refs + written file paths. */
export interface PlannedGoal {
  goalRef: string;
  specs: Array<{ specRef: string; ticketRefs: string[] }>;
  files: string[];
}

/** "G4" → "g4". */
export function goalId(ref: string): string {
  return ref.toLowerCase();
}

/** "G4.S1" → "g4_s1". */
export function specId(ref: string): string {
  return ref.toLowerCase().replace(/\./g, "_");
}

/** "G4.S1.T1" → "t1". */
export function ticketId(ref: string): string {
  return ref.split(".").pop()!.toLowerCase();
}

/** The ref that owns a child ref: "G4.S1" → "G4", "G4.S1.T1" → "G4.S1". */
function parentRef(ref: string): string {
  return ref.split(".").slice(0, -1).join(".");
}

/** Build a Goal board document from a grill draft. */
export function buildGoal(ref: string, draft: GoalDraft): BoardFileBase {
  const title = `${ref}: ${draft.title}`;
  const body = `# ${title}\n\n## Background / Context\n\n${draft.context ?? ""}\n`;
  const frontmatter: GoalFrontmatter = {
    id: goalId(ref),
    title,
    layer: "G",
    owner: draft.owner ?? PLANNING_OWNER.goal,
    status: "active",
    created_at: draft.created_at,
    milestone: draft.milestone,
    acceptance_criteria: draft.acceptance_criteria,
  };
  return { ref, frontmatter, body };
}

/** Build a Spec board document from a to-spec draft. */
export function buildSpec(ref: string, draft: SpecDraft): BoardFileBase {
  const title = `${ref}: ${draft.title}`;
  const body = `# ${title}\n\n## Task\n\n${draft.task ?? ""}\n`;
  const frontmatter: SpecFrontmatter = {
    id: specId(ref),
    title,
    layer: "S",
    parent: parentRef(ref),
    owner: draft.owner ?? PLANNING_OWNER.spec,
    status: "active",
    milestone: draft.milestone,
    acceptance_criteria: draft.acceptance_criteria,
  };
  return { ref, frontmatter, body };
}

/** Build a Ticket document from a to-ticket draft. */
export function buildTicket(ref: string, draft: TicketDraft): TicketDocument {
  const title = `${ref}: ${draft.title}`;
  const body = `# ${title}\n\n## Task\n\n${draft.task ?? ""}\n`;
  const frontmatter: TicketFrontmatter = {
    id: ticketId(ref),
    title,
    layer: "T",
    parent: parentRef(ref),
    owner: draft.owner ?? PLANNING_OWNER.ticket,
    status: "backlog",
    assignee: "",
    started_at: "",
    blocked_by: draft.blocked_by ?? [],
    acceptance_criteria: draft.acceptance_criteria,
  };
  return { ref, frontmatter, body };
}

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

function criteriaProblem(layer: string, criteria: string[]): string | null {
  if (criteria.length === 0) return `${layer} acceptance_criteria must not be empty`;
  return null;
}

/** Validate a grill draft. Returns problem strings ([] when valid). */
export function validateGoalDraft(draft: GoalDraft): string[] {
  const problems: string[] = [];
  if (blank(draft.title)) problems.push("goal title is required");
  const c = criteriaProblem("goal", draft.acceptance_criteria);
  if (c) problems.push(c);
  return problems;
}

/** Validate a to-spec draft. Returns problem strings ([] when valid). */
export function validateSpecDraft(draft: SpecDraft): string[] {
  const problems: string[] = [];
  if (blank(draft.title)) problems.push("spec title is required");
  const c = criteriaProblem("spec", draft.acceptance_criteria);
  if (c) problems.push(c);
  return problems;
}

/** Validate a to-ticket draft. Returns problem strings ([] when valid). */
export function validateTicketDraft(draft: TicketDraft): string[] {
  const problems: string[] = [];
  if (blank(draft.title)) problems.push("ticket title is required");
  const c = criteriaProblem("ticket", draft.acceptance_criteria);
  if (c) problems.push(c);
  return problems;
}

/** True when a ref is a spec under goalRef, e.g. G4.S1 under G4. */
function isSpecUnder(goalRef: string, specRef: string): boolean {
  return new RegExp(`^${goalRef.replace(/\./g, "\\.")}\\.S\\d+$`).test(specRef);
}

/** True when a ref is a ticket under specRef, e.g. G4.S1.T1 under G4.S1. */
function isTicketUnder(specRef: string, ticketRef: string): boolean {
  return new RegExp(`^${specRef.replace(/\./g, "\\.")}\\.T\\d+$`).test(ticketRef);
}

/**
 * Validate a whole plan: each layer's draft is well-formed, every ref sits
 * under its parent layer, and refs are not duplicated.
 */
export function validatePlan(plan: Plan): string[] {
  const problems: string[] = [];
  try {
    parseRef(plan.goalRef);
  } catch {
    problems.push(`invalid goalRef ${plan.goalRef}`);
  }
  problems.push(...validateGoalDraft(plan.goal).map((p) => `goal: ${p}`));

  const specRefs = new Set<string>();
  for (const spec of plan.specs) {
    if (!isSpecUnder(plan.goalRef, spec.specRef)) {
      problems.push(`specRef ${spec.specRef} is not under ${plan.goalRef}`);
    }
    if (specRefs.has(spec.specRef)) problems.push(`duplicate specRef ${spec.specRef}`);
    specRefs.add(spec.specRef);
    problems.push(...validateSpecDraft(spec.spec).map((p) => `${spec.specRef}: ${p}`));

    const ticketRefs = new Set<string>();
    for (const ticket of spec.tickets) {
      if (!isTicketUnder(spec.specRef, ticket.ticketRef)) {
        problems.push(`ticketRef ${ticket.ticketRef} is not under ${spec.specRef}`);
      }
      if (ticketRefs.has(ticket.ticketRef)) problems.push(`duplicate ticketRef ${ticket.ticketRef}`);
      ticketRefs.add(ticket.ticketRef);
      problems.push(...validateTicketDraft(ticket.ticket).map((p) => `${ticket.ticketRef}: ${p}`));
    }
  }
  return problems;
}

function assertPlanning(problems: string[], what: string): void {
  if (problems.length > 0) {
    throw new PlanningError(`${what} plan is invalid:\n- ${problems.join("\n- ")}`);
  }
}

const G_DIR = /^G(\d+)$/;
const S_DIR = /^S(\d+)$/;
const T_FILE = /^T(\d+)\.md$/;

/** Max number among directory/file names matching a regex, 0 when unreadable. */
async function maxNumber(dir: string, test: (name: string) => number): Promise<number> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  let max = 0;
  for (const name of entries) {
    const n = test(name);
    if (n > max) max = n;
  }
  return max;
}

/** Next globally-incrementing Goal ref: max existing G + 1 (git-atomic push). */
export async function nextGoalRef(root: string): Promise<string> {
  const max = await maxNumber(root, (name) => {
    const m = G_DIR.exec(name);
    return m ? Number(m[1]) : 0;
  });
  return `G${max + 1}`;
}

/** Next Spec ref under a goal: max existing S + 1. */
export async function nextSpecRef(root: string, goalRef: string): Promise<string> {
  const max = await maxNumber(path.join(root, goalRef), (name) => {
    const m = S_DIR.exec(name);
    return m ? Number(m[1]) : 0;
  });
  return `${goalRef}.S${max + 1}`;
}

/** Next Ticket ref under a spec: max existing T + 1. */
export async function nextTicketRef(root: string, specRef: string): Promise<string> {
  const [goalRef, spec] = specRef.split(".");
  const max = await maxNumber(path.join(root, goalRef, spec), (name) => {
    const m = T_FILE.exec(name);
    return m ? Number(m[1]) : 0;
  });
  return `${specRef}.T${max + 1}`;
}

/** Validate, build and write a Goal.md from a grill draft. */
export async function writeGoal(root: string, ref: string, draft: GoalDraft): Promise<string> {
  assertPlanning(validateGoalDraft(draft), "goal");
  return writeBoardFile(root, buildGoal(ref, draft));
}

/** Validate, build and write a Spec.md from a to-spec draft. */
export async function writeSpec(root: string, ref: string, draft: SpecDraft): Promise<string> {
  assertPlanning(validateSpecDraft(draft), "spec");
  return writeBoardFile(root, buildSpec(ref, draft));
}

/** Validate, build and write a T{n}.md from a to-ticket draft. */
export async function writeTicket(root: string, ref: string, draft: TicketDraft): Promise<string> {
  assertPlanning(validateTicketDraft(draft), "ticket");
  return writeTicketFile(root, buildTicket(ref, draft));
}

/** Write a batch of tickets under a spec, auto-numbering T1..Tn after existing. */
export async function writeTickets(root: string, specRef: string, drafts: TicketDraft[]): Promise<string[]> {
  const files: string[] = [];
  for (const draft of drafts) {
    const ref = await nextTicketRef(root, specRef);
    files.push(await writeTicket(root, ref, draft));
  }
  return files;
}

/**
 * The grill → to-spec → to-ticket flow. Allocates the next G (and S/T under it),
 * validates the whole plan, then writes Goal.md, each Spec.md and every ticket.
 */
export async function planGoal(root: string, input: PlanInput): Promise<PlannedGoal> {
  const goalRef = await nextGoalRef(root);

  const plan: Plan = { goalRef, goal: input.goal, specs: [] };
  for (const [i, specInput] of input.specs.entries()) {
    const specRef = `${goalRef}.S${i + 1}`;
    plan.specs.push({
      specRef,
      spec: specInput.spec,
      tickets: specInput.tickets.map((ticket, j) => ({
        ticketRef: `${specRef}.T${j + 1}`,
        ticket,
      })),
    });
  }
  assertPlanning(validatePlan(plan), "goal");

  const files: string[] = [await writeBoardFile(root, buildGoal(goalRef, input.goal))];
  const specs: PlannedGoal["specs"] = [];
  for (const spec of plan.specs) {
    files.push(await writeBoardFile(root, buildSpec(spec.specRef, spec.spec)));
    const ticketRefs = spec.tickets.map((t) => t.ticketRef);
    for (const t of spec.tickets) {
      files.push(await writeTicketFile(root, buildTicket(t.ticketRef, t.ticket)));
    }
    specs.push({ specRef: spec.specRef, ticketRefs });
  }

  return { goalRef, specs, files };
}
