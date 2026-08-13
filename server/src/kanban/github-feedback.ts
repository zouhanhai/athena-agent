/**
 * GitHub → md feedback loop (G4.S5.T3).
 *
 * Closes the loop built by T1/T2 (md → GitHub projection): user-confirmed GitHub
 * changes flow BACK into the local md kanban (the single source of truth), and the
 * plan agent reads new Issue comments (deduped) into DRAFT md proposals.
 *
 * Three parts:
 *
 * 1. **Bidirectional status sync** — `pullProjectStatusChanges` reads a Project's
 *    cards, compares the GitHub Status column to each md ticket's status and writes
 *    user-confirmed GitHub statuses back to md. Every applied change is recorded in
 *    the md file with its origin (a `## GitHub sync` note carrying
 *    `synced_from: github <ts> <field> <old>→<new>`), so a human can audit where a
 *    change came from. The minute-level Progress Log still stays in md only.
 *
 * 2. **Feedback reader** — seen comment ids are tracked per spec in a
 *    `docs/kanban/Gx/Sy/sync-state.json` file, so the plan agent only processes new
 *    comments (`dedupeComments` / `markCommentsSeen`).
 *
 * 3. **Plan-agent reconcile path** — new comments + the current md state are bundled
 *    into a `FeedbackContext`; the plan agent turns them into a DRAFT md update via
 *    the planning.ts builders (`buildPlanDraft` / `buildTicketDraft` / `buildSpecDraft`
 *    / `buildEditDraft`). Drafts are never applied silently — a human approves, then
 *    `applyFeedbackDraft` writes them into docs/kanban.
 *
 * **Conflict handling (md authoritative on ambiguity)**: a sync that would be
 * ambiguous (an unknown Status option, a GitHub card with no md ticket) is surfaced
 * as a `conflicts` report and never silently overwrites md.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GithubCredential } from "../employees/employees.js";
import type { GithubIssueComment, GithubProject, GithubProjectItem, GitHubApi } from "../github/client.js";
import { readBoardFile, readTicketFile, refToPath, writeBoardFile } from "./board.js";
import { findSpecInBoard, specIssueTitle } from "./github-sync.js";
import {
  buildGoal,
  buildSpec,
  buildTicket,
  nextGoalRef,
  nextSpecRef,
  nextTicketRef,
  PlanningError,
  validatePlan,
  type PlanInput,
  type SpecDraft,
  type TicketDraft,
} from "./planning.js";
import type { BoardFrontmatter, SpecFrontmatter } from "./schema.js";
import { defaultBoardRoot, type BoardTicket, type KanbanBoard } from "./scan.js";
import { projectStatusToKanbanStatus } from "./status-map.js";

// ---------------------------------------------------------------------------
// Origin markers (audit trail in md)
// ---------------------------------------------------------------------------

/** The origin marker line for a GitHub-derived md change. */
export function buildOriginMarker(timestamp: string, field: string, from: string, to: string): string {
  return `synced_from: github ${timestamp} ${field} ${from}→${to}`;
}

/**
 * Append a `## GitHub sync` note to a ticket body; creates the section when
 * missing. The note records the origin of every GitHub-derived md change.
 */
export function appendGitHubSyncNote(
  body: string,
  timestamp: string,
  field: string,
  from: string,
  to: string,
): string {
  const trimmed = body.replace(/\s+$/, "");
  const line = `- ${buildOriginMarker(timestamp, field, from, to)}`;
  if (!/^##\s+GitHub sync/m.test(trimmed)) {
    return `${trimmed}\n\n## GitHub sync\n\n${line}\n`;
  }
  return `${trimmed}\n\n${line}\n`;
}

// ---------------------------------------------------------------------------
// Bidirectional status sync (GitHub → md)
// ---------------------------------------------------------------------------

/** One status change applied to an md ticket, with its recorded origin. */
export interface AppliedStatusChange {
  ref: string;
  field: "status";
  oldStatus: string;
  newStatus: string;
  timestamp: string;
  /** The origin marker written into the md file (see buildOriginMarker). */
  origin: string;
}

