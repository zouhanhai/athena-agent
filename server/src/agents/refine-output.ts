/**
 * Big-output handling + two-stage refinement helpers for Athena (G4.S1.T3).
 *
 * pi-docparser pattern: the FULL re-leveled markdown + chunks land on disk/storage; `refine_document`
 * only returns the SMALL metadata (frontmatter/entities/keywords/quality + md_ref/preview) into context.
 *
 * Two-stage refinement for >1MB docs (G4.S1 Spec, decided 2026-08-09):
 *   Stage 1 — header re-level (LOCAL): judge each header's semantic level from the header text + a few
 *             following paragraphs, batched ~30-50 headers (tens of KB/batch, NOT the full doc).
 *   Stage 2 — split by the REFINED h1 boundary into semantically-complete sections (<1MB each), then
 *             per section: chunk + entity + keyword + type/topic.
 * Sub-1MB docs skip the split and do a single full-doc pass.
 *
 * Chunked refinement loses cross-section entity/relation correlation — single-read is preferred sub-1MB.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  RefinementChunk,
  RefinementEntity,
  RefinementFrontmatter,
  RefinementPatch,
  RefinementQuality,
  RefinementRelation,
  RefinementSectionSummary,
  RefinedDocument,
} from "./refine-document.js";

/** Conservative single-read cap (Spec: ~500KB-1MB md; >1MB must chunk). Measured: 827pg SAP = 2.17MB. */
export const REFINE_SINGLE_READ_MAX_BYTES = 1024 * 1024;

/** Header re-level batch size (~30-50 headers per LLM call, tens of KB/batch). */
export const HEADER_RELEVEL_BATCH_SIZE = 40;

/** Target max size of one two-stage section (<1MB each, fits context with output inflation). */
export const SECTION_MAX_BYTES = 1024 * 1024;

/** Default preview size (chars) returned by the big-output ref. */
export const REFINE_PREVIEW_MAX_CHARS = 2000;

/**
 * Target size of one local paragraph-semantic chunk. (G4.S8.T1) The local chunker keeps each semantic
 * block (paragraph) integral; this is the intended chunk scale.
 */
export const REFINE_CHUNK_TARGET_TOKENS = 1200;

/**
 * Minimum size of one paragraph-semantic chunk (G4.S8.T16): consecutive non-heading blocks sharing a
 * heading path are merged until a chunk reaches this many characters — kills the "WER"-style sub-10-char
 * fragments docling emits. Env-tunable via REFINE_MIN_CHUNK_CHARS; oversized blocks stay intact and the
 * final block of a section may stay below the minimum.
 */
export const REFINE_MIN_CHUNK_CHARS = 400;

/** Read the effective minimum chunk size (env REFINE_MIN_CHUNK_CHARS overrides the 400 default). */
export function refineMinChunkChars(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.REFINE_MIN_CHUNK_CHARS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : REFINE_MIN_CHUNK_CHARS;
}

export type RefinementMode = "single" | "two-stage";

/** A markdown block that starts at a heading line (used by the stage-1 header judge). */
export interface HeaderBlock {
  /** Position (0-based) among heading blocks — the stable id the judge reports levels for. */
  index: number;
  /** Original heading level (1-6) as parsed from the '#' prefix. */
  level: number;
  /** Heading text without the '# ' markers. */
  text: string;
  /** The raw heading line, e.g. "## Workshops". */
  heading: string;
  /** Content after the heading until the next heading (or end of doc), trimmed. */
  body: string;
}

export interface HeaderBlocksResult {
  /** Content before the first heading (kept when rebuilding). */
  preamble: string;
  /** One block per heading line, in order. */
  blocks: HeaderBlock[];
}

/** A semantically-complete section of a re-leveled markdown (split at refined h1 boundaries). */
export interface MarkdownSection {
  /** Heading text of the section's leading heading ("" for a preamble section). */
  heading_path: string;
  markdown: string;
}

/**
 * The small metadata returned into context (pi-docparser big-output pattern): the full re-leveled
 * markdown + chunks are on disk at md_ref/chunks_ref; only a short preview is returned here.
 */
export interface RefineOutputRef {
  /** Absolute path of the full re-leveled markdown on disk. */
  md_ref: string;
  /**
   * Absolute path of the RAG working copy (File B — refined markdown WITHOUT image
   * refs). Equal to `md_ref` when the source had no image refs to strip. File B is
   * a working copy deleted once RAG ingestion is done; `md_ref` (File A′) is the
   * durable artifact (refined headers + image refs) consumed by llm_wiki.
   */
  rag_md_ref?: string;
  /** Absolute path of the chunks JSON on disk. */
  chunks_ref: string;
  /** Short preview of the re-leveled markdown — NOT the full document. */
  preview: string;
  char_count: number;
  line_count: number;
  header_count: number;
  chunk_count: number;
  frontmatter: RefinementFrontmatter;
  entities: RefinementEntity[];
  relations: RefinementRelation[];
  keywords: string[];
  quality: RefinementQuality;
  /**
   * G4.S8.T17: the structured per-issue review list (mirror of quality.json)
   * carried on the small ref so the operator UX (Uploads issue details) shows
   * message + heading path without re-reading the big outputs. Absent when
   * the quality view has no issues.
   */
  refinement_issues?: RefinementQualityIssue[];
  /** File-level document summary (~2-3 sentences), emitted by the single full-doc read. */
  summary: string;
  /** One summary per top-level H1 section — the layered/hierarchical summary (G4.S2.T13). */
  sections: RefinementSectionSummary[];
  /** Which refinement path produced the output: "single" (sub-1MB) or "two-stage" (>1MB). */
  mode: RefinementMode;
  /** h1 section heading paths produced by the two-stage split (two-stage mode only). */
  section_paths: string[];
  /**
   * G4.S10.T1 LINK stage output: cross-document edges decided against the
   * EXISTING graph (endpoints validated ∈ candidates∪existing, evidence
   * ≤80 chars). Flows into the Neo4j store with the rest of the ref.
   */
  link_edges?: Array<{
    source: string;
    target: string;
    relation: string;
    evidence_quote: string;
  }>;
}

