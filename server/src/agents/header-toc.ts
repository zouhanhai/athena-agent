/**
 * G4.S10.T6 — TOC-first header grading.
 *
 * When a document ships a real table of contents, the document's own hierarchy is the
 * ground truth for the refinement header-grading step: it beats LLM re-grading (which is
 * non-deterministic and reconstructs hierarchy worse than the source does). This module
 * provides:
 *
 * 1. `HeaderGradingSource` providers (chained, first hit wins):
 *    - `pdf-outline`          — docling-detected outline / PDF bookmark layer (parsed by
 *                               `DoclingParser` from the `<stem>.outline.json` sidecar).
 *    - `markdown-toc-preamble` — a TOC-shaped bullet/link block at the top of the markdown
 *                               (e.g. the `- [Title](...)` list at the top of SAP exports).
 *    - `external`             — an explicit TOC passed at refine/upload time (e.g. the SAP
 *                               Help Portal `fullToc` fetched by the uploader).
 * 2. Deterministic grading: match the docling heading blocks against the TOC PRE-ORDER
 *    walk (normalizing page numbers / punctuation / parenthesized code suffixes), then map
 *    TOC depth → md level. Default mapping: first section level after the root → h1, each
 *    deeper level +1, clamped at h5 (D4→h1 … D8→h5 for SAP Help Portal deliverables).
 * 3. Fallback: no TOC anywhere → the existing LLM `judgeHeaderLevelsLLM` path unchanged;
 *    a partial TOC (some headings unmatched) keeps the unmatched blocks at their
 *    conservative ORIGINAL levels; a detected-but-zero-match TOC (false positive) also
 *    falls back to the LLM judge, so a stray bullet list can never disable re-leveling.
 *
 * Providers never block the pipeline: a throwing detection is logged, skipped, and the
 * chain moves on (falling back to the LLM judge when nothing yields a usable TOC).
 */
import type { HeaderBlock } from "./refine-output.js";
import { splitByHeaders, rebuildMarkdown } from "./refine-output.js";
import type { JudgeHeaderLevelsResult } from "./refine-document.js";

// --- TOC model ---

/** One node of a heading tree. The synthetic root carries the whole document (level 0). */
export interface TocNode {
  /** Heading text of the TOC entry ("" for the synthetic root). */
  text: string;
  /** Depth in the tree — root = 0, the first section level after the root = 1. */
  level: number;
  /** Deeper TOC entries. */
  children?: TocNode[];
}

/** Everything a provider needs to decide whether a TOC exists for a document. */
export interface HeaderGradingContext {
  /** The docling (refinement-input) markdown. */
  markdown: string;
  /**
   * Docling-exported outline tree (PDF bookmark layer), parsed by `DoclingParser` from the
   * `<stem>.outline.json` sidecar next to the parsed markdown.
   */
  outline?: unknown;
  /** Explicit external TOC passed at refine/upload time (e.g. SAP Help `fullToc`). */
  externalToc?: unknown;
}

/** One TOC detection provider. `name` is reported in `headerGrading.source`. */
export interface HeaderGradingSource {
  name: string;
  /**
   * Detect + parse the TOC for the document. Return null when this source has no TOC.
   * Throwing is tolerated by the chain (logged, next provider tried) — never fails refine.
   */
  detect(ctx: HeaderGradingContext): Promise<TocNode | null> | TocNode | null;
}

/**
 * Parameterized TOC-depth → md-level mapping. Default: the first section level after the
 * root maps to h1, every deeper level +1, clamped at `maxLevel`.
 */
export interface TocDepthMapping {
  /** md heading level for TOC depth 1 (default 1 = h1). */
  baseLevel?: number;
  /** Maximum md heading level — deeper TOC levels clamp here (default 5 = h5). */
  maxLevel?: number;
}

export interface TocFlatEntry {
  text: string;
  /** Structural depth: the synthetic root = 0, its children = 1, … */
  depth: number;
}

/** The header-grading report carried by the refinement report + stored ref. */
export interface HeaderGradingReport {
  /** "toc" = deterministic TOC grading; "llm" = the judgeHeaderLevelsLLM fallback. */
  mode: "toc" | "llm";
  /** The provider name that produced the TOC ("pdf-outline" | "markdown-toc-preamble" | "external"). */
  source?: string;
  /** TOC-mode only: md headings successfully matched to TOC nodes. */
  tocMatched?: number;
  /** TOC-mode only: TOC nodes in the flattened pre-order walk. */
  tocTotal?: number;
}

// --- input parsing (docling outline sidecar / external TOC) ---

function entryText(entry: Record<string, unknown> | string): string {
  if (typeof entry === "string") return entry;
  for (const key of ["title", "text", "name"] as const) {
    const v = entry[key];
    if (typeof v === "string") return v;
  }
  return "";
}

