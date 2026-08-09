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
  RefinementEntity,
  RefinementFrontmatter,
  RefinementQuality,
  RefinementRelation,
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
  /** Which refinement path produced the output: "single" (sub-1MB) or "two-stage" (>1MB). */
  mode: RefinementMode;
  /** h1 section heading paths produced by the two-stage split (two-stage mode only). */
  sections: string[];
}

export interface StoreRefinementOptions {
  /** Storage sub-directory name. Default: derived from the first h1 heading. */
  stem?: string;
  mode?: RefinementMode;
  sections?: string[];
  /** Injectable mkdir for tests. */
  mkdir?: (path: string) => Promise<void>;
  /** Injectable writeFile for tests. */
  writeFile?: (path: string, content: string) => Promise<void>;
}

/** Clamp a heading level to the valid 1-6 range. */
export function clampHeaderLevel(level: number): number {
  if (Number.isFinite(level)) return Math.min(6, Math.max(1, Math.round(level)));
  return 2;
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
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "document";
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
 */
export function mergeRefinements(sections: RefinedDocument[]): RefinedDocument {
  const chunks: RefinedDocument["chunks"] = [];
  let n = 1;
  for (const section of sections) {
    for (const chunk of section.chunks ?? []) {
      chunks.push({ id: `c${n++}`, text: chunk.text, heading_path: chunk.heading_path });
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
  const complete = qualities.every((q) => q.complete);
  const confidence =
    qualities.length > 0 ? qualities.reduce((sum, q) => sum + q.confidence, 0) / qualities.length : 0;
  const action: RefinementQuality["action"] = qualities.some((q) => q.action === "review_required")
    ? "review_required"
    : "auto_accept";

  return {
    markdown: sections.map((s) => s.markdown.trim()).filter(Boolean).join("\n\n"),
    frontmatter: sections.find((s) => s.frontmatter)?.frontmatter ?? { type: "document", topic: "unclassified" },
    chunks,
    entities,
    relations,
    keywords,
    quality: { complete, confidence, issues, action },
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

/**
 * Big-output storage (pi-docparser pattern): write the full re-leveled markdown + chunks JSON to
 * `<storageDir>/<stem>/` and return the SMALL ref (preview + metadata + refs) for the context.
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
  const mkdirImpl = options.mkdir ?? (async (path: string) => void (await mkdir(path, { recursive: true })));
  const writeFileImpl = options.writeFile ?? ((path: string, content: string) => writeFile(path, content, "utf8"));

  await mkdirImpl(dir);
  await writeFileImpl(mdPath, doc.markdown);
  await writeFileImpl(chunksPath, JSON.stringify(doc.chunks ?? [], null, 2));

  return {
    md_ref: mdPath,
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
    mode: options.mode ?? "single",
    sections: options.sections ?? [],
  };
}