export interface StoreRefinementOptions {
  /** Storage sub-directory name. Default: derived from the first h1 heading. */
  stem?: string;
  mode?: RefinementMode;
  /** h1 section heading paths produced by the two-stage split (two-stage mode only). */
  section_paths?: string[];
  /**
   * RAG working copy (File B — refined markdown without image refs). Written to
   * `rag.md` only when it differs from the durable doc.markdown (File A′); the ref's
   * `rag_md_ref` falls back to `md_ref` when no separate copy is needed.
   */
  ragMarkdown?: string;
  /** Injectable mkdir for tests. */
  mkdir?: (path: string) => Promise<void>;
  /** Injectable writeFile for tests. */
  writeFile?: (path: string, content: string) => Promise<void>;
}

/**
 * One structured review issue persisted in `<refinement dir>/quality.json` (G4.S8.T17).
 * Anchored issues carry the verbatim quote (+ the enclosing heading path derived at
 * store time) so WikiView can highlight them in place; `resolved` is the per-issue
 * user workflow state flipped by POST /api/kb/wiki/review-state.
 */
export interface RefinementQualityIssue {
  id: string;
  message: string;
  anchor?: { quote: string; heading_path?: string };
  resolved: boolean;
  /** "action" = operator must confirm; "info" = informative note on an
   *  auto-accepted document. Derived from the gate action at write time. */
  kind?: "info" | "action";
}

/** Whitespace-normalize text so anchor quotes match across line wraps (T16 validation semantics). */
function normalizeWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Locate a quote (whitespace-normalized) in the markdown and return its enclosing
 * heading path ("H1 / H2 / H3"). Undefined when the quote is absent — e.g. an
 * anchor that failed validation and degraded to an unanchored issue.
 */
export function headingPathForQuote(markdown: string, quote: string): string | undefined {
  const needle = normalizeWs(quote);
  if (!needle) return undefined;
  const stack: Array<{ level: number; text: string }> = [];
  let buffer = "";
  const bufferMatches = (): boolean =>
    stack.length > 0 && normalizeWs(buffer).includes(needle);
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      if (bufferMatches()) return stack.map((s) => s.text).join(" / ");
      const level = heading[1]!.length;
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, text: normalizeWs(heading[2]!) });
      buffer = "";
    } else {
      buffer += `${line}\n`;
    }
  }
  return bufferMatches() ? stack.map((s) => s.text).join(" / ") : undefined;
}

/**
 * Derive the structured, per-issue review list (G4.S8.T17) from the refinement
 * quality view: anchored issues first (each with its verbatim quote + derived
 * heading path), then the plain issues. All start unresolved.
 */
export function deriveQualityIssues(
  quality: RefinementQuality,
  markdown: string,
): RefinementQualityIssue[] {
  const issues: RefinementQualityIssue[] = [];
  // auto-accept still emits informative notes; review_required issues are
  // real confirmations. Group them so the UI can show notes separately.
  const kind: "info" | "action" = quality.action === "review_required" ? "action" : "info";
  let n = 0;
  for (const anchor of quality.issue_anchors ?? []) {
    if (!anchor.message.trim() && !anchor.quote.trim()) continue;
    const headingPath = anchor.quote.trim() ? headingPathForQuote(markdown, anchor.quote) : undefined;
    issues.push({
      id: `qi-${++n}`,
      message: anchor.message.trim() || normalizeWs(anchor.quote).slice(0, 140),
      ...(anchor.quote.trim()
        ? { anchor: { quote: anchor.quote, ...(headingPath ? { heading_path: headingPath } : {}) } }
        : {}),
      resolved: false,
      kind,
    });
  }
  for (const message of quality.issues) {
    if (!message.trim()) continue;
    issues.push({ id: `qi-${++n}`, message, resolved: false, kind });
  }
  return issues;
}

/**
 * Number of structured review issues the quality view yields (G4.S8.T17) —
 * the ingest stamps this as the page's initial `review_count`.
 */
export function countQualityIssues(quality: RefinementQuality): number {
  const anchors = (quality.issue_anchors ?? []).filter(
    (a) => a.message.trim() || a.quote.trim(),
  ).length;
  const plain = quality.issues.filter((m) => m.trim()).length;
  return anchors + plain;
}

/** Clamp a heading level to the valid 1-6 range. */
export function clampHeaderLevel(level: number): number {
  if (Number.isFinite(level)) return Math.min(6, Math.max(1, Math.round(level)));
  return 2;
}

// --- image-ref handling (G4.S1.T6) ---
//
// docling emits image references like `![Image](images/image_1.jpeg)` purely so the
// final llm_wiki view can render images alongside text. The refinement LLM does NOT
// need them — only the following VLM text descriptions. Strip the reference lines
// for the refinement prompt (File B: refine + RAG) and keep the full markdown (File A:
// llm_wiki display). After refinement the corrected header levels are synced back onto
// File A, keeping its image refs, to produce the durable File A′.

/** A markdown image-reference line: `![Image](images/...)` on its own line. */
const IMAGE_REF_LINE = /^\s*!\[[^\]]*\]\([^)]*\)\s*$/;

/** A markdown image reference anywhere (inline form, `![alt](url)`). */
const IMAGE_REF_INLINE = /!\[[^\]]*\]\([^)]*\)/g;

/** True when the markdown contains at least one `![...](...)` image reference. */
export function hasImageRefs(markdown: string): boolean {
  // /g regex .test() is stateful — reset so repeated calls never resume a stale scan position.
  IMAGE_REF_INLINE.lastIndex = 0;
  const found = IMAGE_REF_INLINE.test(markdown);
  IMAGE_REF_INLINE.lastIndex = 0;
  return found;
}

/**
 * Strip image-reference lines (and inline refs) from markdown, KEEPING the text that
 * follows them (docling VLM descriptions like "The image displays a bright sky...").
 * Used to build File B — the text-only input for Athena refinement + RAG. A document
 * without image refs is returned unchanged.
 */