function entryChildren(entry: Record<string, unknown> | string): unknown {
  if (typeof entry === "string") return undefined;
  return entry.children;
}

/**
 * Normalize ANY reasonable TOC input into a `TocNode` tree (or null). Accepted shapes:
 * - a JSON string (docling `<stem>.outline.json` content, SAP fullToc fetched over HTTP)
 * - a flat array of strings or {title|text|name} entries
 * - nested {title|text|name, children} entries (the SAP Help `fullToc` shape)
 * - a wrapper object {toc|tree|items|children: [...]}
 * - a single node {title|text|name, children} (used as the root itself)
 * Levels are structural (root = 0, first section level = 1); explicit `level` fields are
 * ignored so a malformed level field can never skew the pre-order walk. Returns null for
 * anything unusable — a provider then reports "no TOC" and the LLM path is used.
 */
export function parseTocInput(input: unknown): TocNode | null {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return { text: "", level: 0, children: buildChildren(value) };
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["toc", "tree", "items"] as const) {
      if (Array.isArray(obj[key])) {
        const children = buildChildren(obj[key] as unknown[]);
        return children.length > 0 ? { text: "", level: 0, children } : null;
      }
    }
    if (Array.isArray(obj.children)) {
      const children = buildChildren(obj.children as unknown[]);
      if (children.length > 0) {
        const own = entryText(obj);
        return own
          ? { text: own, level: 0, children }
          : { text: "", level: 0, children };
      }
      return null;
    }
    if (obj.title !== undefined || obj.text !== undefined || obj.name !== undefined) {
      // a single TOC node used as the root — a malformed (non-array) children field is unusable
      if (obj.children !== undefined && !Array.isArray(obj.children)) return null;
      return { text: entryText(obj), level: 0 };
    }
  }
  return null;
}

function buildChildren(entries: unknown[], depth = 1): TocNode[] {
  const out: TocNode[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      if (entry.trim()) out.push({ text: entry.trim(), level: depth });
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const text = entryText(obj).trim();
    if (!text) continue;
    const rawChildren = entryChildren(obj);
    const children = Array.isArray(rawChildren) ? buildChildren(rawChildren as unknown[], depth + 1) : undefined;
    out.push({ text, level: depth, ...(children && children.length > 0 ? { children } : {}) });
  }
  return out;
}

// --- matching normalization ---

/**
 * Normalize a heading/TOC text into the equality key used by the pre-order matcher.
 * Removes page numbers (", 12"), trailing parenthesized code suffixes ("(...)" groups),
 * leading section numbering ("1.2.3 "), markdown emphasis/code markers, punctuation and
 * whitespace, case-folded. Both sides (TOC node + md heading) go through the SAME
 * normalization, so punctuation/case differences can never hide a match.
 */