/** A sync the module refused to apply because md is authoritative on ambiguity. */
export interface SyncConflict {
  ref: string;
  field: string;
  reason: string;
  /** The GitHub-side value (option name, card title, …). */
  ghValue: string | null;
  /** The md-side value at conflict time. */
  mdValue: string | null;
}

/** The outcome of pullProjectStatusChanges. */
export interface PullStatusResult {
  /** The spec the pull was scoped to, or null when the whole board was pulled. */
  specRef: string | null;
  applied: AppliedStatusChange[];
  conflicts: SyncConflict[];
  unchanged: string[];
}

export interface PullStatusOptions {
  /** Board root; defaults to the repo's docs/kanban. */
  root?: string;
  /** Timestamp used for origin markers; defaults to now. */
  now?: string;
  /** Scope the pull to one spec (`Gx.Sy`); defaults to the whole board. */
  specRef?: string;
}

const TICKET_REF = /^G\d+\.S\d+\.T\d+$/;

/**
 * Read the Project's cards and sync user-confirmed Status changes back to the md
 * tickets (the single source of truth). GitHub is authoritative for a card a user
 * moved; every applied change is recorded in md with its origin. A card whose Status
 * option is unknown, or whose title has no md ticket, is surfaced as a conflict and
 * never silently overwrites md.
 */
export async function pullProjectStatusChanges(
  github: GitHubApi,
  credential: GithubCredential,
  owner: string,
  repo: string,
  board: KanbanBoard,
  project: GithubProject,
  options: PullStatusOptions = {},
): Promise<PullStatusResult> {
  const root = options.root ?? defaultBoardRoot();
  const now = options.now ?? new Date().toISOString();

  const mdByRef = new Map<string, string>();
  for (const goal of board.goals) {
    for (const spec of goal.specs) {
      if (options.specRef && spec.ref !== options.specRef) continue;
      for (const ticket of spec.tickets) {
        mdByRef.set(ticket.ref, spec.ref);
      }
    }
  }

  const applied: AppliedStatusChange[] = [];
  const conflicts: SyncConflict[] = [];
  const unchanged: string[] = [];

  const items = await github.getProjectItems(credential, project.id);
  for (const card of items) {
    const title = card.title;
    if (!title || !TICKET_REF.test(title)) {
      // The spec main issue, a draft card, or any non-ticket card — not part of
      // the ticket-status mapping.
      continue;
    }
    const specRef = mdByRef.get(title);
    if (!specRef) {
      conflicts.push({
        ref: title,
        field: "status",
        reason: `GitHub card "${title}" has no md ticket — reconcile (plan agent) instead of overwriting`,
        ghValue: title,
        mdValue: null,
      });
      continue;
    }
    if (card.status === null) {
      // GitHub has not set a status → no user-confirmed change; md keeps its value.
      continue;
    }
    const kanban = projectStatusToKanbanStatus(card.status);
    if (kanban === null) {
      const doc = await readTicketFile(root, title).catch(() => null);
      conflicts.push({
        ref: title,
        field: "status",
        reason: `unknown GitHub Status option "${card.status}" — cannot map to a kanban status`,
        ghValue: card.status,
        mdValue: doc ? doc.ticket.status : null,
      });
      continue;
    }

    // Re-read the ticket file for the authoritative current status before writing.
    const { doc, ticket } = await readTicketFile(root, title);
    if (ticket.status === kanban) {
      unchanged.push(title);
      continue;
    }
    const oldStatus = ticket.status;
    const updated = { ...ticket, status: kanban };
    const body = appendGitHubSyncNote(doc.body, now, "status", oldStatus, kanban);
    await writeBoardFile(root, { ref: title, frontmatter: updated, body });
    applied.push({
      ref: title,
      field: "status",
      oldStatus,
      newStatus: kanban,
      timestamp: now,
      origin: buildOriginMarker(now, "status", oldStatus, kanban),
    });
  }

  return { specRef: options.specRef ?? null, applied, conflicts, unchanged };
}

