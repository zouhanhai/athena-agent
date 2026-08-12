/**
 * Minimal line-based wiki diff (G4.S3.T10).
 *
 * The Save flow snapshots the wiki page BEFORE and AFTER the user's edit and
 * computes a minimal diff so Athena's incremental refine knows EXACTLY what
 * changed (it must never re-read the whole document from docling). The diff is
 * pure scratch data for the refine — it is never stored.
 *
 * `computeWikiDiff` returns:
 *  - `hunks`: the changed regions (removed lines + added lines per region).
 *  - `unified`: a unified-diff-style text (for the Athena prompt).
 *  - `structural`: true when the change touches heading structure (a line
 *    matching `^#{1,6}\s+`), which forces a re-chunk decision.
 */

const HEADING_RE = /^#{1,6}\s+/;

export interface WikiDiffHunk {
  /** 1-based start line in the BEFORE text of the removed block. */
  beforeStart: number;
  /** 1-based start line in the AFTER text of the added block. */
  afterStart: number;
  /** Lines removed (from the before text). */
  beforeLines: string[];
  /** Lines added (from the after text). */
  afterLines: string[];
}

export interface WikiDiff {
  changed: boolean;
  hunks: WikiDiffHunk[];
  /** Unified-diff-style text of the changed regions (scratch input for Athena). */
  unified: string;
  /** True when a changed line is a markdown heading (forces a re-chunk decision). */
  structural: boolean;
}

function isHeading(line: string): boolean {
  return HEADING_RE.test(line);
}

/** The largest LCS matrix we build; beyond this the middle is one replacement. */
const LCS_CELL_LIMIT = 2_000_000;

type Op =
  | { type: "keep"; line: string }
  | { type: "del"; line: string }
  | { type: "add"; line: string };

/** LCS-based edit operations over the (already trimmed) middle region. */
function editOps(a: string[], b: string[]): Op[] {
  if (a.length * b.length > LCS_CELL_LIMIT) {
    // Oversized middle: one replacement hunk (remove all, add all).
    return [
      ...a.map((line): Op => ({ type: "del", line })),
      ...b.map((line): Op => ({ type: "add", line })),
    ];
  }
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] =
        a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "keep", line: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: "del", line: a[i]! });
      i += 1;
    } else {
      ops.push({ type: "add", line: b[j]! });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: "del", line: a[i]! });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: "add", line: b[j]! });
    j += 1;
  }
  return ops;
}

/** Render the changed hunks as unified-diff-style text for the Athena prompt. */
function renderUnified(hunks: WikiDiffHunk[]): string {
  return hunks
    .map((h) => {
      const header = `@@ -${h.beforeStart},${h.beforeLines.length} +${h.afterStart},${h.afterLines.length} @@`;
      return [
        header,
        ...h.beforeLines.map((line) => `-${line}`),
        ...h.afterLines.map((line) => `+${line}`),
      ].join("\n");
    })
    .join("\n");
}

/**
 * Compute the minimal diff between the before and after text of a wiki page.
 * Both texts are expected to be the page BODY (frontmatter stripped, image refs
 * already removed via the ragMarkdown form) so the diff reflects the user's
 * semantic correction only.
 */
export function computeWikiDiff(before: string, after: string): WikiDiff {
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");

  if (a.length === b.length && a.every((line, i) => line === b[i])) {
    return { changed: false, hunks: [], unified: "", structural: false };
  }

  // Trim the common prefix/suffix so the LCS runs over only the changed middle.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const ops = editOps(a.slice(start, endA), b.slice(start, endB));

  const hunks: WikiDiffHunk[] = [];
  let aPos = start; // next 1-based line number in the before text
  let bPos = start; // next 1-based line number in the after text
  let current: WikiDiffHunk | null = null;
  for (const op of ops) {
    if (op.type === "keep") {
      if (current) {
        hunks.push(current);
        current = null;
      }
      aPos += 1;
      bPos += 1;
      continue;
    }
    if (!current) {
      current = { beforeStart: aPos + 1, afterStart: bPos + 1, beforeLines: [], afterLines: [] };
    }
    if (op.type === "del") {
      current.beforeLines.push(op.line);
      aPos += 1;
    } else {
      current.afterLines.push(op.line);
      bPos += 1;
    }
  }
  if (current) hunks.push(current);

  return {
    changed: true,
    hunks,
    unified: renderUnified(hunks),
    structural: hunks.some((h) => h.beforeLines.some(isHeading) || h.afterLines.some(isHeading)),
  };
}