export function stripImageRefs(markdown: string): string {
  // G4.S8.T16: HTML-comment image placeholders (`<!-- image -->`) are removed too — they used to
  // survive into File B where the refinement LLM saw them and misreported "undescribed images".
  const noComments = markdown.replace(/<!--[\s\S]*?-->/g, "");
  const lines = noComments.split(/\r?\n/).map((line) => {
    if (IMAGE_REF_LINE.test(line)) return "";
    // NOTE: IMAGE_REF_INLINE is /g — reset lastIndex so .test() never resumes a stale scan position.
    IMAGE_REF_INLINE.lastIndex = 0;
    if (!IMAGE_REF_INLINE.test(line)) return line;
    return line.replace(IMAGE_REF_INLINE, "").trim();
  });
  // collapse runs of blank lines left behind by removed image refs (max 1 blank line)
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Sync the refined header re-level back onto the SOURCE markdown (File A), keeping its
 * image refs + VLM descriptions untouched → File A′ (refined headers + images) for
 * llm_wiki. Aligns headings by order and text; a heading that cannot be matched keeps
 * its original level. Returns the source unchanged when it has no headings or the
 * refined markdown has none.
 */
export function syncRefinedHeadersToSource(sourceMarkdown: string, refinedMarkdown: string): string {
  const sourceHeadings = headingLines(sourceMarkdown);
  const refinedHeadings = headingLines(refinedMarkdown);
  if (sourceHeadings.length === 0 || refinedHeadings.length === 0) return sourceMarkdown;

  const normalized = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.,:;!?]+$/g, "");
  const refinedByText = new Map<string, number>();
  for (const h of refinedHeadings) {
    refinedByText.set(normalized(h.text), h.level);
  }

  const correctedLevels = new Map<number, number>();
  for (let i = 0; i < sourceHeadings.length; i++) {
    const source = sourceHeadings[i];
    const refined = refinedHeadings[i];
    const key = normalized(source.text);
    const byText = refinedByText.get(key);
    if (refined && normalized(refined.text) === key) {
      correctedLevels.set(i, refined.level);
    } else if (byText !== undefined) {
      correctedLevels.set(i, byText);
    }
  }

  const lines = sourceMarkdown.split(/\r?\n/);
  let headingIdx = 0;
  return lines
    .map((line) => {
      const m = /^(#{1,6})(\s+.*)$/.exec(line);
      if (!m) return line;
      const level = correctedLevels.get(headingIdx);
      headingIdx += 1;
      return level === undefined ? line : `${"#".repeat(clampHeaderLevel(level))}${m[2]}`;
    })
    .join("\n");
}

interface HeadingLine {
  level: number;
  text: string;
}

/** In-order headings (level + text) of a markdown document. */
function headingLines(markdown: string): HeadingLine[] {
  const out: HeadingLine[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2].trim() });
  }
  return out;
}

/** Route a document by size: >1MB → two-stage; sub-1MB → single full-doc pass. */
export function isLargeMarkdown(markdown: string, thresholdBytes = REFINE_SINGLE_READ_MAX_BYTES): boolean {
  return Buffer.byteLength(markdown, "utf8") > thresholdBytes;
}

