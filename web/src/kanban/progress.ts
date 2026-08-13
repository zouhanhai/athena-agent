/**
 * Kanban card progress display helpers (G4.S4.T2).
 *
 * Each ticket's last Progress Log row (written by the worker plugin, parsed on
 * the server) carries a real wall-clock UTC timestamp. `updatedAgoText` renders
 * it as "updated Xs ago" on the web board. `isStalled` flags a ticket as STALLED
 * when it is in_progress yet its last row is old (> ~3 min) — an OBSERVATION
 * only, derived from the Progress Log timestamp, never written back to the
 * ticket frontmatter.
 */

/** Format an elapsed delta as "Xs ago" / "Xm ago" / "Xh ago" / "Xd ago". */
export function formatAgo(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** "updated Xs ago" from a Progress Log UTC timestamp; "" when absent/unparseable. */
export function updatedAgoText(updatedAt: string | undefined, now = Date.now()): string {
  if (!updatedAt) return "";
  const ts = Date.parse(updatedAt);
  if (Number.isNaN(ts)) return "";
  return `updated ${formatAgo(now - ts)}`;
}

/** Default stall window: > ~3 minutes since the last Progress Log row. */
export const DEFAULT_STALL_MS = 3 * 60_000;

/**
 * Stalled is an OBSERVATION flag: an in_progress ticket whose last Progress Log
 * row timestamp is older than `stallMs` (~3 min default). Non-in_progress
 * tickets are never stalled. Does NOT modify the ticket frontmatter.
 *
 * app-tier only (G7 local desktop app); the web tier reads remote GitHub md
 * which lacks the local Progress Log, so stalled is not shown there.
 */
export function isStalled(
  status: string,
  updatedAt: string | undefined,
  now = Date.now(),
  stallMs = DEFAULT_STALL_MS,
): boolean {
  if (status !== "in_progress") return false;
  if (!updatedAt) return false;
  const ts = Date.parse(updatedAt);
  if (Number.isNaN(ts)) return false;
  return now - ts > stallMs;
}
