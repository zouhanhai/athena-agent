/**
 * Shared best-effort YAML-ish frontmatter parser for wiki pages
 * (type / title / topic / created / updated / code lineage).
 *
 * G4.S8.T11: code pages carry TWO consecutive frontmatter blocks — the outer
 * `withFrontmatter` envelope (type/title/topic/created) plus the embedded code
 * frontmatter (type/topic/system/devclass/transport/component) written by the
 * code-store façades. `parseFrontmatter` therefore parses EVERY leading `---`
 * block and MERGES them (later blocks win), so `system`/`devclass`/`transport`
 * reach `listWikiPages` and the code-meta API. Pages with a single block are
 * unaffected.
 */

/** Parse leading `---` frontmatter into key/value pairs (best-effort). */
export function parseFrontmatter(content: string): Record<string, string> {
  const normalized = content.replace(/\r\n/g, "\n");
  let rest = normalized;
  const out: Record<string, string> = {};
  // Guard: a page could naively stack many blocks — cap the merge depth.
  for (let block = 0; block < 8; block += 1) {
    if (!rest.startsWith("---\n")) break;
    const closing = rest.indexOf("\n---");
    if (closing === -1) break;
    const body = rest.slice(0, closing);
    for (const line of body.split("\n")) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      if (key && value) out[key] = value;
    }
    let after = rest.slice(closing + "\n---".length);
    if (after.startsWith("\n")) after = after.slice(1);
    rest = after;
  }
  return out;
}