// ---------------------------------------------------------------------------
// Feedback reader: comment dedup via a per-spec sync-state.json
// ---------------------------------------------------------------------------

export const SYNC_STATE_VERSION = 1;

/** One seen comment marker. */
export interface SyncStateComment {
  issueNumber: number;
  commentId: number;
  /** When the comment was first surfaced to the plan agent. */
  at: string;
}

/** The per-spec seen-comment marker file. */
export interface SyncState {
  version: typeof SYNC_STATE_VERSION;
  specRef: string;
  seen: SyncStateComment[];
}

/** The sync-state.json path for a spec: docs/kanban/Gx/Sy/sync-state.json. */
export function syncStatePath(root: string, specRef: string): string {
  return path.join(path.dirname(refToPath(specRef, root)), "sync-state.json");
}

/** Read a spec's seen-comment state; null when absent or malformed. */
export async function readSyncState(root: string, specRef: string): Promise<SyncState | null> {
  try {
    const raw = await readFile(syncStatePath(root, specRef), "utf8");
    const parsed = JSON.parse(raw) as SyncState;
    if (
      parsed.version !== SYNC_STATE_VERSION ||
      parsed.specRef !== specRef ||
      !Array.isArray(parsed.seen)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Write a spec's seen-comment state. */
export async function writeSyncState(root: string, specRef: string, state: SyncState): Promise<void> {
  const file = syncStatePath(root, specRef);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** An empty (never-synced) seen-comment state for a spec. */
export function emptySyncState(specRef: string): SyncState {
  return { version: SYNC_STATE_VERSION, specRef, seen: [] };
}

/** The dedup result of a comment thread against the seen markers. */
export interface CommentDedupResult {
  /** Comments the plan agent has not processed yet. */
  fresh: GithubIssueComment[];
  /** Comments already surfaced in a previous feedback pass. */
  seen: GithubIssueComment[];
}

/** Split a comment thread into fresh vs already-seen comments. */
export function dedupeComments(comments: GithubIssueComment[], state: SyncState): CommentDedupResult {
  const seenIds = new Set(state.seen.map((s) => s.commentId));
  const fresh: GithubIssueComment[] = [];
  const seen: GithubIssueComment[] = [];
  for (const comment of comments) {
    if (seenIds.has(comment.id)) {
      seen.push(comment);
    } else {
      fresh.push(comment);
    }
  }
  return { fresh, seen };
}

/** Record comment ids as seen (idempotent), preserving the existing markers. */
export function markCommentsSeen(
  state: SyncState,
  comments: GithubIssueComment[],
  issueNumber: number,
  now?: string,
): SyncState {
  const timestamp = now ?? new Date().toISOString();
  const existing = new Set(state.seen.map((s) => s.commentId));
  const seen = [...state.seen];
  for (const comment of comments) {
    if (!existing.has(comment.id)) {
      seen.push({ issueNumber, commentId: comment.id, at: timestamp });
      existing.add(comment.id);
    }
  }
  return { ...state, seen };
}

// ---------------------------------------------------------------------------
// Feedback context: comments + md state, presented to the plan agent
// ---------------------------------------------------------------------------

/** The md-side state + new comments handed to the plan agent for reconciliation. */
export interface FeedbackContext {
  specRef: string;
  issueNumber: number;
  spec: SpecFrontmatter;
  tickets: BoardTicket[];
  newComments: GithubIssueComment[];
  generatedAt: string;
}

/** What readFeedbackContext found, for the caller (CLI) to consume. */
export interface FeedbackReadResult {
  context: FeedbackContext;
  issueNumber: number;
  state: SyncState;
  newComments: GithubIssueComment[];
}

/** Bundle the current md state of a spec with its new comments. */
export async function buildFeedbackContext(
  root: string,
  board: KanbanBoard,
  specRef: string,
  issueNumber: number,
  newComments: GithubIssueComment[],
  now?: string,
): Promise<FeedbackContext> {
  const { spec, tickets } = findSpecInBoard(board, specRef);
  return {
    specRef,
    issueNumber,
    spec,
    tickets,
    newComments,
    generatedAt: now ?? new Date().toISOString(),
  };
}

/**
 * The plan-agent read path: resolve the spec's main Issue, fetch its comments,
 * dedupe against the seen markers and bundle the md state + new comments. Callers
 * that generate a proposal from the result mark the comments seen afterwards.
 */
export async function readFeedbackContext(
  github: GitHubApi,
  credential: GithubCredential,
  owner: string,
  repo: string,
  root: string,
  board: KanbanBoard,
  specRef: string,
  now?: string,
): Promise<FeedbackReadResult> {
  const { spec } = findSpecInBoard(board, specRef);
  const issue = await github.getIssueByTitle(credential, owner, repo, specIssueTitle(specRef, spec));
  if (!issue) {
    throw new Error(`no GitHub issue for ${specRef} — run "sync-github create ${specRef}" first`);
  }
  const comments = await github.getIssueComments(credential, owner, repo, issue.number);
  const state = (await readSyncState(root, specRef)) ?? emptySyncState(specRef);
  const { fresh } = dedupeComments(comments, state);
  const context = await buildFeedbackContext(root, board, specRef, issue.number, fresh, now);
  return { context, issueNumber: issue.number, state, newComments: fresh };
}

// ---------------------------------------------------------------------------
// Plan-agent reconcile path: DRAFT md updates via planning.ts builders
// ---------------------------------------------------------------------------

/** A board document proposed by the plan agent — a DRAFT, never applied silently. */
export interface DraftDocument {
  ref: string;
  path: string;
  frontmatter: BoardFrontmatter;
  body: string;
  status: "draft";
}

/** The kinds of md updates the plan agent can propose (grill → to-spec → to-ticket). */
export type MdUpdateDraft =
  | { kind: "create_goal"; doc: DraftDocument }
  | { kind: "create_spec"; doc: DraftDocument }
  | { kind: "create_ticket"; doc: DraftDocument }
  | { kind: "edit"; ref: string; doc: DraftDocument };

/** A DRAFT whole-plan (new Goal + Specs + Tickets) allocated by planning.ts. */
export interface PlanDraft {
  goalRef: string;
  specs: Array<{ specRef: string; ticketRefs: string[] }>;
  drafts: MdUpdateDraft[];
}

function toDraftDocument(ref: string, root: string, doc: { frontmatter: BoardFrontmatter; body: string }): DraftDocument {
  return { ref, path: refToPath(ref, root), frontmatter: doc.frontmatter, body: doc.body, status: "draft" };
}

/**
 * Build a DRAFT plan (new Goal/Spec/Tickets) for a new idea from the issue
 * discussion. Allocates the next G (and S/T) refs and reuses the planning.ts
 * builders — the exact same documents `planGoal` would write — but writes nothing.
 */
export async function buildPlanDraft(root: string, input: PlanInput): Promise<PlanDraft> {
  const goalRef = await nextGoalRef(root);
  const plan = {
    goalRef,
    goal: input.goal,
    specs: input.specs.map((specInput, i) => ({
      specRef: `${goalRef}.S${i + 1}`,
      spec: specInput.spec,
      tickets: specInput.tickets.map((ticket, j) => ({ ticketRef: `${goalRef}.S${i + 1}.T${j + 1}`, ticket })),
    })),
  };
  const problems = validatePlan(plan);
  if (problems.length > 0) {
    throw new PlanningError(`goal plan is invalid:\n- ${problems.join("\n- ")}`);
  }

  const drafts: MdUpdateDraft[] = [];
  const goalDoc = buildGoal(goalRef, input.goal);
  drafts.push({ kind: "create_goal", doc: toDraftDocument(goalRef, root, goalDoc) });
  const specs: PlanDraft["specs"] = [];
  for (const spec of plan.specs) {
    const specDoc = buildSpec(spec.specRef, spec.spec);
    drafts.push({ kind: "create_spec", doc: toDraftDocument(spec.specRef, root, specDoc) });
    const ticketRefs: string[] = [];
    for (const t of spec.tickets) {
      const ticketDoc = buildTicket(t.ticketRef, t.ticket);
      drafts.push({ kind: "create_ticket", doc: toDraftDocument(t.ticketRef, root, ticketDoc) });
      ticketRefs.push(t.ticketRef);
    }
    specs.push({ specRef: spec.specRef, ticketRefs });
  }

  return { goalRef, specs, drafts };
}

/** Build a DRAFT new-ticket document under an existing spec (next T ref). */
export async function buildTicketDraft(root: string, specRef: string, draft: TicketDraft): Promise<MdUpdateDraft> {
  const ref = await nextTicketRef(root, specRef);
  const doc = buildTicket(ref, draft);
  return { kind: "create_ticket", doc: toDraftDocument(ref, root, doc) };
}

/** Build a DRAFT new-spec document under an existing goal (next S ref). */
export async function buildSpecDraft(root: string, goalRef: string, draft: SpecDraft): Promise<MdUpdateDraft> {
  const ref = await nextSpecRef(root, goalRef);
  const doc = buildSpec(ref, draft);
  return { kind: "create_spec", doc: toDraftDocument(ref, root, doc) };
}

/** The fields a plan agent may propose changing on an existing ticket/spec. */
export interface MdEditPatch {
  title?: string;
  task?: string;
  owner?: string;
  blocked_by?: string[];
  acceptance_criteria?: string[];
}

/**
 * Build a DRAFT edit to an existing ticket or spec: the plan agent's patch merged
 * over the current frontmatter, with the `# <ref>: <title>` heading and `## Task`
 * section rebuilt from the patch. The md file itself is untouched until a human
 * approves the draft.
 */
export async function buildEditDraft(root: string, ref: string, patch: MdEditPatch): Promise<MdUpdateDraft> {
  const { frontmatter, body: currentBody } = await readBoardFile(root, ref);
  if (frontmatter.layer !== "T" && frontmatter.layer !== "S") {
    throw new Error(`cannot edit ${ref}: only tickets and specs can be edited via feedback`);
  }
  const title = patch.title !== undefined ? patch.title : frontmatter.title;
  const updated = {
    ...frontmatter,
    ...(patch.title !== undefined ? { title: `${ref}: ${patch.title}` } : {}),
    ...(patch.owner !== undefined ? { owner: patch.owner } : {}),
    ...(patch.blocked_by !== undefined ? { blocked_by: patch.blocked_by } : {}),
    ...(patch.acceptance_criteria !== undefined ? { acceptance_criteria: patch.acceptance_criteria } : {}),
  };
  const heading = `# ${ref}: ${title}`;
  const bodyLines = currentBody.split("\n");
  bodyLines[0] = heading;
  let body = bodyLines.join("\n");
  if (patch.task !== undefined) {
    body = body.replace(/(## Task\n)(?:[\s\S]*?)(?=\n## |$)/, `$1${patch.task}\n`);
  }
  return {
    kind: "edit",
    ref,
    doc: { ref, path: refToPath(ref, root), frontmatter: updated, body, status: "draft" },
  };
}

/** A plan-agent feedback proposal: the md state + the DRAFT updates it suggests. */
export interface FeedbackProposal {
  specRef: string;
  generatedAt: string;
  context: FeedbackContext;
  drafts: MdUpdateDraft[];
}

/** Bundle a feedback context with the plan agent's DRAFT updates. */
export function buildFeedbackProposal(
  specRef: string,
  context: FeedbackContext,
  drafts: MdUpdateDraft[],
  now?: string,
): FeedbackProposal {
  return { specRef, generatedAt: now ?? new Date().toISOString(), context, drafts };
}

/**
 * Write a DRAFT into the board — the human-approved apply step that flows a
 * proposal back into docs/kanban. Never call this for an unapproved draft.
 */
export async function applyFeedbackDraft(root: string, draft: MdUpdateDraft): Promise<string> {
  const doc = draft.doc;
  return writeBoardFile(root, { ref: doc.ref, frontmatter: doc.frontmatter, body: doc.body });
}
