/**
 * G.S.T board frontmatter — minimal YAML-subset parser/renderer.
 *
 * The board md files carry a leading `---` YAML block with scalar values,
 * inline arrays (`blocked_by: ["t3"]`) and block lists
 * (`acceptance_criteria:\n  - "..."`). This module reads and writes that
 * block without pulling in a full YAML dependency.
 */

/** A single frontmatter value: scalar, or an array of scalars. */
export type FrontmatterValue = string | number | boolean | FrontmatterValue[];

/** Frontmatter as parsed from the `---` block (insertion order preserved). */
export type FrontmatterMap = Record<string, FrontmatterValue>;

/** Parse a scalar token: strip quotes, decode inline arrays, coerce numbers. */
function parseScalar(raw: string): FrontmatterValue {
  const trimmed = raw.trim();
  if (trimmed === "[]") return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((part) => parseScalar(part.trim()));
  }
  if (trimmed.startsWith('"')) {
    const body = trimmed.slice(1);
    return body.slice(0, body.indexOf('"')).replace(/\\"/g, '"');
  }
  if (trimmed.startsWith("'")) {
    const body = trimmed.slice(1);
    return body.slice(0, body.indexOf("'")).replace(/\\'/g, "'");
  }
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/** Parse the inner lines of a `---` block into a FrontmatterMap. */
function parseFrontmatterBody(text: string): FrontmatterMap {
  const out: FrontmatterMap = {};
  let currentKey: string | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && currentKey !== null && Array.isArray(out[currentKey])) {
      (out[currentKey] as FrontmatterValue[]).push(parseScalar(item[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const raw = kv[2].trim();
    currentKey = key;
    out[key] = raw === "" ? [] : parseScalar(raw);
  }
  return out;
}

/** Split a board md string into its frontmatter map and body markdown. */
export function parseBoardMd(content: string): { frontmatter: FrontmatterMap; body: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: {}, body: normalized };
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing === -1) return { frontmatter: {}, body: normalized };
  const frontmatter = parseFrontmatterBody(normalized.slice(4, closing));
  const body = normalized.slice(closing + 5).replace(/^\n/, "");
  return { frontmatter, body };
}

/** Parse the leading `---` frontmatter block of a board md string. */
export function parseFrontmatter(content: string): FrontmatterMap {
  return parseBoardMd(content).frontmatter;
}

/** True when a string can be written bare (no YAML quoting needed). */
function isSimpleScalar(value: string): boolean {
  return value !== "" && /^[A-Za-z0-9_./-]+$/.test(value);
}

/** Render a single value: scalars inline, arrays as block lists. */
function renderValue(value: FrontmatterValue): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `\n${value.map((item) => `  - "${String(item)}"`).join("\n")}`;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return isSimpleScalar(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

/** Render a FrontmatterMap as the inner lines of a `---` block. */
export function renderFrontmatter(frontmatter: Record<string, unknown>): string {
  return Object.entries(frontmatter)
    .map(([key, value]) => {
      if (Array.isArray(value) && value.length > 0) return `${key}:${renderValue(value as FrontmatterValue)}`;
      return `${key}: ${renderValue(value as FrontmatterValue)}`;
    })
    .join("\n");
}

/** Render frontmatter + body into a full board md document. */
export function renderBoardMd(frontmatter: Record<string, unknown>, body: string): string {
  const bodyBlock = body.endsWith("\n") ? body : `${body}\n`;
  return `---\n${renderFrontmatter(frontmatter)}\n---\n\n${bodyBlock}`;
}
