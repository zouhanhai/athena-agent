/**
 * Progress Log appender for the OpenCode worker plugin (G4.S4.T1).
 *
 * Appends a row to a ticket's `## Progress Log` table using a REAL wall-clock
 * UTC timestamp (2026-08-09 lesson: LLM workers fabricate timestamps). Rows are
 * appended ONLY on a real change (a tool ran) and rate-limited (~1 row / N sec)
 * so a stale last-row timestamp is the stalled signal (git-kanban-design.md §10).
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { refToPath } from "../../server/src/kanban/board.js";

/** A single Progress Log data row. */
export interface ProgressRow {
  /** Real wall-clock UTC timestamp (ISO-8601, e.g. 2026-08-13T08:00:00.000Z). */
  timestamp: string;
  /** Ticket status cell (mirrors the ticket state machine). */
  status: string;
  /** One line of what the worker is doing. */
  progress: string;
}

const TABLE_HEADER = "| UTC timestamp | status | progress |";
const TABLE_SEP = "|---|---|---|";

/**
 * Append a Progress Log row to a ticket body. Creates the `## Progress Log`
 * table when missing; appends a data row under an existing table (after the
 * header/separator, before trailing content). Returns the new body.
 */
export function appendProgressRow(body: string, row: ProgressRow): string {
  const line = `| ${row.timestamp} | ${row.status} | ${row.progress} |`;
  const trimmed = body.replace(/\s+$/, "");
  const hasTable = /^##\s*Progress\s*Log\s*$/im.test(trimmed);
  if (!hasTable) {
    return `${trimmed}\n\n## Progress Log\n${TABLE_HEADER}\n${TABLE_SEP}\n${line}\n`;
  }

  // Insert the row after the header/separator block of the existing table.
  const lines = trimmed.split("\n");
  let heading = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s*Progress\s*Log\s*$/i.test(lines[i])) {
      heading = i;
      break;
    }
  }
  const insertAt = heading + 1 + countTablePreamble(lines.slice(heading + 1));
  lines.splice(insertAt, 0, line);
  return `${lines.join("\n")}\n`;
}

/** Count only the header + separator rows that immediately follow the heading. */
function countTablePreamble(lines: string[]): number {
  let n = 0;
  for (const line of lines) {
    if (!/^\s*\|/.test(line)) break;
    const cells = line
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell !== "");
    if (cells.length === 0) break;
    if (cells.some((cell) => /^(timestamp|utc|status|progress)$/i.test(cell))) {
      n++; // header row
      continue;
    }
    if (cells.every((cell) => /^[-:\s]+$/.test(cell))) {
      n++; // separator row
      continue;
    }
    break; // a data row — stop
  }
  return n;
}

/** Options for the ProgressLogAppender. */
export interface ProgressAppenderOptions {
  /** The kanban board root (docs/kanban). */
  boardRoot: string;
  /** Rate-limit window: minimum ms between rows for the same ticket. */
  minIntervalMs?: number;
  /** Clock override for tests; defaults to the real wall clock. */
  now?: () => Date;
}

const DEFAULT_MIN_INTERVAL_MS = 30_000;

/**
 * File-backed Progress Log appender. Appends a row to the ticket's md file on
 * a real change, stamped with the real wall-clock time, rate-limited per
 * ticket. Writes are local-only (NOT committed — the git strategy in §44 keeps
 * Progress Log rows out of history until the ticket is pushed on completion).
 */
export class ProgressAppender {
  private readonly boardRoot: string;
  private readonly minIntervalMs: number;
  private readonly now: () => Date;
  private readonly lastByRef = new Map<string, number>();

  constructor(options: ProgressAppenderOptions) {
    this.boardRoot = options.boardRoot;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Append a row if a real change happened and the rate limit allows.
   * Returns true when appended, false when rate-limited. Timestamp is the real
   * wall-clock UTC time (never fabricated).
   */
  async append(ref: string, status: string, progress: string): Promise<boolean> {
    const nowMs = this.now().getTime();
    const last = this.lastByRef.get(ref) ?? 0;
    if (nowMs - last < this.minIntervalMs) return false;
    this.lastByRef.set(ref, nowMs);
    await this.appendUnchecked(ref, status, progress);
    return true;
  }

  private async appendUnchecked(ref: string, status: string, progress: string): Promise<void> {
    const filePath = refToPath(ref, this.boardRoot);
    const body = await readFile(filePath, "utf8");
    const row: ProgressRow = { timestamp: this.now().toISOString(), status, progress };
    await writeFile(filePath, appendProgressRow(body, row), "utf8");
  }
}
