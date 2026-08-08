/**
 * The review + rework lifecycle (G3.S6.T4): the Reviewer approves or rejects a
 * ticket, and the Eng Director re-decomposes a rejected ticket into a new
 * backlog ticket linked via parent_id / qa_feedback / reopen_reason.
 *
 * Matches docs/git-kanban-design.md §11: the original rejected ticket is
 * preserved (status + history kept); the fix enters the board as a new ticket
 * that any worker can claim.
 */

import { readTicketFile, writeBoardFile, type TicketDocument } from "./board.js";
import { nextTicketRef, ticketId } from "./planning.js";
import { appendLog } from "./protocol.js";
import type { TicketFrontmatter } from "./schema.js";

/** Thrown when a lifecycle step fails validation (wrong state or missing input). */
export class LifecycleError extends Error {}

function today(now: string | undefined): string {
  return now ?? new Date().toISOString().slice(0, 10);
}

async function loadTicket(
  root: string,
  ref: string,
): Promise<{ doc: Awaited<ReturnType<typeof readTicketFile>>["doc"]; ticket: TicketFrontmatter }> {
  try {
    return await readTicketFile(root, ref);
  } catch (err) {
    throw new LifecycleError(err instanceof Error ? err.message : String(err));
  }
}

/** Reviewer rejection input. */
export interface RejectInput {
  reviewer: string;
  /** Required: the QA feedback explaining the rejection. */
  qaFeedback: string;
  /** Keep the PR number when it stays open for the rework. */
  pr?: number;
  branch?: string;
  /** Date used for the log entry; defaults to today (YYYY-MM-DD). */
  now?: string;
}

/**
 * Reviewer rejects an in_review ticket: marks it rejected, records qa_feedback
 * and appends a Log entry. The original ticket is preserved, never deleted.
 */
export async function rejectTicket(
  root: string,
  ref: string,
  input: RejectInput,
): Promise<{ ref: string; log: string }> {
  const { doc, ticket } = await loadTicket(root, ref);
  if (ticket.status !== "in_review") {
    throw new LifecycleError(`cannot reject ${ref}: ticket is ${ticket.status}, expected in_review`);
  }
  if (!input.reviewer || input.reviewer.trim() === "") {
    throw new LifecycleError(`reviewer is required to reject ${ref}`);
  }
  if (!input.qaFeedback || input.qaFeedback.trim() === "") {
    throw new LifecycleError(`qa_feedback is required to reject ${ref}`);
  }

  const date = today(input.now);
  const updated: TicketFrontmatter = {
    ...ticket,
    status: "rejected",
    qa_feedback: input.qaFeedback,
    ...(input.pr !== undefined ? { pr: input.pr } : {}),
    ...(input.branch ? { branch: input.branch } : {}),
  };
  const log = appendLog(doc.body, date, `${input.reviewer} rejected ${ref}: ${input.qaFeedback}`);
  await writeBoardFile(root, { ref, frontmatter: updated, body: log });
  return { ref, log };
}

/** Reviewer approval input. */
export interface ApproveInput {
  reviewer: string;
  /** The merged PR number, when the approval merges the PR. */
  pr?: number;
  /** Date used for completed_at + log entry; defaults to today (YYYY-MM-DD). */
  now?: string;
}

/**
 * Reviewer approves an in_review ticket: marks it approved with completed_at
 * and appends a Log entry.
 */
export async function approveTicket(
  root: string,
  ref: string,
  input: ApproveInput,
): Promise<{ ref: string; log: string }> {
  const { doc, ticket } = await loadTicket(root, ref);
  if (ticket.status !== "in_review") {
    throw new LifecycleError(`cannot approve ${ref}: ticket is ${ticket.status}, expected in_review`);
  }
  if (!input.reviewer || input.reviewer.trim() === "") {
    throw new LifecycleError(`reviewer is required to approve ${ref}`);
  }

  const date = today(input.now);
  const updated: TicketFrontmatter = {
    ...ticket,
    status: "approved",
    completed_at: date,
    ...(input.pr !== undefined ? { pr: input.pr } : {}),
  };
  const merged = input.pr !== undefined ? ` (pr#${input.pr} merged)` : "";
  const log = appendLog(doc.body, date, `${input.reviewer} approved ${ref}${merged}`);
  await writeBoardFile(root, { ref, frontmatter: updated, body: log });
  return { ref, log };
}

/** Eng Director re-decompose input for a rejected ticket. */
export interface ReDecomposeInput {
  title: string;
  acceptanceCriteria: string[];
  /** Required: the Eng Director's reason for re-opening the work. */
  reopenReason: string;
  task?: string;
  owner?: string;
  /** Date used for the log entry on the original; defaults to today. */
  now?: string;
}

export interface ReDecomposeResult {
  /** The newly created rework ticket ref, e.g. G1.S1.T2. */
  ref: string;
  /** On-disk path of the new ticket. */
  path: string;
  /** The rejected original ticket this rework stems from. */
  originalRef: string;
  /** Log entry appended to the original ticket. */
  log: string;
}

/**
 * Eng Director re-decomposes a rejected ticket: creates a new backlog ticket
 * under the same spec, linked via parent_id (the rejected original) and
 * carrying the original's qa_feedback + a reopen_reason. The original ticket
 * stays rejected; a Log entry records the re-decompose.
 */
export async function reDecompose(
  root: string,
  originalRef: string,
  input: ReDecomposeInput,
): Promise<ReDecomposeResult> {
  const { doc, ticket } = await loadTicket(root, originalRef);
  if (ticket.status !== "rejected") {
    throw new LifecycleError(`cannot re-decompose ${originalRef}: ticket is ${ticket.status}, expected rejected`);
  }
  if (!input.title || input.title.trim() === "") {
    throw new LifecycleError(`title is required to re-decompose ${originalRef}`);
  }
  if (!input.reopenReason || input.reopenReason.trim() === "") {
    throw new LifecycleError(`reopen_reason is required to re-decompose ${originalRef}`);
  }
  if (input.acceptanceCriteria.length === 0) {
    throw new LifecycleError(`acceptance_criteria must not be empty to re-decompose ${originalRef}`);
  }

  const specRef = originalRef.split(".").slice(0, 2).join(".");
  const newRef = await nextTicketRef(root, specRef);
  const date = today(input.now);

  const rework: TicketDocument = {
    ref: newRef,
    frontmatter: {
      id: ticketId(newRef),
      title: `${newRef}: ${input.title}`,
      layer: "T",
      parent: specRef,
      owner: input.owner ?? "eng-director",
      status: "backlog",
      assignee: "",
      started_at: "",
      blocked_by: [],
      acceptance_criteria: input.acceptanceCriteria,
      parent_id: originalRef,
      qa_feedback: ticket.qa_feedback,
      reopen_reason: input.reopenReason,
    },
    body: `# ${newRef}: ${input.title}\n\n## Task\n\n${input.task ?? ""}\n`,
  };
  const path = await writeBoardFile(root, rework);

  const log = appendLog(
    doc.body,
    date,
    `Eng Director re-decomposed ${originalRef} into ${newRef} (reopen_reason: ${input.reopenReason})`,
  );
  await writeBoardFile(root, { ref: originalRef, frontmatter: doc.frontmatter, body: log });

  return { ref: newRef, path, originalRef, log };
}