/** Split markdown into a preamble + one block per heading line (stage-1 input). */
export function splitByHeaders(markdown: string): HeaderBlocksResult {
  const lines = markdown.split(/\r?\n/);
  const preambleLines: string[] = [];
  const blocks: Array<Omit<HeaderBlock, "index">> = [];
  let current: { level: number; text: string; heading: string; lines: string[] } | null = null;
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      if (current) {
        blocks.push({ level: current.level, text: current.text, heading: current.heading, body: current.lines.join("\n").trim() });
      }
      current = { level: m[1].length, text: m[2].trim(), heading: line, lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  if (current) {
    blocks.push({ level: current.level, text: current.text, heading: current.heading, body: current.lines.join("\n").trim() });
  }
  return { preamble: preambleLines.join("\n").trim(), blocks: blocks.map((b, index) => ({ ...b, index })) };
}

/** Batch heading blocks into groups of `batchSize` (~30-50 headers per LLM call). */
export function batchHeaderBlocks(blocks: HeaderBlock[], batchSize = HEADER_RELEVEL_BATCH_SIZE): HeaderBlock[][] {
  const out: HeaderBlock[][] = [];
  for (let i = 0; i < blocks.length; i += batchSize) {
    out.push(blocks.slice(i, i + batchSize));
  }
  return out;
}

/** Rebuild the markdown with the (corrected) header levels. */
export function rebuildMarkdown(preamble: string, blocks: HeaderBlock[]): string {
  const parts: string[] = [];
  if (preamble) parts.push(preamble);
  for (const block of blocks) {
    parts.push(`${"#".repeat(clampHeaderLevel(block.level))} ${block.text}`);
    if (block.body) parts.push(block.body);
  }
  return parts.join("\n\n");
}

/** Slugify the first h1 heading as a storage stem; falls back to "document". */
export function deriveStem(markdown: string): string {
  const m = /^#\s+(.+)$/m.exec(markdown);
  const base = m?.[1]?.trim() ?? "document";
  const slug = slugifyStem(base);
  return slug || "document";
}

/** Lowercase slug of arbitrary text (non-alphanumerics → dashes). */
function slugifyStem(base: string): string {
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Slugify an upload file name into a storage stem ("Sommerseminar-Mallorca-2023.pdf.md"
 * → "sommerseminar-mallorca-2023"). Strips ALL trailing extensions; empty when
 * nothing usable remains.
 */
export function deriveStemFromFileName(fileName: string): string {
  let base = fileName.trim();
  while (/\.[a-z0-9]{1,5}$/i.test(base)) base = base.replace(/\.[a-z0-9]{1,5}$/i, "");
  return slugifyStem(base);
}

const GENERIC_STEM = "document";

/**
 * G4.S8.T18 stem hardening: NEVER fall back to the generic "document" stem when
 * a file name is available. Preference order: h1-derived slug → file-name-derived
 * slug → generic fallback (only when neither source exists).
 */
export function deriveStemWithFileName(markdown: string, fileName?: string): string {
  const fromMarkdown = deriveStem(markdown);
  if (fromMarkdown !== GENERIC_STEM) return fromMarkdown;
  const trimmed = fileName?.trim();
  if (trimmed) {
    const fromName = deriveStemFromFileName(trimmed);
    if (fromName) return fromName;
  }
  return fromMarkdown;
}

// --- G4.S8.T18: single-h1 post-condition + deterministic hierarchy completion ---

/** Count level-1 headings (the document title slots). */
export function countH1(markdown: string): number {
  return markdown.split(/\r?\n/).filter((line) => /^#\s+\S/.test(line)).length;
}

/** True when the markdown carries EXACTLY ONE h1 title (the refinement contract). */
export function hasSingleH1(markdown: string): boolean {
  return countH1(markdown) === 1;
}

/** Post-condition assertion: exactly ONE h1 title — used by tests AND the refine pipeline. */
export function assertSingleH1(markdown: string): void {
  const n = countH1(markdown);
  if (n !== 1) {
    throw new Error(`assertSingleH1: expected exactly one h1 document title, found ${n}`);
  }
}

export interface HeaderHierarchyCompletion {
  markdown: string;
  changed: boolean;
  /** Headings raised to h1 (0 or 1 — the missing title case). */
  promoted: number;
  /** Surplus h1s demoted to h2 (all but the first). */
  demoted: number;
}

/**
 * Deterministic single-h1 completion (G4.S8.T18 Mallorca root cause): partial
 * patch application can re-level ##/### yet never promote a title — leaving a
 * coherent-looking tree with ZERO h1. Enforce the contract locally: zero h1 →
 * promote the FIRST heading to the title slot; several h1s → demote every h1
 * after the first to h2. Pure/local — zero additional LLM calls.
 *
 * `options.demoteSurplus: false` keeps EXISTING h1s intact (the TWO-STAGE path's
 * multi-h1 section layout is by design — `section_paths` keys on h1 sections);
 * the missing-title promotion still applies.
 */
export function completeHeaderHierarchy(
  markdown: string,
  options: { demoteSurplus?: boolean } = {},
): HeaderHierarchyCompletion {
  const lines = markdown.split(/\r?\n/);
  const h1Lines = lines.map((l, i) => (/^#\s+\S/.test(l) ? i : -1)).filter((i) => i >= 0);
  let promoted = 0;
  let demoted = 0;
  if (h1Lines.length === 0) {
    const firstHeading = lines.findIndex((l) => /^#{1,6}\s+\S/.test(l));
    if (firstHeading !== -1) {
      lines[firstHeading] = `# ${lines[firstHeading]!.replace(/^#{1,6}\s+/, "")}`;
      promoted = 1;
    }
  } else if (h1Lines.length > 1 && options.demoteSurplus !== false) {
    for (const i of h1Lines.slice(1)) {
      lines[i] = `## ${lines[i]!.replace(/^#\s+/, "")}`;
      demoted += 1;
    }
  }
  return { markdown: lines.join("\n"), changed: promoted + demoted > 0, promoted, demoted };
}

/** Short preview of the re-leveled markdown — the big-output pattern keeps ONLY this in context. */
export function previewMarkdown(markdown: string, maxChars = REFINE_PREVIEW_MAX_CHARS): string {
  const collapsed = markdown.replace(/\n{3,}/g, "\n\n");
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Split re-leveled markdown at h1 boundaries into sections; falls back to h2 when the doc has no h1. */
export function splitByRefinedH1(markdown: string): MarkdownSection[] {
  const h1Sections = splitByHeadingLevel(markdown, 1);
  return h1Sections.length > 1 ? h1Sections : splitByHeadingLevel(markdown, 2);
}

/**
 * G4.8 delta-alignment: keep a document's EXISTING chunk boundaries and only
 * refresh each chunk's text from the NEW markdown section at the SAME heading
 * path. Because chunk ids / heading_paths stay stable, the Neo4j overwrite's
 * `prev.text !== chunk.text` check then re-embeds ONLY the chunk(s) whose
 * section really changed.
 *
 * G4.S8.T21: sections are keyed by their FULL heading-path chain
 * ("Day 1 / Agenda"), not just the last segment — repeated tail titles (e.g.
 * "Agenda" under Day 1 AND Day 2) map to their OWN chunk. A chunk whose path
 * has no matching section keeps its old text: stale-chunk deletion remains
 * overwrite()'s job, and a wrong-chunk refresh is never silently rewritten.
 */
export function alignChunksToMarkdown(
  oldChunks: RefinementChunk[],
  newMarkdown: string,
): RefinementChunk[] {
  const byPath = new Map<string, string>();
  for (const section of splitForAlignment(newMarkdown)) {
    const key = headingPathKey(section.heading_path);
    if (key && !byPath.has(key)) byPath.set(key, section.markdown);
  }
  return oldChunks.map((chunk) => {
    const key = headingPathKey(chunk.heading_path ?? "");
    const newText = key ? byPath.get(key) : undefined;
    return newText !== undefined && newText !== chunk.text ? { ...chunk, text: newText } : chunk;
  });
}

/** Normalized full-chain comparison key: trimmed segments, collapsed whitespace. */
function headingPathKey(path: string): string {
  return path
    .split("/")
    .map((segment) => segment.replace(/\s+/g, " ").trim())
    .filter((segment) => segment.length > 0)
    .join("/");
}

interface AlignSection {
  heading_path: string;
  markdown: string;
}

/**
 * Split at EVERY heading into hierarchical sections: each heading starts a
 * section spanning until the next heading AT OR ABOVE its level (true
 * containment — a parent section still covers its subsections), and carries
 * the FULL " / "-joined heading chain the local paragraph-semantic chunker
 * emits, so chunk paths match section paths 1:1 including duplicates.
 */
function splitForAlignment(markdown: string): AlignSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: AlignSection[] = [];
  const stack: Array<{ level: number; text: string }> = [];
  const open: Array<{ level: number; chain: string; start: number }> = [];
  const closeThrough = (level: number, endExclusive: number): void => {
    while (open.length > 0 && open[open.length - 1]!.level >= level) {
      const section = open.pop()!;
      const text = lines.slice(section.start, endExclusive).join("\n").trim();
      if (text.length > 0) sections.push({ heading_path: section.chain, markdown: text });
    }
  };
  for (let i = 0; i < lines.length; i += 1) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(lines[i]!);
    if (!heading) continue;
    closeThrough(heading[1].length, i);
    while (stack.length > 0 && stack[stack.length - 1]!.level >= heading[1].length) stack.pop();
    stack.push({ level: heading[1].length, text: heading[2].trim() });
    open.push({ level: heading[1].length, chain: stack.map((h) => h.text).join(" / "), start: i });
  }
  closeThrough(1, lines.length);
  return sections;
}

/** Split by a given heading level into sections carrying their leading heading as heading_path. */
function splitByHeadingLevel(markdown: string, level: number): MarkdownSection[] {
  const marker = `${"#".repeat(level)} `;
  const lines = markdown.split(/\r?\n/);
  const sections: Array<{ heading_path: string; lines: string[] }> = [];
  let current: { heading_path: string; lines: string[] } | null = null;
  for (const line of lines) {
    if (line.startsWith(marker)) {
      if (current) sections.push(current);
      current = { heading_path: line.slice(marker.length).trim(), lines: [line] };
      continue;
    }
    if (!current) {
      current = { heading_path: "", lines: [line] };
      continue;
    }
    current.lines.push(line);
  }
  if (current) sections.push(current);
  return sections
    .map((s) => ({ heading_path: s.heading_path, markdown: s.lines.join("\n").trim() }))
    .filter((s) => s.markdown.length > 0);
}

/** Hard-split any section that still exceeds the per-section budget (paragraph boundaries). */
export function enforceSectionSize(sections: MarkdownSection[], maxBytes = SECTION_MAX_BYTES): MarkdownSection[] {
  const out: MarkdownSection[] = [];
  for (const section of sections) {
    if (Buffer.byteLength(section.markdown, "utf8") <= maxBytes) {
      out.push(section);
      continue;
    }
    out.push(...splitSectionBySize(section, maxBytes));
  }
  return out;
}

function splitSectionBySize(section: MarkdownSection, maxBytes: number): MarkdownSection[] {
  const paragraphs = section.markdown.split(/\n\n+/);
  const groups: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const paragraph of paragraphs) {
    const bytes = Buffer.byteLength(paragraph, "utf8");
    if (current.length > 0 && size + bytes > maxBytes) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(paragraph);
    size += bytes;
  }
  if (current.length > 0) groups.push(current);
  return groups.map((group, i) => ({
    heading_path: i === 0 ? section.heading_path : `${section.heading_path} (part ${i + 1})`,
    markdown: group.join("\n\n"),
  }));
}

/**
 * Merge per-section refinements back into one document (stage-2 reduce). Chunks are re-numbered
 * c1..cn; entities/relations are deduped case-insensitively (first canonical name wins — avoids
 * "CALEO"/"caleo" variants); keywords are unioned; quality is aggregated (any review_required wins).
 * The file-level `summary` keeps the first non-empty section summary; per-section summaries are
 * merged by title (non-empty wins over an empty duplicate), preserving order.
 */
export function mergeRefinements(sections: RefinedDocument[]): RefinedDocument {
  const chunks: RefinedDocument["chunks"] = [];
  let n = 1;
  for (const section of sections) {
    for (const chunk of section.chunks ?? []) {
      // context preserved across the merge (G4.S8.T16 contextual enrichment)
      chunks.push({
        id: `c${n++}`,
        text: chunk.text,
        heading_path: chunk.heading_path,
        ...(chunk.context ? { context: chunk.context } : {}),
      });
    }
  }
  const entities = dedupeBy(sections.flatMap((s) => s.entities ?? []), (e) => e.name.toLowerCase());
  const relations = dedupeBy(
    sections.flatMap((s) => s.relations ?? []),
    (r) => `${r.source}|${r.target}|${(r.keywords ?? []).join(",")}`,
  );
  const keywords = dedupeBy(sections.flatMap((s) => s.keywords ?? []), (k) => k);
  const qualities = sections.map((s) => s.quality).filter((q): q is RefinementQuality => Boolean(q));
  const issues = dedupeBy(qualities.flatMap((q) => q.issues ?? []), (i) => i);
  // G4.S8.T17: anchored issues survive the two-stage merge (deduped by message+quote)
  // so the review annotations cover large docs too.
  const issueAnchors = dedupeBy(
    qualities.flatMap((q) => q.issue_anchors ?? []),
    (a) => `${a.message}|${a.quote}`,
  );
  const complete = qualities.every((q) => q.complete);
  const confidence =
    qualities.length > 0 ? qualities.reduce((sum, q) => sum + q.confidence, 0) / qualities.length : 0;
  const action: RefinementQuality["action"] = qualities.some((q) => q.action === "review_required")
    ? "review_required"
    : "auto_accept";

  const summary = sections.find((s) => s.summary?.trim())?.summary ?? "";
  const byTitle = new Map<string, RefinementSectionSummary>();
  for (const section of sections) {
    for (const sec of section.sections ?? []) {
      const key = sec.title.trim().toLowerCase();
      const existing = byTitle.get(key);
      if (!existing || (existing.summary.trim().length === 0 && sec.summary.trim().length > 0)) {
        byTitle.set(key, sec);
      }
    }
  }

  return {
    markdown: sections.map((s) => s.markdown.trim()).filter(Boolean).join("\n\n"),
    summary,
    sections: [...byTitle.values()],
    frontmatter: sections.find((s) => s.frontmatter)?.frontmatter ?? { type: "document", topic: "unclassified" },
    chunks,
    entities,
    relations,
    keywords,
    quality: {
      complete,
      confidence,
      issues,
      action,
      ...(issueAnchors.length > 0 ? { issue_anchors: issueAnchors } : {}),
    },
  };
}

/** Dedupe by a stable key, keeping the first occurrence (order preserved). */
function dedupeBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function countHeaders(markdown: string): number {
  return markdown.split(/\r?\n/).filter((line) => /^#{1,6}\s+/.test(line)).length;
}

// --- G4.S8.T1: local markdown rebuild + local paragraph-semantic chunking (delta contract) ---

/** A structural block of a markdown section — either a heading or a paragraph. */
type PatchBlock = { kind: "heading"; level: number; text: string } | { kind: "paragraph"; text: string };

/**
 * Parse markdown into an ordered block grid (headings + paragraphs, 0-based, in document order).
 * Patches reference this grid by `index`; the same grid drives the local heading-path chunker.
 */
export function parseMarkdownBlocks(markdown: string): PatchBlock[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: PatchBlock[] = [];
  let para: string[] = [];
  const flushPara = (): void => {
    const text = para.join("\n").trim();
    if (text) blocks.push({ kind: "paragraph", text });
    para = [];
  };
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      blocks.push({ kind: "heading", level: h[1].length, text: h[2].trim() });
    } else if (line.trim() === "") {
      flushPara();
    } else {
      para.push(line);
    }
  }
  flushPara();
  return blocks;
}

/** Rebuild markdown text from a block grid (normalized: headings + paragraphs joined by blank lines). */
function blocksToMarkdown(blocks: PatchBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === "heading") out.push(`${"#".repeat(b.level)} ${b.text}`);
    else if (b.text) out.push(b.text);
  }
  return out.join("\n\n");
}

/**
 * Apply a list of optional patches to the ORIGINAL section markdown, returning the locally-rebuilt
 * markdown. Patch indices refer to the 0-based block grid of `markdown` (headings + paragraphs in
 * document order). Heading ops only affect heading blocks; paragraph ops only affect paragraph blocks;
 * out-of-range or wrong-kind patches are ignored (fidelity-first: no information re-generation).
 * Convenience wrapper over `applyPatchesWithReport` (G4.S8.T16 instrumentation).
 */
export function applyPatches(markdown: string, patches: readonly RefinementPatch[]): string {
  return applyPatchesWithReport(markdown, patches).markdown;
}

/** Per-run patch-cycle instrumentation (G4.S8.T16) — makes silent drops IMPOSSIBLE to miss. */
export interface PatchApplyReport {
  /** Number of patches the LLM emitted (input length). */
  emitted: number;
  /** Number actually applied to the block grid. */
  applied: number;
  /** Each ignored patch with its concrete reason: out_of_range | kind_mismatch | unresolved | already_removed. */
  dropped: Array<{ index: number; reason: string }>;
}

/**
 * Apply patches WITH the per-run {patchesEmitted, patchesApplied, patchesDropped} report.
 *
 * G4.S8.T16 heading-text anchoring: heading ops may carry an `anchor` (the heading's CURRENT text).
 * When the ordinal index misses (block-count drift, headings-only misnumbering — the Mallorca
 * failure), the target is located by normalized anchor text instead; text anchors survive drift,
 * ordinals do not. Unresolvable patches are REPORTED as dropped, never silently ignored.
 */
export function applyPatchesWithReport(
  markdown: string,
  patches: readonly RefinementPatch[],
): { markdown: string; report: PatchApplyReport } {
  const original = parseMarkdownBlocks(markdown);
  const result: PatchBlock[] = [...original];
  const report: PatchApplyReport = { emitted: (patches ?? []).length, applied: 0, dropped: [] };
  const normalizedAnchor = (text: string | undefined): string =>
    (text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const isHeadingOp = (p: RefinementPatch): p is RefinementHeadingPatch =>
    p.op === "refactor_heading" || p.op === "retitle_heading";

  const findHeadingByAnchor = (anchor: string | undefined): number => {
    const key = normalizedAnchor(anchor);
    if (!key) return -1;
    return result.findIndex((b) => b.kind === "heading" && normalizedAnchor(b.text) === key);
  };

  for (const patch of patches ?? []) {
    const inRange = Number.isInteger(patch.index) && patch.index >= 0 && patch.index < original.length;
    const pos = inRange ? result.indexOf(original[patch.index]!) : -1;
    const target = pos !== -1 ? result[pos]! : undefined;

    const applyAt = (at: number): void => {
      const block = result[at]!;
      switch (patch.op) {
        case "retitle_heading":
          if (block.kind === "heading") block.text = patch.text;
          break;
        case "refactor_heading":
          if (block.kind === "heading") block.level = clampHeaderLevel(patch.level);
          break;
        case "replace_paragraph":
          if (block.kind === "paragraph") block.text = patch.text;
          break;
        case "insert_paragraph":
          if (block.kind === "paragraph") result.splice(at + 1, 0, { kind: "paragraph", text: patch.text });
          break;
        case "delete_paragraph":
          if (block.kind === "paragraph") result.splice(at, 1);
          break;
      }
      report.applied += 1;
    };

    if (!target) {
      // index missed (out of range or already removed) — try the heading-text anchor before giving up
      if (isHeadingOp(patch)) {
        const byAnchor = findHeadingByAnchor(patch.anchor);
        if (byAnchor !== -1) {
          applyAt(byAnchor);
          continue;
        }
        report.dropped.push({ index: patch.index, reason: patch.anchor ? "unresolved" : "out_of_range" });
      } else {
        report.dropped.push({ index: patch.index, reason: "out_of_range" });
      }
      continue;
    }

    if (isHeadingOp(patch)) {
      if (target.kind === "heading") {
        applyAt(pos);
      } else {
        const byAnchor = findHeadingByAnchor(patch.anchor);
        if (byAnchor !== -1) {
          applyAt(byAnchor);
        } else {
          report.dropped.push({ index: patch.index, reason: "kind_mismatch" });
        }
      }
      continue;
    }

    if (target.kind !== "paragraph") {
      report.dropped.push({ index: patch.index, reason: "kind_mismatch" });
      continue;
    }
    applyAt(pos);
  }

  return { markdown: blocksToMarkdown(result), report };
}

/** Heading ops extended with an optional heading-text anchor (G4.S8.T16). */
type RefinementHeadingPatch =
  | ({ op: "retitle_heading"; index: number; text: string } & { anchor?: string })
  | ({ op: "refactor_heading"; index: number; level: number } & { anchor?: string });

/**
 * Locally segment a (rebuilt) markdown into paragraph-semantic chunks. Each chunk carries a stable
 * id c1..cN and its heading path (G4.S8.T1). The LLM never emits chunk text — this runs on the LOCAL
 * rebuild, so chunk count == paragraph-semantic block count after merging.
 *
 * G4.S8.T16 minimum-size merge: consecutive non-heading blocks sharing the same heading path merge
 * until the chunk reaches REFINE_MIN_CHUNK_CHARS (default 400, env-tunable) — eliminating the
 * sub-10-char fragments docling produces. Oversized blocks stay intact; the final block of a section
 * may stay below the minimum.
 *
 * G4.S8.T16 zero-LLM contextual enrichment: when `summary` is provided, every chunk gets a one-line
 * `context` sentence ("<first summary sentence>; this section covers <heading path>") — the refine
 * pass already read the whole document, so this costs ZERO additional LLM calls.
 */
export interface SplitParagraphOptions {
  /** File-level document summary — feeds the per-chunk context sentence. */
  summary?: string;
  /** Minimum merged-chunk size in chars. Default: REFINE_MIN_CHUNK_CHARS / env. */
  minChars?: number;
}

/** First sentence of a text (up to ". " / "!" / "?" boundary), whitespace-collapsed, capped. */
function firstSentence(text: string, maxChars = 240): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?])(?:\s|$)/.exec(collapsed);
  return (m?.[1] ?? collapsed).slice(0, maxChars);
}

