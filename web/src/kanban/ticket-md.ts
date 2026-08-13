/**
 * Parser for a raw ticket markdown file (docs/kanban/Gx/Sy/Tz.md) pulled from
 * the synced repo, so the GitHub-view local detail panel (G4.S5.T4) can show
 * the md source's rich content (frontmatter, description, Progress Log) next
 * to the GitHub issue discussion — without leaving the Workbench.
 */

export interface TicketFrontmatter {
  [key: string]: string;
}

/** One row of the ticket's `## Progress Log` table. */
export interface ProgressLogRow {
  timestamp: string;
  status: string;
  progress: string;
}

/** The parsed ticket md the detail panel renders. */
export interface ParsedTicket {
  frontmatter: TicketFrontmatter;
  /** The md body without frontmatter and without the Progress Log / Log sections. */
  description: string;
  /** The Progress Log rows (header row dropped), newest first. */
  progressLog: ProgressLogRow[];
}

/** Parse a ticket markdown file into frontmatter + description + Progress Log. */
export function parseTicketMd(md: string): ParsedTicket {
  const frontmatter: TicketFrontmatter = {};
  let body = md;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(md);
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
      if (match) {
        frontmatter[match[1]] = match[2].trim();
      }
    }
    body = md.slice(fm[0].length);
  }

  const progressLog: ProgressLogRow[] = [];
  const log = /^##\s+Progress\s+Log\s*$/m.exec(body);
  if (log) {
    const section = body.slice(log.index + log[0].length);
    const end = /^##\s+[^\n]*$/m.exec(section);
    const table = end ? section.slice(0, end.index) : section;
    for (const line of table.split(/\r?\n/)) {
      const row = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|/.exec(line);
      if (!row) {
        continue;
      }
      const [timestamp, status, progress] = [row[1], row[2], row[3]].map((s) => s.trim());
      if (timestamp && timestamp !== "UTC timestamp" && timestamp !== "---") {
        progressLog.push({ timestamp, status, progress });
      }
    }
  }

  let description = body;
  const end = /^(##\s+(?:Progress\s+Log|Log)\s*)$/m.exec(description);
  if (end) {
    description = description.slice(0, end.index);
  }

  return {
    frontmatter,
    description: description.trim(),
    progressLog,
  };
}
