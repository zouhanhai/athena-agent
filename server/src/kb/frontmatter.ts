/**
 * Shared best-effort YAML-ish frontmatter parser for wiki pages
 * (type / title / topic / created / updated).
 */

/** Parse leading `---` frontmatter into key/value pairs (best-effort). */
export function parseFrontmatter(content: string): Record<string, string> {
  const normalized = content.replace(/\r\n/g, "\n");
  const body = normalized.startsWith("---\n") ? normalized.split("\n---")[0] : undefined;
  if (!body) return {};
  const out: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (key && value) out[key] = value;
  }
  return out;
}
