/**
 * Wiki code-page helpers (G4.S8.T11).
 *
 * These utilities drive the per-DocType renderers in WikiView:
 *   - `detectCodeChannel` maps a code page's chunk-metadata SHAPE to its
 *     rendering channel (fields → ddic, sourceTables/members → cds,
 *     dependencies → abap, references → ui5) so the renderer knows which
 *     structured view to draw.
 *   - `codeSlug` / `codeAnchor` are the slug + section-anchor forms shared by
 *     the code store (wiki page file stems) and the renderer id-anchors.
 *   - `resolveCodeLinkTarget` implements the "no dead links" rule: FK cells and
 *     cds chips navigate to `wiki/code/<system>/<TARGET>.md` when that page
 *     exists in the loaded tree, otherwise the caller triggers a wiki search.
 */
import type { WikiCodeMeta } from "@/api/kb";

/** The four code channels the wiki renders. */
export type CodeChannel = "ddic" | "cds" | "abap" | "ui5";

/** Lowercase/slug a technical name exactly like the server `slugify` (the form
 *  used for wiki page FILE stems and the `code/<system>` topic segment). */
export function codeSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Section anchor id for a code object — the lowercase identifier form that
 *  matches the markdown-it-anchor heading ids of the page body (e.g. `## MARA`
 *  → `mara`), so the left-tree heading outline scrolls to the renderer's
 *  section. */
export function codeAnchor(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

/** Detect the renderer channel from the chunk metadata shape. Returns null when
 *  the page has no chunks / no recognizable channel (fall back to markdown). */
export function detectCodeChannel(meta: WikiCodeMeta | null | undefined): CodeChannel | null {
  if (!meta || !Array.isArray(meta.chunks) || meta.chunks.length === 0) return null;
  const probe =
    meta.chunks.find((c) => c.metadata && typeof c.metadata === "object") ?? meta.chunks[0];
  const md = probe?.metadata ?? {};
  if (Array.isArray(md.fields) || "tableName" in md || "groupIndex" in md) return "ddic";
  if (Array.isArray(md.sourceTables) || Array.isArray(md.members)) return "cds";
  if (Array.isArray(md.dependencies) || "modulePath" in md || "objectType" in md) return "abap";
  if (Array.isArray(md.references) || "file" in md || "component" in md) return "ui5";
  return null;
}

/** The candidate page path an FK/chip target would live at (the code store
 *  names the page from the source object's slug, and the page sits under the
 *  slugified system dir). */
export function codePagePathFor(system: string | undefined, target: string): string {
  return `wiki/code/${codeSlug(system ?? "unknown")}/${codeSlug(target)}.md`;
}

/**
 * Resolve a cross-link target (FK table / cds chip) to an existing wiki page:
 * first the exact expected path (`wiki/code/<system>/<target>.md`), then any
 * `wiki/code/**` page whose file stem matches the target (catches a different
 * system dir / de-dup suffix). Returns null when no page exists — the caller
 * then triggers a wiki search for the target (no dead links).
 */
export function resolveCodeLinkTarget(
  pagePaths: readonly string[],
  system: string | undefined,
  target: string,
): string | null {
  const exact = codePagePathFor(system, target);
  const exactHit = pagePaths.find((p) => p.toLowerCase() === exact.toLowerCase());
  if (exactHit) return exactHit;
  const stem = `${codeSlug(target)}.md`;
  const hit = pagePaths.find((p) => {
    const lower = p.toLowerCase();
    if (!lower.startsWith("wiki/code/")) return false;
    const file = lower.split("/").pop() ?? "";
    return file === stem;
  });
  return hit ?? null;
}

/** Decoded action for a cross-link click: navigate to the existing page, else
 *  search for the target (the caller surfaces the search). */
export function resolveCodeLinkAction(
  pagePaths: readonly string[],
  system: string | undefined,
  target: string,
): { kind: "navigate"; path: string } | { kind: "search"; target: string } {
  const path = resolveCodeLinkTarget(pagePaths, system, target);
  return path ? { kind: "navigate", path } : { kind: "search", target };
}