/**
 * Compose the one-line chunk context sentence (G4.S8.T16): "<doc summary>; this section covers
 * <heading path>". Degrades to whichever piece exists; undefined only when BOTH are absent.
 */
export function composeChunkContext(summary: string | undefined, headingPath: string): string | undefined {
  const s = firstSentence(summary ?? "");
  const parts: string[] = [];
  if (s) parts.push(s);
  if (headingPath) parts.push(`this section covers ${headingPath}`);
  if (parts.length === 0) return undefined;
  const joined = parts.join("; ");
  const line = /[.!?]$/.test(joined) ? joined : `${joined}.`;
  // Sentence-case the composed line when it starts fresh (no summary prefix).
  return s ? line : `${line.charAt(0).toUpperCase()}${line.slice(1)}`;
}

export function splitParagraphSemantic(markdown: string, options: SplitParagraphOptions = {}): RefinementChunk[] {
  const blocks = parseMarkdownBlocks(markdown);
  const chunks: RefinementChunk[] = [];
  let id = 1;
  const headingStack: Array<{ level: number; text: string }> = [];
  const headingPath = (): string => headingStack.map((h) => h.text).join(" / ");
  const minChars = options.minChars ?? refineMinChunkChars();

  for (let i = 0; i < blocks.length; ) {
    const block = blocks[i]!;
    if (block.kind === "heading") {
      while (headingStack.length && headingStack[headingStack.length - 1].level >= block.level) {
        headingStack.pop();
      }
      headingStack.push({ level: block.level, text: block.text });
      i += 1;
      continue;
    }
    if (!block.text) {
      i += 1;
      continue;
    }

    // Merge consecutive non-heading blocks under the SAME heading path until the minimum size is
    // reached; whatever remains before the next heading is the exempt final group.
    const mergedTexts: string[] = [block.text];
    let size = block.text.length;
    let j = i + 1;
    while (size < minChars && j < blocks.length) {
      const next = blocks[j]!;
      if (next.kind === "heading" || !next.text) break;
      mergedTexts.push(next.text);
      size += next.text.length;
      j += 1;
    }
    const context = composeChunkContext(options.summary, headingPath());
    chunks.push({
      id: `c${id++}`,
      text: mergedTexts.join("\n\n"),
      heading_path: headingPath(),
      ...(context ? { context } : {}),
    });
    i = j;
  }
  return chunks;
}

