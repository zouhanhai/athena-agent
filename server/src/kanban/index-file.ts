/**
 * Kanban root index file — a single docs/kanban/kanban-index.json that caches the
 * ENTIRE board (Goals → Specs → Tickets with live status / assignee / session_id +
 * Progress Log last row), so GET /api/kanban no longer re-scans and re-opens every
 * ticket file on each refresh.
 *
 * - `read()` is the fast path: parse the single index file.
 * - `rescan()` re-scans the md board (existing scan.ts logic) and rewrites the index.
 * - `buildIndexFile()` is the standalone build/index step (npm run kanban:index).
 *
 * Trade-off: the index can go stale if md files change without a rescan; the explicit
 * refresh path (rescan) is the fallback, plus the index is committed so it tracks the
 * repo's committed kanban state.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { scanBoard, defaultBoardRoot, type KanbanBoard, type BoardError, type BoardTicket } from "./scan.js";
import { parseProgressLog } from "./progress.js";
import type { TicketStatus } from "./schema.js";

export const INDEX_VERSION = 1;
export const INDEX_FILENAME = "kanban-index.json";

/** A cached ticket: every field the Workbench needs, incl. live Progress Log state. */
export interface KanbanIndexTicket {
  ref: string;
  id: string;
  title: string;
  owner: string;
  status: TicketStatus;
  assignee: string;
  session_id?: string;
  blocked_by: string[];
  acceptance_criteria: string[];
  started_at?: string;
  completed_at?: string;
  progress_last_row?: string;
  progress_updated_at?: string;
}

/** A cached spec with its child tickets. */
export interface KanbanIndexSpec {
  ref: string;
  id: string;
  title: string;
  owner: string;
  status: string;
  milestone?: string;
  tickets: KanbanIndexTicket[];
}

/** A cached goal with its child specs. */
export interface KanbanIndexGoal {
  ref: string;
  id: string;
  title: string;
  owner: string;
  status: string;
  created_at?: string;
  milestone?: string;
  specs: KanbanIndexSpec[];
}

/** The root index document: versioned cache of the whole board. */
export interface KanbanIndex {
  version: number;
  generated_at: string;
  goals: KanbanIndexGoal[];
  errors: BoardError[];
}

/** Convert a scanned board into the flat index shape, pulling Progress Log state. */
export function toIndex(board: KanbanBoard, generatedAt = new Date().toISOString()): KanbanIndex {
  return {
    version: INDEX_VERSION,
    generated_at: generatedAt,
    goals: board.goals.map((goal) => ({
      ref: goal.ref,
      id: goal.goal.id,
      title: goal.goal.title,
      owner: goal.goal.owner,
      status: goal.goal.status,
      created_at: goal.goal.created_at,
      milestone: goal.goal.milestone,
      specs: goal.specs.map((spec) => ({
        ref: spec.ref,
        id: spec.spec.id,
        title: spec.spec.title,
        owner: spec.spec.owner,
        status: spec.spec.status,
        milestone: spec.spec.milestone,
        tickets: spec.tickets.map(toIndexTicket),
      })),
    })),
    errors: board.errors,
  };
}

function toIndexTicket(ticket: BoardTicket): KanbanIndexTicket {
  const { progress_last_row, progress_updated_at } = ticket.body
    ? parseProgressLog(ticket.body)
    : {};
  return {
    ref: ticket.ref,
    id: ticket.ticket.id,
    title: ticket.ticket.title,
    owner: ticket.ticket.owner,
    status: ticket.ticket.status,
    assignee: ticket.ticket.assignee,
    session_id: ticket.ticket.session_id,
    blocked_by: ticket.ticket.blocked_by,
    acceptance_criteria: ticket.ticket.acceptance_criteria,
    started_at: ticket.ticket.started_at,
    completed_at: ticket.ticket.completed_at,
    progress_last_row,
    progress_updated_at,
  };
}

/** The on-disk path of the root index for a board root. */
export function indexFilePath(root: string): string {
  return path.join(root, INDEX_FILENAME);
}

/** Re-export so callers can build a FileKanbanIndex rooted at the repo board. */
export { defaultBoardRoot } from "./scan.js";

/** Fast read of a valid committed index; null when missing/corrupt/version-mismatched. */
export async function readIndexFile(root: string): Promise<KanbanIndex | null> {
  try {
    const parsed = JSON.parse(await readFile(indexFilePath(root), "utf8")) as Partial<KanbanIndex>;
    if (parsed.version !== INDEX_VERSION || !Array.isArray(parsed.goals) || !Array.isArray(parsed.errors)) {
      return null;
    }
    return parsed as KanbanIndex;
  } catch {
    return null;
  }
}

/** Remote repo read access for the remote fast path (structural subset of GitHubApi). */
export interface RemoteIndexSource {
  getFileContent(
    credential: unknown,
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<{ content: string }>;
}

/**
 * Fast path for a remote repo's board: read its committed `docs/kanban/kanban-index.json`
 * via a single GitHub API call, instead of recursively scanning every board file.
 * Returns null when the remote repo has no (valid) committed index, so the caller can
 * fall back to the full remote scan.
 */
export async function readRemoteIndex(
  github: RemoteIndexSource,
  credential: unknown,
  owner: string,
  repo: string,
  ref?: string,
): Promise<KanbanIndex | null> {
  try {
    const file = await github.getFileContent(credential, owner, repo, `${BOARD_ROOT_REL}${INDEX_FILENAME}`, ref);
    const parsed = JSON.parse(file.content) as Partial<KanbanIndex>;
    if (parsed.version !== INDEX_VERSION || !Array.isArray(parsed.goals) || !Array.isArray(parsed.errors)) {
      return null;
    }
    return parsed as KanbanIndex;
  } catch {
    return null;
  }
}

// docs/kanban/ relative path (matches BOARD_ROOT in scan.ts) for the remote index read.
const BOARD_ROOT_REL = "docs/kanban/";

/** Abstraction the kanban route consumes, so it can be faked in tests. */
export interface KanbanIndexService {
  /** Fast path: read the cached root index; falls back to a rescan when missing/invalid. */
  read(): Promise<KanbanIndex>;
  /** Force a rescan and rebuild the index file. */
  rescan(): Promise<KanbanIndex>;
}

/** File-backed root index. Fast `read()` + explicit `rescan()` (rebuild). */
export class FileKanbanIndex implements KanbanIndexService {
  constructor(private readonly root: string = defaultBoardRoot()) {}

  async read(): Promise<KanbanIndex> {
    return (await readIndexFile(this.root)) ?? this.rescan();
  }

  async rescan(): Promise<KanbanIndex> {
    const board = await scanBoard(this.root, { includeBody: true });
    const index = toIndex(board);
    await writeFile(indexFilePath(this.root), `${JSON.stringify(index, null, 2)}\n`, "utf8");
    return index;
  }
}

/** Scan the board and write the root index file (build/index step). */
export async function buildIndexFile(root: string = defaultBoardRoot()): Promise<KanbanIndex> {
  return new FileKanbanIndex(root).rescan();
}
