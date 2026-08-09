/**
 * Ticket Progress Log parsing (M4 worker-progress).
 *
 * Each ticket md can carry a `## Progress Log` table at the bottom, auto-appended
 * by the OpenCode worker-progress plugin:
 *
 * ```
 * ## Progress Log
 * | Timestamp (UTC) | Status | Progress |
 * |-----------------|--------|----------|
 * | 2026-08-09 12:00:00Z | in_progress | Reading code, understood ticket |
 * ```
 *
 * The last data row is the source of truth for "current progress": Kanban can show
 * the most recent `progress_last_row` + `progress_updated_at` without opening the file.
 */

export interface ProgressLogEntry {
  /** Timestamp (UTC) cell of the last row. */
  progress_updated_at?: string;
  /** Status cell of the last row (mirrors the ticket state machine). */
  status?: string;
  /** Progress cell of the last row: one line of what the worker is doing. */
  progress_last_row?: string;
}

const PROGRESS_HEADING = /^##\s+([^\n]*)$/;

/**
 * Parse the last data row of a ticket body's `## Progress Log` table.
 * Returns an empty object when there is no Progress Log or no data rows.
 */
export function parseProgressLog(body: string): ProgressLogEntry {
  const rows: ProgressLogEntry[] = [];
  let inLog = false;

  for (const raw of body.split("\n")) {
    const heading = raw.match(PROGRESS_HEADING);
    if (heading) {
      const isProgressLog = /progress\s*log/i.test(heading[1] ?? "");
      if (isProgressLog) {
        // Entering the Progress Log: start fresh so earlier table-like text is ignored.
        rows.length = 0;
      }
      inLog = isProgressLog;
      continue;
    }
    if (!inLog || !/^\s*\|/.test(raw)) continue;

    const cells = raw
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell !== "");
    if (cells.length < 3) continue;
    // Separator row like |-----|-----|-----|
    if (cells.every((cell) => /^[-:\s]+$/.test(cell))) continue;

    rows.push({
      progress_updated_at: cells[0],
      status: cells[1],
      progress_last_row: cells[2],
    });
  }

  // Drop a header-looking first row ("Timestamp (UTC) | Status | Progress").
  if (rows.length > 0 && /^timestamp/i.test(rows[0].progress_updated_at ?? "")) {
    rows.shift();
  }

  return rows[rows.length - 1] ?? {};
}