/**
 * Detect the docling FLAT-header failure shape (G4.S8.T16 Mallorca repro): more than 3 headings
 * sharing ONE level that covers all but at most one outlier (e.g. 16 × h2, or title + 15 × h2).
 * Used by the deterministic HEADER_RELEVEL recovery in the single-pass refine path.
 */
export function isFlatHeaderMarkdown(markdown: string): boolean {
  const levels = new Map<number, number>();
  let total = 0;
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^(#{1,6})\s+/.exec(line);
    if (!m) continue;
    total += 1;
    levels.set(m[1].length, (levels.get(m[1].length) ?? 0) + 1);
  }
  if (total <= 3) return false;
  const dominant = Math.max(...levels.values());
  return dominant > 3 && dominant >= total - 1;
}


/**
 * Big-output storage (pi-docparser pattern): write the full re-leveled markdown + chunks JSON to
 * `<storageDir>/<stem>/` and return the SMALL ref (preview + metadata + refs) for the context.
 * File A′ (durable, `doc.markdown`) → `markdown.md`; when `options.ragMarkdown` differs it is written
 * as the RAG working copy `rag.md` (deleted downstream after RAG ingestion; G4.S1.T6).
 */
export async function storeRefinementOutput(
  doc: RefinedDocument,
  storageDir: string,
  options: StoreRefinementOptions = {},
): Promise<RefineOutputRef> {
  const stem = options.stem ?? deriveStem(doc.markdown);
  const dir = join(storageDir, stem);
  const mdPath = join(dir, "markdown.md");
  const chunksPath = join(dir, "chunks.json");
  const ragPath = join(dir, "rag.md");
  const mkdirImpl = options.mkdir ?? (async (path: string) => void (await mkdir(path, { recursive: true })));
  const writeFileImpl = options.writeFile ?? ((path: string, content: string) => writeFile(path, content, "utf8"));

  await mkdirImpl(dir);
  await writeFileImpl(mdPath, doc.markdown);
  await writeFileImpl(chunksPath, JSON.stringify(doc.chunks ?? [], null, 2));
  // G4.S8.T17: the structured per-issue review state lives NEXT TO the big
  // outputs — POST /api/kb/wiki/review-state flips `resolved` in this exact file.
  const qualityIssues = deriveQualityIssues(doc.quality, doc.markdown);
  await writeFileImpl(
    join(dir, "quality.json"),
    JSON.stringify({ action: doc.quality.action, issues: qualityIssues }, null, 2),
  );

  const separateRag = options.ragMarkdown !== undefined && options.ragMarkdown !== doc.markdown;
  if (separateRag) {
    await writeFileImpl(ragPath, options.ragMarkdown!);
  }

  return {
    md_ref: mdPath,
    rag_md_ref: separateRag ? ragPath : mdPath,
    chunks_ref: chunksPath,
    preview: previewMarkdown(doc.markdown),
    char_count: doc.markdown.length,
    line_count: doc.markdown.split("\n").length,
    header_count: countHeaders(doc.markdown),
    chunk_count: (doc.chunks ?? []).length,
    frontmatter: doc.frontmatter,
    entities: doc.entities ?? [],
    relations: doc.relations ?? [],
    keywords: doc.keywords ?? [],
    quality: doc.quality,
    ...(qualityIssues.length > 0 ? { refinement_issues: qualityIssues } : {}),
    summary: doc.summary ?? "",
    sections: doc.sections ?? [],
    mode: options.mode ?? "single",
    section_paths: options.section_paths ?? [],
    ...(doc.link_edges && doc.link_edges.length > 0 ? { link_edges: doc.link_edges } : {}),
  };
}

