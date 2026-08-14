/**
 * The 6-role lifecycle souls (G3.S6.T4) — Consultant / PM / Eng Director /
 * Worker / Reviewer / Writer, each with a distinct duty at a lifecycle stage.
 * Matches the role table in docs/g3-requirements.md §4.2 and the board owner
 * values used across docs/kanban.
 */

/** The six soul roles in lifecycle order. */
export const ROLE_IDS = [
  "consultant",
  "pm",
  "eng-director",
  "worker",
  "reviewer",
  "writer",
] as const;
export type RoleId = (typeof ROLE_IDS)[number];

/** The lifecycle stages a role can operate at. */
export const ROLE_STAGES = [
  "pre-plan",
  "planning",
  "rework",
  "execution",
  "review",
  "wrap-up",
] as const;
export type RoleStage = (typeof ROLE_STAGES)[number];

/** A role soul: the identity, duty and lifecycle placement of one role. */
export interface RoleSoul {
  id: RoleId;
  /** Display name, e.g. "Eng Director". */
  name: string;
  /** What the role is responsible for. */
  duty: string;
  /** The lifecycle stage(s) where the role operates. */
  stages: readonly RoleStage[];
  /** The artifact the role produces. */
  output: string;
}

/** The six role souls, keyed by role id. */
export const ROLES: Record<RoleId, RoleSoul> = {
  consultant: {
    id: "consultant",
    name: "Consultant",
    duty: "grill the requirements into a Goal",
    stages: ["pre-plan"],
    output: "Goal.md",
  },
  pm: {
    id: "pm",
    name: "PM",
    duty: "to-spec: decompose the Goal into Spec.md files",
    stages: ["planning"],
    output: "Spec.md",
  },
  "eng-director": {
    id: "eng-director",
    name: "Eng Director",
    duty: "to-ticket: decompose specs into tickets; re-decompose a rejected ticket",
    stages: ["planning", "rework"],
    output: "T{n}.md tickets + rework tickets",
  },
  worker: {
    id: "worker",
    name: "Worker",
    duty: "implement a ticket: claim it via git, develop, report done/in_review",
    stages: ["execution"],
    output: "implementation + status report",
  },
  reviewer: {
    id: "reviewer",
    name: "Reviewer",
    duty: "review done/in_review tickets and approve or reject with qa_feedback",
    stages: ["review"],
    output: "review verdict (approved / rejected)",
  },
  writer: {
    id: "writer",
    name: "Writer",
    duty: "write the docs, PR description and wrap-up deliverables",
    stages: ["wrap-up"],
    output: "docs + PR description",
  },
};

/** Look up a role soul by id; throws for an unknown role. */
export function roleSoul(id: RoleId): RoleSoul {
  const soul = ROLES[id];
  if (!soul) {
    throw new Error(`unknown role "${id}" — expected one of: ${ROLE_IDS.join(", ")}`);
  }
  return soul;
}

/** The soul role that owns each layer's planning output. */
export const PLANNING_OWNER: Record<"goal" | "spec" | "ticket", RoleId> = {
  goal: "consultant",
  spec: "pm",
  ticket: "eng-director",
};