export function normalizeHeadingText(text: string): string {
  let value = text.trim();
  value = value.replace(/^[#*\s]+/, "");
  value = value.replace(/[*_`~]/g, "");
  // trailing parenthesized group — "(ABAP)", "(2023)", "(Deprecated)" style suffixes
  value = value.replace(/\s*\(\s*[\p{L}\p{N}_-]+\s*\)\s*$/u, "");
  // trailing page numbers: "Title, 12" / "Title 12" / "Title, p. 7"
  value = value.replace(/[\s,.\-–—:;]*(?:p\.?\s*)?\d+\s*$/, "");
  // leading section numbering: "1.2.3 Title" / "7 Subchapter"
  value = value.replace(/^\d+(\.\d+)*\s*/, "");
  value = value.toLowerCase();
  return value.replace(/[^\p{L}\p{N}]+/gu, "");
}

// --- pre-order walk + depth mapping ---

/** Flatten a TOC tree into its PRE-ORDER walk of heading entries (root excluded). */
export function flattenTocPreOrder(tree: TocNode): TocFlatEntry[] {
  const out: TocFlatEntry[] = [];
  const walk = (node: TocNode, depth: number): void => {
    const text = (node.text ?? "").trim();
    if (depth > 0 && text) out.push({ text, depth });
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  walk(tree, 0);
  return out;
}

/** TOC depth → md heading level with the parameterized base/max mapping. */
export function tocDepthToMdLevel(depth: number, mapping: TocDepthMapping = {}): number {
  const base = mapping.baseLevel ?? 1;
  const max = mapping.maxLevel ?? 5;
  return Math.min(Math.max(base + depth - 1, 1), Math.max(max, 1));
}

export interface TocGradingResult {
  /** The blocks with matched headings re-leveled; unmatched keep their ORIGINAL levels. */
  blocks: HeaderBlock[];
  /** Md headings matched to TOC nodes (pre-order walk, forward cursor). */
  matched: number;
  /** TOC nodes in the flattened pre-order walk. */
  total: number;
}

/**
 * Deterministic grading: match md heading blocks against the TOC pre-order walk and assign
 * each matched block the level `tocDepthToMdLevel(depth of its TOC node)`. The cursor only
 * moves FORWARD, so duplicate TOC titles bind to their document-order occurrences. Blocks
 * that match no TOC node keep their conservative ORIGINAL level (never worse, no LLM).
 */
export function gradeHeadersFromToc(blocks: HeaderBlock[], tree: TocNode, mapping: TocDepthMapping = {}): TocGradingResult {
  const flat = flattenTocPreOrder(tree);
  const normalized = flat.map((entry) => normalizeHeadingText(entry.text));
  let cursor = 0;
  let matched = 0;
  const graded = blocks.map((block) => {
    const key = normalizeHeadingText(block.text);
    for (let i = cursor; i < normalized.length; i++) {
      if (normalized[i] === key) {
        cursor = i + 1;
        matched += 1;
        return { ...block, level: tocDepthToMdLevel(flat[i]!.depth, mapping) };
      }
    }
    return block;
  });
  return { blocks: graded, matched, total: flat.length };
}

// --- providers ---

/** Provider: the docling-detected outline / PDF bookmark layer (ctx.outline). */
export function createDoclingOutlineSource(): HeaderGradingSource {
  return {
    name: "pdf-outline",
    detect(ctx: HeaderGradingContext): TocNode | null {
      return ctx.outline === undefined || ctx.outline === null ? null : parseTocInput(ctx.outline);
    },
  };
}

export interface MarkdownTocPreambleOptions {
  /** Smallest list run that counts as a TOC block (default 3). */
  minEntries?: number;
  /** Require entries to be markdown links `[Title](…)` (default true).
   *  False allows plain `- Title` lists (header-graded by the same heuristic). */
  requireLinks?: boolean;
  /** Scan window: how many leading lines to examine (default 300). */
  maxLines?: number;
}

const TOC_BULLET = /^(\s*)[-*+]\s+(.+?)\s*$/;
const TOC_LINK = /^\[([^\]]+)\]\([^)]*\)\s*$/;

/**
 * Provider: an explicit TOC-shaped block in the markdown preamble — a contiguous run of
 * bullet entries (default: link form `- [Title](…)`, ≥`minEntries`), indentation encodes
 * the level (2 spaces per level). Scan window covers the top of the document (also after a
 * "Table of Contents" heading). Heuristic + configurable; the zero-match guard in
 * `tocFirstJudge` protects against false positives.
 */
export function createMarkdownTocPreambleSource(options: MarkdownTocPreambleOptions = {}): HeaderGradingSource {
  const minEntries = options.minEntries ?? 3;
  const requireLinks = options.requireLinks ?? true;
  const maxLines = options.maxLines ?? 300;
  return {
    name: "markdown-toc-preamble",
    detect(ctx: HeaderGradingContext): TocNode | null {
      const lines = ctx.markdown.split(/\r?\n/).slice(0, maxLines);
      let inFence = false;
      let run: Array<{ text: string; indent: number }> = [];
      for (const line of lines) {
        if (/^\s*(```|~~~)/.test(line)) {
          inFence = !inFence;
          run = [];
          continue;
        }
        if (inFence) continue;
        const bullet = TOC_BULLET.exec(line);
        if (!bullet) {
          // the run ended — a qualifying run is complete once it has ≥minEntries entries
          if (run.length >= minEntries) break;
          run = [];
          continue;
        }
        let text = bullet[2]!.trim();
        const link = TOC_LINK.exec(text);
        if (link) {
          text = link[1]!.trim();
        } else if (requireLinks) {
          run = [];
          continue;
        }
        if (!text) {
          run = [];
          continue;
        }
        run.push({ text, indent: bullet[1]!.replace(/\t/g, "  ").length });
      }
      if (run.length < minEntries) return null;
      // build a NESTED tree from the indentation (2 spaces per level), so structural
      // depth — which the pre-order walk + depth→level mapping use — carries the levels
      const root: TocNode = { text: "", level: 0, children: [] };
      const stack: Array<{ indent: number; node: TocNode }> = [{ indent: -1, node: root }];
      for (const { text, indent } of run) {
        while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
        const parent = stack[stack.length - 1]!.node;
        const node: TocNode = { text, level: parent.level + 1, children: [] };
        parent.children!.push(node);
        stack.push({ indent, node });
      }
      return root;
    },
  };
}

/** Provider: an explicit external TOC passed at refine/upload time (ctx.externalToc). */
export function createExternalTocSource(): HeaderGradingSource {
  return {
    name: "external",
    detect(ctx: HeaderGradingContext): TocNode | null {
      return ctx.externalToc === undefined || ctx.externalToc === null
        ? null
        : parseTocInput(ctx.externalToc);
    },
  };
}