// --- G4.S8.T18: deterministic placeholder pre-check ---

/** A single objective defect hit: the matching line excerpt + its resolved heading path. */
export interface ObjectiveDefect {
  quote: string;
  heading_path: string;
  pattern: string;
}

/** Default objective-defect patterns (JS regex sources, case-insensitive). */
export const DEFAULT_PLACEHOLDER_PATTERNS = ["\\?{3,}", "\\bTODO\\b", "\\bFIXME\\b", "\\bXXX\\b", "lorem ipsum"];

/**
 * The active placeholder patterns. Override with REFINE_PLACEHOLDER_PATTERNS
 * ("::"-separated JS regex sources, e.g. "?{3,}::TODO::WIP"); a bad regex is
 * skipped rather than crashing the pipeline.
 */
export function placeholderPatterns(env: string = process.env.REFINE_PLACEHOLDER_PATTERNS ?? ""): RegExp[] {
  const sources = env.trim()
    ? env.split("::").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_PLACEHOLDER_PATTERNS;
  const out: RegExp[] = [];
  for (const source of sources) {
    try {
      out.push(new RegExp(source, "i"));
    } catch {
      // skip an invalid override pattern — never crash refinement on config
    }
  }
  return out;
}

const DEFECT_QUOTE_MAX = 240;

/**
 * Scan rebuilt markdown for OBJECTIVE defect patterns — ????? (3+ consecutive ?),
 * TODO/FIXME/XXX markers, lorem ipsum — provider-independently (G4.S8.T18). Each
 * hit carries its matching line excerpt as `quote` and the enclosing/own heading
 * path so review annotations can anchor in place. Deduped per line+pattern.
 */
export function scanObjectiveDefects(markdown: string): ObjectiveDefect[] {
  const patterns = placeholderPatterns();
  if (patterns.length === 0) return [];
  const defects: ObjectiveDefect[] = [];
  const seen = new Set<string>();
  const stack: Array<{ level: number; text: string }> = [];
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, text: normalizeWs(heading[2]!) });
    }
    for (const pattern of patterns) {
      if (!pattern.test(line)) continue;
      const quote = normalizeWs(line).slice(0, DEFECT_QUOTE_MAX);
      if (!quote) continue;
      const key = `${pattern.source}|${quote.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      defects.push({
        quote,
        heading_path: stack.map((s) => s.text).join(" / "),
        pattern: pattern.source,
      });
    }
  }
  return defects;
}

/** The structured issue shape shared with T17's quality.json issues. */
interface QualityIssueLike {
  id: string;
  message: string;
  anchor?: { quote: string; heading_path?: string };
}

/** Whitespace-fold a quote so an LLM anchor and a scanner hit for the SAME text collide. */
function normalizedQuoteKey(quote: string | undefined): string {
  return normalizeWs(quote ?? "").toLowerCase();
}

/**
 * Merge deterministic scanner hits INTO the LLM's quality view (G4.S8.T18):
 * each unmatched hit becomes one anchored issue; ANY hit forces
 * action=review_required + complete=false regardless of the LLM verdict.
 * Dedupe against LLM-raised anchors by normalized-quote overlap.
 * Returns the (possibly replaced) quality view and the appended issue ids.
 */
export function mergeObjectiveDefectsIntoQuality(
  quality: RefinementQuality,
  markdown: string,
): { quality: RefinementQuality; appended: QualityIssueLike[] } {
  const defects = scanObjectiveDefects(markdown);
  if (defects.length === 0) return { quality, appended: [] };
  const existingAnchors = new Set(
    (quality.issue_anchors ?? []).map((a) => normalizedQuoteKey(a.quote)).filter(Boolean),
  );
  const appended: Array<{ message: string; quote: string }> = [];
  for (const defect of defects) {
    const key = normalizedQuoteKey(defect.quote);
    if (key && existingAnchors.has(key)) continue;
    existingAnchors.add(key);
    appended.push({
      message: `[placeholder:${defect.pattern}] objective defect detected${defect.heading_path ? ` under "${defect.heading_path}"` : ""}`,
      quote: defect.quote,
    });
  }
  if (appended.length === 0) {
    // Every defect was already flagged by the LLM for the same quote — still
    // enforce the gate deterministically (never trust the verdict over facts).
    return {
      quality: { ...quality, complete: false, action: "review_required" },
      appended: [],
    };
  }
  return {
    quality: {
      ...quality,
      complete: false,
      action: "review_required",
      issue_anchors: [...(quality.issue_anchors ?? []), ...appended],
    },
    appended: appended.map((a, i) => ({
      id: `qi-obj-${i + 1}`,
      message: a.message,
      anchor: { quote: a.quote },
    })),
  };
}