/** The default provider chain (order: docling artifacts → document → explicit input). */
export const DEFAULT_HEADER_GRADING_SOURCES: HeaderGradingSource[] = [
  createDoclingOutlineSource(),
  createMarkdownTocPreambleSource(),
  createExternalTocSource(),
];

// --- chaining + the composed judge + the single-pass helper ---

export interface DetectedToc {
  tree: TocNode;
  source: HeaderGradingSource;
}

/**
 * Try the providers in order; the first one returning a non-empty tree wins. A throwing
 * provider is logged + skipped — the chain NEVER blocks refinement. Returns null when no
 * provider yields a tree.
 */
export async function detectTocTree(ctx: HeaderGradingContext, sources: HeaderGradingSource[]): Promise<DetectedToc | null> {
  for (const source of sources) {
    try {
      const tree = await source.detect(ctx);
      if (tree && flattenTocPreOrder(tree).length > 0) {
        return { tree, source };
      }
    } catch (err) {
      console.warn(
        `[header-toc] provider "${source.name}" failed (${err instanceof Error ? err.message : String(err)}) — trying the next source`,
      );
    }
  }
  return null;
}

export interface GradedToc extends DetectedToc {
  graded: TocGradingResult;
}

/**
 * The chain the pipeline actually uses: the FIRST detected tree whose grading matches ≥1
 * heading. A detected-but-zero-match TOC (e.g. a stray link list) is treated as "no TOC"
 * and the next provider is tried — a false positive can never shadow a real TOC, nor
 * disable the LLM fallback.
 */
export async function firstGradedToc(
  blocks: HeaderBlock[],
  ctx: HeaderGradingContext,
  sources: HeaderGradingSource[],
  mapping: TocDepthMapping = {},
): Promise<GradedToc | null> {
  for (const source of sources) {
    let tree: TocNode | null;
    try {
      tree = await source.detect(ctx);
    } catch (err) {
      console.warn(
        `[header-toc] provider "${source.name}" failed (${err instanceof Error ? err.message : String(err)}) — trying the next source`,
      );
      continue;
    }
    if (!tree) continue;
    const graded = gradeHeadersFromToc(blocks, tree, mapping);
    if (graded.total === 0 || graded.matched === 0) continue;
    return { tree, source, graded };
  }
  return null;
}

export interface TocFirstJudgeConfig {
  /** Provider chain. Default: DEFAULT_HEADER_GRADING_SOURCES. */
  sources?: HeaderGradingSource[];
  /** TOC-depth → md-level mapping (default D4→h1 … D8→h5). */
  depthMapping?: TocDepthMapping;
  /** The LLM judge invoked when no usable TOC exists. */
  fallback: (blocks: HeaderBlock[]) => Promise<JudgeHeaderLevelsResult>;
}

/**
 * The composed stage-1 header judge: TOC-first, LLM fallback.
 * - A detected TOC that grades ≥1 heading → deterministic grading (mode "toc").
 * - No TOC (nothing detected, empty trees, or detected-but-zero-match trees) → the LLM
 *   fallback with mode "llm" — the pre-T6 behavior, unchanged. Providers never block.
 */
export async function tocFirstJudge(
  blocks: HeaderBlock[],
  ctx: HeaderGradingContext,
  config: TocFirstJudgeConfig,
): Promise<JudgeHeaderLevelsResult> {
  const found = await firstGradedToc(blocks, ctx, config.sources ?? DEFAULT_HEADER_GRADING_SOURCES, config.depthMapping);
  if (found) {
    const { graded, source } = found;
    return {
      blocks: graded.blocks,
      batches: 0,
      failedBatches: 0,
      headerMode: "toc",
      tocSource: source.name,
      tocMatched: graded.matched,
      tocTotal: graded.total,
    };
  }
  const llm = await config.fallback(blocks);
  return { ...llm, headerMode: "llm" };
}

export interface ApplyTocResult {
  markdown: string;
  matched: number;
  total: number;
}

/**
 * Re-level an already-refined markdown against a TOC tree (single-pass post-pass): split by
 * headers, grade from the TOC pre-order, rebuild. Unmatched blocks keep their current
 * levels; the preamble (incl. the TOC list itself) is preserved.
 */
export function applyTocToMarkdown(markdown: string, tree: TocNode, mapping: TocDepthMapping = {}): ApplyTocResult {
  const { preamble, blocks } = splitByHeaders(markdown);
  const graded = gradeHeadersFromToc(blocks, tree, mapping);
  return {
    markdown: rebuildMarkdown(preamble, graded.blocks),
    matched: graded.matched,
    total: graded.total,
  };
}