/**
 * Athena document-refinement custom tool (G4.S1.T1).
 *
 * `refine_document` is a Pi custom tool (ToolDefinition) registered on the athena agent. It runs the
 * SINGLE full-document LLM pass of the ingest chain (G4.S1 Spec): given the docling markdown it re-levels
 * headers, classifies type/topic, chunks, extracts entities/relations/keywords and quality-checks the
 * document — all in one read, using the dedicated `athena` OpenRouter provider (independent key/cache)
 * with `deepseek-v4-flash-latest` at thinkingLevel `high`.
 *
 * Structured output is enforced with provider-side constrained sampling: the LLM pass is asked to call an
 * `emit_refined_document` tool whose parameters ARE the refinement output contract, so the model cannot
 * drift into free-text JSON.
 *
 * Big-output handling (G4.S1.T3): the FULL re-leveled markdown + chunks land on disk/storage
 * (`storeRefinementOutput`); `refine_document` returns only the SMALL metadata + refs
 * (frontmatter/entities/keywords/quality/summary/sections/md_ref/preview — pi-docparser pattern).
 * The same full-doc read also emits the layered summaries (G4.S2.T13): a file-level `summary`
 * (~2-3 sentences) + one `sections[{title, summary}]` entry per top-level H1 section.
 * >1MB docs use the
 * TWO-STAGE path: local header re-level (batched) → split by refined h1 boundary → per-section full pass
 * → global merge. Sub-1MB docs use a single full-doc pass.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { TYPE_CRITERIA_PROMPT, TOPIC_TREE_PROMPT } from "../kb/taxonomy.js";
import {
  HEADER_RELEVEL_BATCH_SIZE,
  applyPatches,
  batchHeaderBlocks,
  clampHeaderLevel,
  deriveStem,
  enforceSectionSize,
  hasImageRefs,
  isLargeMarkdown,
  mergeRefinements,
  rebuildMarkdown,
  splitByHeaders,
  splitByRefinedH1,
  splitParagraphSemantic,
  storeRefinementOutput,
  stripImageRefs,
  syncRefinedHeadersToSource,
  type HeaderBlock,
  type MarkdownSection,
  type RefineOutputRef,
  type RefinementMode,
} from "./refine-output.js";

/** Provider id (default "athena" — Pi-resolvable provider; custom ids like
 *  athena-ingest/athenaingest are NOT resolved by ModelRuntime.completeSimple
 *  ("Provider is not configured"), so refinement uses the known athena
 *  provider. Key separation from chat pending a Pi custom-provider path
 *  (G4.S8 T2 — see S8 Spec). */
export const ATHENA_PROVIDER = "athena";
export const ATHENA_MODEL = "~deepseek/deepseek-v4-flash-latest";

/** pi ThinkingLevel values for the `reasoning` option (mirrors the SDK union). */
export type AthenaThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** The model handle `completeSimple` expects (derived from the SDK signature, avoids SDK-internal imports). */
type RefineModel = Parameters<ModelRuntime["completeSimple"]>[0];

/** Name of the constrained emit tool the refinement LLM must call with the output contract. */
export const EMIT_REFINED_DOCUMENT_TOOL = "emit_refined_document";

/** Name of the constrained emit tool the stage-1 header judge must call with the re-leveled headers. */
export const EMIT_HEADER_LEVELS_TOOL = "emit_header_levels";

/** Name of the constrained emit tool the global merge pass must call with the final document view. */
export const EMIT_GLOBAL_REFINEMENT_TOOL = "emit_global_refinement";

/** Name of the `document-refinement` Pi skill backing this pass (G4.S1.T2). */
export const DOCUMENT_REFINEMENT_SKILL_NAME = "document-refinement";

/** Absolute path to the `document-refinement` SKILL.md (server/.pi/skills, Pi project-skill layout). */
export const DOCUMENT_REFINEMENT_SKILL_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../.pi/skills/document-refinement/SKILL.md",
);

// --- Athena refinement output contract (G4.S1.T2 — authoritative; refines the Spec block) ---
export interface RefinementFrontmatter {
  type: string;
  topic: string;
}

/** Paragraph-semantic chunk (~1200 tokens), carrying its re-leveled heading path. */
export interface RefinementChunk {
  id: string;
  text: string;
  heading_path: string;
}

/**
 * Knowledge-graph node. `name` is title-case for consistent naming ("CALEO", not "caleo").
 * `aliases` are bilingual (DE+EN) variants of the SAME node (e.g. name "ZOB München" → aliases
 * ["Zentraler Omnibusbahnhof", "Munich central bus station"]) so RAG finds one node in both
 * languages. `name` is the document-language canonical form.
 */
export interface RefinementEntity {
  name: string;
  type: string;
  description: string;
  aliases?: string[];
}

/** Binary knowledge-graph edge (source -> target). `keywords` = relationship keywords. */
export interface RefinementRelation {
  source: string;
  target: string;
  keywords: string[];
  description: string;
}

export interface RefinementQuality {
  complete: boolean;
  confidence: number;
  issues: string[];
  action: "auto_accept" | "review_required";
}

/** One summary per top-level H1 section (G4.S2.T13 — layered/hierarchical summary). */
export interface RefinementSectionSummary {
  /** The top-level H1 heading text of the section. */
  title: string;
  /** A concise 1-2 sentence summary of that section. */
  summary: string;
}

export interface RefinedDocument {
  markdown: string;
  /** File-level document summary (~2-3 sentences), emitted by the same single full-doc read. */
  summary: string;
  /** One summary per top-level H1 section — layered summary for hierarchical retrieval. */
  sections: RefinementSectionSummary[];
  frontmatter: RefinementFrontmatter;
  chunks: RefinementChunk[];
  entities: RefinementEntity[];
  relations: RefinementRelation[];
  keywords: string[];
  quality: RefinementQuality;
}

/**
 * A minimal, location-addressed text-level edit the refinement LLM may OPTIONALLY propose (G4.S8.T1).
 * `index` refers to the 0-based block grid of the ORIGINAL markdown (headings + paragraphs in document
 * order). Heading ops target heading blocks; paragraph ops target paragraph blocks. Patches are the
 * ONLY text the model emits — Athena applies them LOCALLY to rebuild the final markdown, so the model
 * never re-emits the document text it already read.
 */
export type RefinementPatch =
  | { op: "retitle_heading"; index: number; text: string }
  | { op: "refactor_heading"; index: number; level: number }
  | { op: "replace_paragraph"; index: number; text: string }
  | { op: "insert_paragraph"; index: number; text: string }
  | { op: "delete_paragraph"; index: number };

const PATCH_ONE_OF = Type.Union([
  Type.Object({ op: Type.Literal("retitle_heading"), index: Type.Number(), text: Type.String() }),
  Type.Object({ op: Type.Literal("refactor_heading"), index: Type.Number(), level: Type.Number() }),
  Type.Object({ op: Type.Literal("replace_paragraph"), index: Type.Number(), text: Type.String() }),
  Type.Object({ op: Type.Literal("insert_paragraph"), index: Type.Number(), text: Type.String() }),
  Type.Object({ op: Type.Literal("delete_paragraph"), index: Type.Number() }),
]);

/**
 * The DELTA/extraction refinement contract (G4.S8.T1): the LLM output for the per-section (stage-2)
 * and single-pass paths is EXTRACTION FIELDS ONLY + an optional `patches` array. `markdown` and
 * `chunks` are deliberately ABSENT — Athena rebuilds them locally (applyPatches + splitParagraphSemantic).
 */
export const REFINED_DOCUMENT_DELTA_SCHEMA = Type.Object({
  summary: Type.String(),
  sections: Type.Array(
    Type.Object({
      title: Type.String(),
      summary: Type.String(),
    }),
  ),
  frontmatter: Type.Object({
    type: Type.String(),
    topic: Type.String(),
  }),
  entities: Type.Array(
    Type.Object({
      name: Type.String(),
      type: Type.String(),
      description: Type.String(),
      aliases: Type.Optional(Type.Array(Type.String())),
    }),
  ),
  relations: Type.Array(
    Type.Object({
      source: Type.String(),
      target: Type.String(),
      keywords: Type.Array(Type.String()),
      description: Type.String(),
    }),
  ),
  keywords: Type.Array(Type.String()),
  quality: Type.Object({
    complete: Type.Boolean(),
    confidence: Type.Number(),
    issues: Type.Array(Type.String()),
    action: Type.Union([Type.Literal("auto_accept"), Type.Literal("review_required")]),
  }),
  patches: Type.Optional(Type.Array(PATCH_ONE_OF)),
});

/**
 * JSON schema (TypeBox) of the refinement output contract, used as the constrained emit tool params.
 * NOW the delta/extraction contract — `markdown`/`chunks` are absent (built locally by Athena).
 * Kept under the original name for compatibility; the shape is the delta contract.
 */
export const REFINED_DOCUMENT_SCHEMA = REFINED_DOCUMENT_DELTA_SCHEMA;

/** The structured (delta) output the refinement LLM actually returns. `markdown`/`chunks` are absent. */
export interface RefinedDocumentDelta {
  summary: string;
  sections: RefinementSectionSummary[];
  frontmatter: RefinementFrontmatter;
  entities: RefinementEntity[];
  relations: RefinementRelation[];
  keywords: string[];
  quality: RefinementQuality;
  /** Optional location-addressed text edits; Athena applies them locally to rebuild markdown. */
  patches?: RefinementPatch[];
}

/** Stage-1 emit schema: corrected heading level per header index (T3 two-stage). */
export const HEADER_LEVELS_SCHEMA = Type.Object({
  levels: Type.Array(Type.Object({ index: Type.Number(), level: Type.Number() })),
});

/** Global-merge emit schema: the final single-document view (type/topic + deduped extraction). */
export const GLOBAL_MERGE_SCHEMA = Type.Object({
  summary: Type.String(),
  sections: Type.Array(
    Type.Object({
      title: Type.String(),
      summary: Type.String(),
    }),
  ),
  frontmatter: Type.Object({
    type: Type.String(),
    topic: Type.String(),
  }),
  entities: Type.Array(
    Type.Object({
      name: Type.String(),
      type: Type.String(),
      description: Type.String(),
      aliases: Type.Optional(Type.Array(Type.String())),
    }),
  ),
  relations: Type.Array(
    Type.Object({
      source: Type.String(),
      target: Type.String(),
      keywords: Type.Array(Type.String()),
      description: Type.String(),
    }),
  ),
  keywords: Type.Array(Type.String()),
  quality: Type.Object({
    complete: Type.Boolean(),
    confidence: Type.Number(),
    issues: Type.Array(Type.String()),
    action: Type.Union([Type.Literal("auto_accept"), Type.Literal("review_required")]),
  }),
});

/** The global-view slice of the contract emitted by the two-stage global merge pass (T3). */
export interface GlobalRefinement {
  summary?: string;
  sections?: RefinementSectionSummary[];
  frontmatter?: RefinementFrontmatter;
  entities?: RefinementEntity[];
  relations?: RefinementRelation[];
  keywords?: string[];
  quality?: RefinementQuality;
}

export interface RefineDocumentParams {
  /** Docling markdown of the full document. */
  markdown: string;
  /** Optional operator-provided topic hint folded into the refinement prompt. */
  topic_hint?: string;
}

export interface RefineDocumentOptions {
  /** Provider id (default "athena" — Pi-resolvable; see ATHENA_PROVIDER). */
  providerId?: string;
  /** Model id within the provider (default "~deepseek/deepseek-v4-flash-latest"). */
  modelId?: string;
  /** Reasoning level for the refinement pass (default "high" — header re-leveling needs it). */
  thinkingLevel?: AthenaThinkingLevel;
  /** Retries before giving up to fallbackRefinement (default 3 — up to 4 attempts, G4.S2.T8). */
  retries?: number;
  /** Override the refinement system prompt. */
  systemPrompt?: string;
  /**
   * Big-output storage root (pi-docparser pattern, T3). The full re-leveled markdown + chunks land at
   * `<storageDir>/<stem>/markdown.md` + `chunks.json`; the tool returns only the small ref.
   * Default: `REFINEMENT_OUTPUT_DIR` env or `~/athena-data/refinement`.
   */
  storageDir?: string;
  /** Stage-1 header batch size (~30-50 headers/call). Default: HEADER_RELEVEL_BATCH_SIZE. */
  headerBatchSize?: number;
  /** Inject the stage-1 header judge (tests). Default: judgeHeaderLevelsLLM (LLM). */
  judgeHeaderLevelsImpl?: (blocks: HeaderBlock[]) => Promise<HeaderBlock[]>;
  /** Inject the stage-2 per-section full pass (tests). Default: runRefinePass (LLM). */
  refineSectionImpl?: (section: MarkdownSection, topicHint?: string) => Promise<RefinedDocument>;
  /** Inject the global merge pass (tests). Default: runGlobalMerge (LLM). */
  globalMergeImpl?: (refinements: RefinedDocument[], topicHint?: string) => Promise<RefinedDocument>;
  /** Inject the big-output store (tests). Default: storeRefinementOutput (disk). */
  storeImpl?: RefinementStore;
}

/** Big-output store signature: persist the full doc, return the small ref. */
export type RefinementStore = (
  doc: RefinedDocument,
  storageDir: string,
  options?: { stem?: string; mode?: RefinementMode; section_paths?: string[] },
) => Promise<RefineOutputRef>;

/** Default big-output storage root (T3). Override with REFINEMENT_OUTPUT_DIR. */
export function defaultRefinementOutputDir(): string {
  return process.env.REFINEMENT_OUTPUT_DIR ?? join(homedir(), "athena-data", "refinement");
}

/**
 * The `document-refinement` skill (G4.S1.T2) — full guidance for the refinement pass. Its content is
 * embedded in the refinement system prompt (REFINE_DOCUMENT_SYSTEM_PROMPT) so the LLM pass is
 * self-contained and works in ONE full-document read. A copy also ships as
 * server/.pi/skills/document-refinement/SKILL.md for Pi-skill discovery.
 */
export const DOCUMENT_REFINEMENT_SKILL_GUIDANCE = `# document-refinement — Athena refinement pass (G4.S1)

You are the SINGLE full-document LLM pass of the athena ingest pipeline. You read the whole docling
markdown once and EMIT ONLY EXTRACTION — frontmatter(type+topic), entities, relations, keywords,
quality, and file-level + per-section summaries — plus an OPTIONAL, location-addressed list of edits
(patches). You NEVER re-emit the re-leveled markdown or the chunk texts: Athena rebuilds those LOCALLY
from the original text (which stage-1 has already header-re-leveled). This keeps your output small
(~1-5K tokens) even on the biggest documents — no truncation. No other LLM re-reads the document.

## 1. Header re-level → patches (semantic hierarchy)
Restore a semantic # / ## / ### hierarchy from document structure, not the raw docling levels.
docling often emits FLAT headers (e.g. everything is h2 — a Sommerseminar doc came out with 16x h2).
Decide levels by section meaning: exactly one # title, ## major sections, ### subsections. Promote or
demote so the tree is coherent. Your corrections are expressed as patches:
- refactor_heading { index, level } — change the block's heading level.
- retitle_heading { index, text } — change the heading text (only to fix a typo/OCR artifact).
Patch index (0-based) is the grid position of the block (headings AND paragraphs counted in document
order). Do NOT invent heading levels the document does not imply. Do NOT re-emit text to fix content —
the original text is preserved; you only PROPOSE edits by location.

## 2. Classification (type + topic) — from docs/taxonomy.md
Pick EXACTLY ONE type and ONE hierarchical topic per the CALEO taxonomy (docs/taxonomy.md is
authoritative; the criteria below are embedded for you).

${TYPE_CRITERIA_PROMPT}

${TOPIC_TREE_PROMPT}

## 3. Chunking → LOCAL (paragraph-semantic)
Chunks are built LOCALLY by Athena from the final markdown (splitParagraphSemantic): paragraph-semantic
chunks (~1200 tokens, ~100 token overlap, heading_path = the heading path of the section). You do NOT
emit chunk text or ids — never include a chunks field.

## 4. Entity extraction (knowledge-graph nodes)
Extract the entities that are actually named in the document. For each:
- name: TITLE-CASE, consistent naming — "CALEO", not "caleo"/"CALEO" variants (one canonical form).
  name is the DOCUMENT-LANGUAGE canonical form.
- type: org | person | product | event | location | concept | other (preset types; else "other").
- description: one concise sentence stating what it is in this document's context.
- aliases: bilingual (DE+EN) variant names of the SAME node — the node must be findable in BOTH
  languages (RAG bilingual retrieval). name is the document-language canonical form; aliases are the
  other-language (and alternate) terms for the same entity, e.g. name "ZOB München" → aliases
  ["Zentraler Omnibusbahnhof", "Munich central bus station"]; name "Lüsen" → aliases ["Lüsen"].
  Omit aliases only when no useful variant exists.
Only direct, clearly-stated entities. Do not invent.

## 5. Relation extraction (binary edges)
Extract BINARY relations only: source -> target. For each:
- source / target: must match an emitted entity name exactly (consistent naming).
- keywords: relationship keywords (the verbs/phrases expressing the edge).
- description: one concise sentence.
Decompose multi-entity statements into individual binary edges. Include ONLY direct, clearly-stated,
meaningful relations (graph-RAG best practice) — skip speculative ones.

## 6. Keywords (relationship + query)
Emit retrieval keywords: relationship keywords (edge vocabulary, e.g. "hosts", "part of") AND query
keywords, high-level + low-level (e.g. "sommerseminar", "schedule", "workshop").

## 7. Document summary (file-level + per-section) — layered/hierarchical summaries (G4.S2.T13)
You already read the whole document, so summarize it in the same pass at two levels:
- summary: a FILE-LEVEL summary of ~2-3 sentences stating what the document is about and its most
  important points.
- sections: ONE entry per TOP-LEVEL section of the document — title = the top-level H1 heading text
  (verbatim), summary = a concise 1-2 sentence summary of that section. This lets retrieval locate
  the right document by file summary, then the right section by its summary, then the chunks.
  Emit sections for every top-level section; use an empty array only for a sectionless document.

## 8. Quality checklist
- completeness: did the refined markdown capture the whole source (all sections, tables, figures)?
- tables/figures: note any table split across pages or figure caption dropped.
- garbled text: flag OCR/layout garbage, encoding issues.
- confidence: 0..1 how sure you are.
- issues: concrete list (e.g. "table on p3 split", "image caption missing").
- action: auto_accept (clean) or review_required (any doubt).

## Output
Call the emit_refined_document tool with the DELTA contract — extraction fields + optional patches
(see the tool's JSON schema). Do NOT emit markdown, do NOT emit chunks. A section that needs only
header re-leveling returns patches with refactor_heading ops and no paragraph text. Do not truncate —
but also do not pad your output with text Athena already has.`;

/** Default refinement system prompt — the single full-doc-pass prompt template (G4.S1.T2). */
export const REFINE_DOCUMENT_SYSTEM_PROMPT = `You are Athena, the document-refinement pass of the athena ingest pipeline.
You receive the RAW docling markdown of one document and produce its refined form in ONE full read.

${DOCUMENT_REFINEMENT_SKILL_GUIDANCE}`;

export interface RefineDocumentTool extends ToolDefinition {}

/** Build the refinement system prompt, optionally hinting the expected topic. */
export function buildRefineSystemPrompt(topicHint: string | undefined): string {
  if (!topicHint) return REFINE_DOCUMENT_SYSTEM_PROMPT;
  return `${REFINE_DOCUMENT_SYSTEM_PROMPT}\n\nTopic hint from the operator: ${topicHint}`;
}

interface AssistantTextPart {
  type: "text";
  text: string;
}

interface AssistantToolCallPart {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
}

type AssistantMessageLike = {
  role: string;
  content: (AssistantTextPart | AssistantToolCallPart | { type: string })[];
  usage?: unknown;
};

function isEmitToolCall(part: AssistantMessageLike["content"][number]): part is AssistantToolCallPart {
  return (
    part.type === "toolCall" &&
    "name" in part &&
    (part as AssistantToolCallPart).name === EMIT_REFINED_DOCUMENT_TOOL &&
    "arguments" in part
  );
}

/**
 * Extract the structured refined document from the assistant response.
 * Prefers the constrained `emit_refined_document` tool call; falls back to plain-text JSON
 * (also accepted when nested inside prose or a fenced code block — G4.S1.T6).
 * Throws when neither yields a schema-conformant object.
 */
export function extractRefinedDocument(message: AssistantMessageLike): RefinedDocument {
  for (const part of message.content ?? []) {
    if (isEmitToolCall(part)) {
      return normalizeRefinedDocument(part.arguments);
    }
  }
  const text = (message.content ?? [])
    .filter((part): part is AssistantTextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (text) {
    const parsed = tryParseNestedJson(text);
    if (parsed !== undefined) {
      return normalizeRefinedDocument(parsed);
    }
  }
  throw new Error("refine_document: assistant returned no structured output");
}

/**
 * Lenient JSON recovery from assistant text: try the raw text, then a fenced ```json
 * code block, then the outermost `{...}` span. Returns undefined when nothing parses.
 */
export function tryParseNestedJson(text: string): unknown {
  const candidates: string[] = [text];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) candidates.push(fence[1]);
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    try {
      return JSON.parse(trimmed);
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

/** Coerce a parsed tool-call payload into the refinement contract (JSON-string args accepted). */
export function normalizeRefinedDocument(raw: unknown): RefinedDocument {
  const args: Record<string, unknown> =
    typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : ((raw ?? {}) as Record<string, unknown>);

  const markdown = typeof args.markdown === "string" ? args.markdown : undefined;
  const summary = typeof args.summary === "string" ? args.summary : "";
  const sections = Array.isArray(args.sections)
    ? args.sections.filter(isRecord).map((s) => ({
        title: String(s.title ?? ""),
        summary: String(s.summary ?? ""),
      }))
    : [];
  const frontmatter =
    isRecord(args.frontmatter) && typeof args.frontmatter.type === "string" && typeof args.frontmatter.topic === "string"
      ? { type: args.frontmatter.type, topic: args.frontmatter.topic }
      : undefined;
  const chunks = Array.isArray(args.chunks)
    ? args.chunks.filter(isRecord).map((c) => ({
        id: String(c.id ?? ""),
        text: String(c.text ?? ""),
        heading_path: String(c.heading_path ?? c.topic ?? ""),
      }))
    : [];
  const entities = normalizeEntityList(args.entities);
  const relations = normalizeRelationList(args.relations);
  const keywords = asStringArray(args.keywords) ?? [];
  const quality =
    isRecord(args.quality) && typeof args.quality.complete === "boolean" && typeof args.quality.confidence === "number"
      ? {
          complete: args.quality.complete,
          confidence: args.quality.confidence,
          issues: asStringArray(args.quality.issues) ?? [],
          action: args.quality.action === "review_required" ? ("review_required" as const) : ("auto_accept" as const),
        }
      : undefined;

  if (!markdown || !frontmatter || !quality) {
    throw new Error("refine_document: output does not match the refinement contract (markdown/frontmatter/quality)");
  }

  return { markdown, summary, sections, frontmatter, chunks, entities, relations, keywords, quality };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asStringArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((item) => typeof item === "string") ? v : undefined;

/** Coerce a parsed entities array into the refinement contract. */
export function normalizeEntityList(raw: unknown): RefinementEntity[] {
  return Array.isArray(raw)
    ? raw.filter(isRecord).map((e) => ({
        name: String(e.name ?? ""),
        type: String(e.type ?? "other"),
        description: String(e.description ?? ""),
        aliases: asStringArray(e.aliases) ?? [],
      }))
    : [];
}

/** Coerce a parsed relations array into the refinement contract. */
export function normalizeRelationList(raw: unknown): RefinementRelation[] {
  return Array.isArray(raw)
    ? raw.filter(isRecord).map((r) => ({
        source: String(r.source ?? r.from ?? ""),
        target: String(r.target ?? r.to ?? ""),
        keywords: asStringArray(r.keywords) ?? [],
        description: String(r.description ?? ""),
      }))
    : [];
}

/** Coerce a parsed patches array into the refinement contract (unknown ops dropped). */
export function normalizePatchList(raw: unknown): RefinementPatch[] {
  if (!Array.isArray(raw)) return [];
  const out: RefinementPatch[] = [];
  for (const p of raw) {
    if (!isRecord(p) || typeof p.index !== "number" || !Number.isFinite(p.index)) continue;
    const op = p.op;
    const index = p.index;
    if (op === "retitle_heading" && typeof p.text === "string") out.push({ op, index, text: p.text });
    else if (op === "refactor_heading" && typeof p.level === "number") out.push({ op, index, level: p.level });
    else if (op === "replace_paragraph" && typeof p.text === "string") out.push({ op, index, text: p.text });
    else if (op === "insert_paragraph" && typeof p.text === "string") out.push({ op, index, text: p.text });
    else if (op === "delete_paragraph") out.push({ op, index });
  }
  return out;
}

/**
 * Coerce a parsed delta payload into the delta contract (JSON-string args accepted). Requires
 * frontmatter + quality (the essential fields); everything else defaults. `markdown`/`chunks` are NOT
 * read here — they are absent from the contract and rebuilt locally by `buildRefinedDocument`.
 */
export function normalizeRefinementDelta(raw: unknown): RefinedDocumentDelta {
  const args: Record<string, unknown> =
    typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : ((raw ?? {}) as Record<string, unknown>);
  const summary = typeof args.summary === "string" ? args.summary : "";
  const sections = Array.isArray(args.sections)
    ? args.sections.filter(isRecord).map((s) => ({
        title: String(s.title ?? ""),
        summary: String(s.summary ?? ""),
      }))
    : [];
  const frontmatter =
    isRecord(args.frontmatter) && typeof args.frontmatter.type === "string" && typeof args.frontmatter.topic === "string"
      ? { type: args.frontmatter.type, topic: args.frontmatter.topic }
      : undefined;
  const quality =
    isRecord(args.quality) && typeof args.quality.complete === "boolean" && typeof args.quality.confidence === "number"
      ? {
          complete: args.quality.complete,
          confidence: args.quality.confidence,
          issues: asStringArray(args.quality.issues) ?? [],
          action: args.quality.action === "review_required" ? ("review_required" as const) : ("auto_accept" as const),
        }
      : undefined;

  if (!frontmatter || !quality) {
    throw new Error("refine_document: output does not match the delta contract (frontmatter/quality missing)");
  }

  return {
    summary,
    sections,
    frontmatter,
    entities: normalizeEntityList(args.entities),
    relations: normalizeRelationList(args.relations),
    keywords: asStringArray(args.keywords) ?? [],
    quality,
    patches: normalizePatchList(args.patches),
  };
}

/**
 * Assemble the full `RefinedDocument` from the ORIGINAL markdown + the LLM delta (G4.S8.T1). Athena
 * rebuilds `markdown` LOCALLY by applying the (optional) patches to the original text — zero LLM
 * information re-generation — and builds the `chunks` LOCALLY via `splitParagraphSemantic`. The
 * original already carries the stage-1 header re-level (two-stage) or is the untouched full doc whose
 * header corrections arrive as refactor_heading patches (single-pass).
 */
export function buildRefinedDocument(markdown: string, delta: RefinedDocumentDelta): RefinedDocument {
  const mdFinal = applyPatches(markdown, delta.patches ?? []);
  return {
    markdown: mdFinal,
    summary: delta.summary,
    sections: delta.sections,
    frontmatter: delta.frontmatter,
    chunks: splitParagraphSemantic(mdFinal),
    entities: delta.entities,
    relations: delta.relations,
    keywords: delta.keywords,
    quality: delta.quality,
  };
}

/**
 * Extract the structured DELTA refinement from the assistant response (emit tool or plain-text JSON)
 * — no full markdown/chunks required. Throws when neither yields a usable delta.
 */
export function extractRefinementDelta(message: AssistantMessageLike): RefinedDocumentDelta {
  for (const part of message.content ?? []) {
    if (isEmitToolCall(part)) {
      return normalizeRefinementDelta(part.arguments);
    }
  }
  const text = (message.content ?? [])
    .filter((part): part is AssistantTextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (text) {
    const parsed = tryParseNestedJson(text);
    if (parsed !== undefined) {
      return normalizeRefinementDelta(parsed);
    }
  }
  throw new Error("refine_document: assistant returned no structured output");
}

/** First non-heading paragraph of a markdown, whitespace-collapsed (fallback summary source). */
function firstParagraph(markdown: string, maxChars: number): string {
  const text =
    markdown
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p.length > 0 && !/^#{1,6}\s+/.test(p)) ?? "";
  return text.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

/** Deterministic zero-cost fallback summary: the first content paragraph (no LLM). */
function deriveFallbackSummary(markdown: string): string {
  return firstParagraph(markdown, 240);
}

/** Deterministic zero-cost fallback section summaries: one per top-level H1 (h2 fallback). */
function deriveFallbackSections(markdown: string): RefinementSectionSummary[] {
  return splitByRefinedH1(markdown)
    .map((section) => ({
      title: section.heading_path,
      summary: firstParagraph(section.markdown, 200),
    }))
    .filter((s) => s.title.length > 0);
}

/** Fallback refinement when the LLM pass fails — never worse than the raw docling output (G4.S1 Spec). */
export function fallbackRefinement(markdown: string, topicHint: string | undefined, error: unknown): RefinedDocument {
  const message = error instanceof Error ? error.message : String(error);
  return {
    markdown,
    summary: deriveFallbackSummary(markdown),
    sections: deriveFallbackSections(markdown),
    frontmatter: { type: "document", topic: topicHint ?? "unclassified" },
    chunks: [],
    entities: [],
    relations: [],
    keywords: [],
    quality: {
      complete: false,
      confidence: 0,
      issues: [`refine_document LLM pass failed: ${message}`],
      action: "review_required",
    },
  };
}

// --- T3 two-stage refinement: stage-1 header re-level (LOCAL) + stage-2 per-section + global merge ---

/** Stage-1 system prompt — judge header levels from local context (header text + a few paragraphs). */
export const HEADER_RELEVEL_SYSTEM_PROMPT = `You re-level markdown headings for the Athena refinement pipeline.
docling often emits a FLAT hierarchy (e.g. everything is h2). Given a batch of headings, each with a short
body excerpt, assign every heading its correct semantic level:
  1 = document title (the single top heading)
  2 = major section
  3 = subsection
Judge from the heading text + the excerpt only — you do NOT see the full document. Emit EVERY index via the
emit_header_levels tool. If uncertain, keep level 2.`;

/** Build the stage-1 prompt for one batch of headers (tens of KB/call, ~30-50 headers). */
export function buildHeaderJudgePrompt(batch: HeaderBlock[]): string {
  const entries = batch
    .map(
      (b) =>
        `[index ${b.index}] (current level ${b.level}) Heading: "${b.text}"\nBody excerpt:\n${b.body.slice(0, 500)}`,
    )
    .join("\n\n");
  return `Re-level the following ${batch.length} headings. Emit a level for EVERY index.\n\n${entries}`;
}

/** Global-merge system prompt — final type/topic + dedup of the per-section extractions. */
export const GLOBAL_MERGE_SYSTEM_PROMPT = `You are the global merge pass of the Athena TWO-STAGE document
refinement. A large document was refined section-by-section; each section produced its own extraction
(frontmatter, entities, relations, keywords, quality and section summary). You merge ONLY these
extraction fields — you never re-emit the document markdown or its chunks (those are already rebuilt
locally by Athena). Produce the FINAL single-document view:
  - summary: a FILE-LEVEL summary of ~2-3 sentences for the whole document.
  - sections: ONE entry per top-level H1 section — title = the H1 heading text (verbatim), summary =
    a concise 1-2 sentence summary. Merge/dedupe the per-section summaries.
  - frontmatter: ONE type + ONE hierarchical topic for the whole document (docs/taxonomy.md).
  - entities: deduplicated with consistent TITLE-CASE naming (one canonical form per entity).
    Preserve each entity's bilingual (DE+EN) aliases for RAG retrieval.
  - relations: deduplicated binary edges whose source/target match an emitted entity.
  - keywords: unified relationship + query keywords.
  - quality: the overall completeness/confidence and a single action (auto_accept | review_required).
Never invent entities or relations that are not present in the merged list. Emit via the
emit_global_refinement tool.`;

/**
 * Build the global-merge prompt from the mechanically merged per-section extractions. Merges ONLY the
 * extraction fields (section summaries with their titles, entities, relations, keywords, quality) —
 * never the markdown, which is rebuilt locally (G4.S8.T1).
 */
export function buildGlobalMergePrompt(
  merged: RefinedDocument,
  topicHint: string | undefined,
  sectionCount: number,
): string {
  const sectionTitles = (merged.sections ?? []).slice(0, 200).map((s) => s.title).filter(Boolean).join("\n");
  return `The document was refined in ${sectionCount} section(s). Here is the merged extraction.\n\n${
    topicHint ? `Topic hint from the operator: ${topicHint}\n\n` : ""
  }Section titles:\n${sectionTitles || "(none)"}\n\nMerged section summaries:\n${JSON.stringify(merged.sections)}\n\nMerged entities:\n${JSON.stringify(merged.entities, null, 2)}\n\nMerged relations:\n${JSON.stringify(merged.relations, null, 2)}\n\nMerged keywords:\n${JSON.stringify(merged.keywords)}\n\nMerged quality:\n${JSON.stringify(merged.quality)}\n\nEmit the final global view via emit_global_refinement.`;
}

/** Extract the per-header corrected levels from a stage-1 assistant response (emit tool or text JSON). */
export function extractHeaderLevels(message: AssistantMessageLike): Map<number, number> {
  const map = new Map<number, number>();
  const visit = (raw: unknown): void => {
    const levels = (raw as { levels?: unknown })?.levels;
    if (Array.isArray(levels)) {
      for (const item of levels) {
        if (!item || typeof item !== "object") continue;
        const { index, level } = item as { index?: unknown; level?: unknown };
        if (typeof index === "number" && typeof level === "number") {
          map.set(index, clampHeaderLevel(level));
        }
      }
    }
  };
  for (const part of message.content ?? []) {
    if (part.type === "toolCall" && (part as AssistantToolCallPart).name === EMIT_HEADER_LEVELS_TOOL) {
      visit((part as AssistantToolCallPart).arguments);
    }
  }
  const text = (message.content ?? [])
    .filter((part): part is AssistantTextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (text) {
    try {
      visit(JSON.parse(text));
    } catch {
      // ignore malformed stage-1 text — caller falls back to original levels
    }
  }
  return map;
}

/** Extract the global-view slice from a global-merge response; undefined when nothing usable. */
export function extractGlobalMerge(message: AssistantMessageLike): GlobalRefinement | undefined {
  const raw = (() => {
    for (const part of message.content ?? []) {
      if (part.type === "toolCall" && (part as AssistantToolCallPart).name === EMIT_GLOBAL_REFINEMENT_TOOL) {
        return (part as AssistantToolCallPart).arguments;
      }
    }
    const text = (message.content ?? [])
      .filter((part): part is AssistantTextPart => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  })();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const args = raw as Record<string, unknown>;
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const asStringArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.every((item) => typeof item === "string") ? v : undefined;

  const frontmatter =
    isRecord(args.frontmatter) && typeof args.frontmatter.type === "string" && typeof args.frontmatter.topic === "string"
      ? { type: args.frontmatter.type, topic: args.frontmatter.topic }
      : undefined;
  const entities = Array.isArray(args.entities)
    ? args.entities.filter(isRecord).map((e) => ({
        name: String(e.name ?? ""),
        type: String(e.type ?? "other"),
        description: String(e.description ?? ""),
        aliases: asStringArray(e.aliases) ?? [],
      }))
    : [];
  const relations = Array.isArray(args.relations)
    ? args.relations.filter(isRecord).map((r) => ({
        source: String(r.source ?? ""),
        target: String(r.target ?? ""),
        keywords: asStringArray(r.keywords) ?? [],
        description: String(r.description ?? ""),
      }))
    : [];
  const keywords = asStringArray(args.keywords) ?? [];
  const summary = typeof args.summary === "string" ? args.summary : undefined;
  const sections = Array.isArray(args.sections)
    ? args.sections.filter(isRecord).map((s) => ({
        title: String(s.title ?? ""),
        summary: String(s.summary ?? ""),
      }))
    : [];
  const quality =
    isRecord(args.quality) && typeof args.quality.complete === "boolean" && typeof args.quality.confidence === "number"
      ? {
          complete: args.quality.complete,
          confidence: args.quality.confidence,
          issues: asStringArray(args.quality.issues) ?? [],
          action: args.quality.action === "review_required" ? ("review_required" as const) : ("auto_accept" as const),
        }
      : undefined;
  if (
    !frontmatter &&
    entities.length === 0 &&
    relations.length === 0 &&
    keywords.length === 0 &&
    summary === undefined &&
    sections.length === 0 &&
    !quality
  ) {
    return undefined;
  }
  return { frontmatter, entities, relations, keywords, summary, sections, quality };
}

/** Stage-1 production implementation: judge header levels in batches (LOCAL, no full doc). */
export async function judgeHeaderLevelsLLM(
  modelRuntime: ModelRuntime,
  model: RefineModel,
  blocks: HeaderBlock[],
  options: Pick<RefineDocumentOptions, "thinkingLevel" | "headerBatchSize" | "systemPrompt"> = {},
): Promise<HeaderBlock[]> {
  const batchSize = options.headerBatchSize ?? HEADER_RELEVEL_BATCH_SIZE;
  const batches = batchHeaderBlocks(blocks, batchSize);
  const corrected: HeaderBlock[] = [];
  for (const batch of batches) {
    let levels = new Map<number, number>();
    try {
      const assistant = await modelRuntime.completeSimple(
        model,
        {
          systemPrompt: options.systemPrompt ?? HEADER_RELEVEL_SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildHeaderJudgePrompt(batch), timestamp: Date.now() }],
          tools: [
            {
              name: EMIT_HEADER_LEVELS_TOOL,
              description: "Emit the corrected heading level per header index.",
              parameters: HEADER_LEVELS_SCHEMA,
              constrainedSampling: { type: "json_schema", strict: "require" },
            },
          ],
        },
        { reasoning: options.thinkingLevel ?? "max" },
      );
      levels = extractHeaderLevels(assistant);
    } catch {
      // never worse: a failed batch keeps its original levels
    }
    for (const block of batch) {
      corrected.push({ ...block, level: levels.get(block.index) ?? block.level });
    }
  }
  return corrected;
}

/**
 * T3 two-stage refinement for >1MB docs (G4.S1 Spec):
 *   Stage 1 — local header re-level (batched, header text + a few following paragraphs).
 *   Stage 2 — split by the refined h1 boundary into semantically-complete sections (<1MB each), then
 *             per-section full pass (chunk + entity + keyword + type/topic), then one global merge pass.
 * NOTE: chunked refinement loses cross-section entity/relation correlation — single-read is preferred
 * sub-1MB (see refineDocumentWithRouting).
 */
export async function refineLargeDocument(
  markdown: string,
  stages: LargeRefineStages,
  topicHint?: string,
): Promise<LargeRefineResult> {
  const { preamble, blocks } = splitByHeaders(markdown);
  const releveled = await stages.judgeHeaderLevels(blocks);
  const md = rebuildMarkdown(preamble, releveled);
  const sections = enforceSectionSize(splitByRefinedH1(md));
  const refinements: RefinedDocument[] = [];
  for (const section of sections) {
    refinements.push(await stages.refineSection(section, topicHint));
  }
  const document = await stages.globalMerge(refinements, topicHint);
  return { document, sections: sections.map((section) => section.heading_path) };
}

export interface LargeRefineStages {
  judgeHeaderLevels: (blocks: HeaderBlock[]) => Promise<HeaderBlock[]>;
  refineSection: (section: MarkdownSection, topicHint?: string) => Promise<RefinedDocument>;
  globalMerge: (refinements: RefinedDocument[], topicHint?: string) => Promise<RefinedDocument>;
}

export interface LargeRefineResult {
  document: RefinedDocument;
  /** h1 section heading paths produced by the two-stage split. */
  sections: string[];
}

/**
 * Run the single full-doc refinement LLM pass (sub-1MB path and the stage-2 per-section path).
 * Returns the refined document + the raw assistant (for usage reporting).
 *
 * G4.S8.T1 delta contract: the LLM emits EXTRACTION fields + optional `patches` only (never the full
 * re-leveled markdown or chunk texts). Athena rebuilds `markdown` and `chunks` LOCALLY via
 * `buildRefinedDocument` (applyPatches + splitParagraphSemantic), so output budget stays ~1-5K tokens
 * per call even on the largest docs — no truncation class of failure.
 *
 * G4.S2.T8: re-prompts up to 3 times (default) before giving up — a transient "no structured
 * output" on a long/image-heavy doc usually succeeds on an early retry, avoiding the fallback.
 * The retry nudge re-asserts the emit tool call.
 */
async function runRefinePass(
  modelRuntime: ModelRuntime,
  model: RefineModel,
  markdown: string,
  topicHint: string | undefined,
  options: Pick<RefineDocumentOptions, "thinkingLevel" | "systemPrompt" | "retries">,
): Promise<{ document: RefinedDocument; assistant: AssistantMessageLike; retries: number }> {
  const retries = options.retries ?? 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const userContent =
        attempt === 1
          ? markdown
          : `${markdown}\n\n[retry ${attempt - 1}] Your previous response was not usable. Respond with ONLY the emit_refined_document tool call carrying the extraction fields + optional patches. Do NOT re-emit the markdown.`;
      const assistant = await modelRuntime.completeSimple(
        model,
        {
          systemPrompt: options.systemPrompt ?? buildRefineSystemPrompt(topicHint),
          messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
          tools: [emitRefinedDocumentTool()],
        },
        { reasoning: options.thinkingLevel ?? "max" },
      );
      const delta = extractRefinementDelta(assistant);
      return { document: buildRefinedDocument(markdown, delta), assistant, retries: attempt - 1 };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function emitRefinedDocumentTool() {
  return {
    name: EMIT_REFINED_DOCUMENT_TOOL,
    description:
      "Emit the DELTA refinement contract: extraction fields (summary/sections/frontmatter/entities/relations/keywords/quality) + an optional `patches` array. NEVER emit the markdown or chunk texts — Athena rebuilds them locally.",
    parameters: REFINED_DOCUMENT_SCHEMA,
    constrainedSampling: { type: "json_schema" as const, strict: "require" as const },
  };
}

/** Global-merge production implementation: final type/topic + dedup over the merged sections. */
async function runGlobalMerge(
  modelRuntime: ModelRuntime,
  model: RefineModel,
  refinements: RefinedDocument[],
  topicHint: string | undefined,
  options: Pick<RefineDocumentOptions, "thinkingLevel">,
): Promise<RefinedDocument> {
  const merged = mergeRefinements(refinements);
  try {
    const assistant = await modelRuntime.completeSimple(
      model,
      {
        systemPrompt: GLOBAL_MERGE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildGlobalMergePrompt(merged, topicHint, refinements.length), timestamp: Date.now() }],
        tools: [
          {
            name: EMIT_GLOBAL_REFINEMENT_TOOL,
            description:
              "Emit the final global document view (type/topic, deduped entities/relations/keywords, quality).",
            parameters: GLOBAL_MERGE_SCHEMA,
            constrainedSampling: { type: "json_schema", strict: "require" },
          },
        ],
      },
      { reasoning: options.thinkingLevel ?? "max" },
    );
    const global = extractGlobalMerge(assistant);
    if (!global) return merged;
    return {
      ...merged,
      summary: global.summary ?? merged.summary,
      sections: global.sections && global.sections.length > 0 ? global.sections : merged.sections,
      frontmatter: global.frontmatter ?? merged.frontmatter,
      entities: global.entities && global.entities.length > 0 ? global.entities : merged.entities,
      relations: global.relations && global.relations.length > 0 ? global.relations : merged.relations,
      keywords: global.keywords && global.keywords.length > 0 ? global.keywords : merged.keywords,
      quality: global.quality ?? merged.quality,
    };
  } catch {
    // never worse: keep the mechanically merged result
    return merged;
  }
}

/**
 * Create the `refine_document` Pi custom tool wired into the athena agent.
 *
 * The tool executes the Athena refinement LLM pass with constrained sampling on the output contract,
 * using the dedicated `athena` provider at thinkingLevel `high`, then STORES the full re-leveled
 * markdown + chunks on disk (pi-docparser big-output pattern, T3) and returns only the SMALL metadata
 * + refs (frontmatter/entities/keywords/quality/md_ref/preview). >1MB docs take the two-stage path.
 */
export function createRefineDocumentTool(
  modelRuntime: ModelRuntime,
  options: RefineDocumentOptions = {},
): RefineDocumentTool {
  const providerId = options.providerId ?? ATHENA_PROVIDER;
  const modelId = options.modelId ?? ATHENA_MODEL;
  const thinkingLevel = options.thinkingLevel ?? "max";
  const storageDir = options.storageDir ?? defaultRefinementOutputDir();
  const store = options.storeImpl ?? storeRefinementOutput;

  const tool: ToolDefinition = {
    name: "refine_document",
    label: "Refine Document (Athena)",
    description:
      "Run the Athena full-document refinement pass on docling markdown: re-level headers, classify " +
      "type/topic, chunk, extract entities/relations/keywords and quality-check. The full re-leveled " +
      "markdown + chunks land on disk/storage; returns only the small metadata + refs (pi-docparser " +
      "pattern). >1MB docs use the two-stage path (local header re-level → h1 split → per-section).",
    promptGuidelines: [
      "Use for the ingest refinement step: pass the raw docling markdown, get the small refinement ref back (md_ref to the full re-leveled markdown + chunks on disk).",
      "Uses the dedicated athena OpenRouter provider (independent key/cost) with deepseek-v4-flash-latest at thinkingLevel high.",
      "Sub-1MB docs are refined in ONE full-doc read; >1MB docs use two-stage refinement (local header pass → split → per-section pass).",
    ],
    parameters: Type.Object({
      markdown: Type.String(),
      topic_hint: Type.Optional(Type.String()),
    }),
    executionMode: "sequential",
    async execute(
      _toolCallId: string,
      params: RefineDocumentParams,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      _ctx?: unknown,
    ) {
      const model = modelRuntime.getModel(providerId, modelId);
      if (!model) {
        throw new Error(
          `refine_document: model ${providerId}/${modelId} not found. Check ~/.pi/agent/auth.json and models.json.`,
        );
      }

      const mode: RefinementMode = isLargeMarkdown(params.markdown) ? "two-stage" : "single";
      // G4.S1.T6 two-file design: File A = full docling md (image refs + VLM descriptions) for
      // llm_wiki display; File B = image-ref lines stripped (text + VLM descriptions only) fed to
      // the refinement LLM + RAG. Refinement reads text only — image refs are noise that made the
      // constrained-sampling output unstable.
      const originalMarkdown = params.markdown;
      const textMarkdown = stripImageRefs(originalMarkdown);
      const imageRefsStripped = textMarkdown !== originalMarkdown;
      const emitDetails = { provider: providerId, model: modelId, mode, imageRefsStripped };
      let usage: unknown;
      let retries = 0;

      try {
        let document: RefinedDocument;
        let sectionPaths: string[] = [];
        if (mode === "two-stage") {
          const result = await refineLargeDocument(
            textMarkdown,
            {
              judgeHeaderLevels:
                options.judgeHeaderLevelsImpl ??
                ((blocks) => judgeHeaderLevelsLLM(modelRuntime, model, blocks, options)),
              refineSection:
                options.refineSectionImpl ??
                (async (section, hint) => (await runRefinePass(modelRuntime, model, section.markdown, hint, options)).document),
              globalMerge:
                options.globalMergeImpl ??
                ((refinements, hint) => runGlobalMerge(modelRuntime, model, refinements, hint, options)),
            },
            params.topic_hint,
          );
          document = result.document;
          sectionPaths = result.sections;
        } else {
          const single = await runRefinePass(modelRuntime, model, textMarkdown, params.topic_hint, options);
          document = single.document;
          usage = single.assistant.usage;
          retries = single.retries;
        }
        // File B = refined text-only markdown (RAG working copy). Sync the header re-level back
        // onto File A (keeping its image refs) → File A′ (durable, llm_wiki).
        const ragMarkdown = document.markdown;
        const fileAPrime = syncRefinedHeadersToSource(originalMarkdown, ragMarkdown);
        const ref = await store({ ...document, markdown: fileAPrime }, storageDir, {
          stem: deriveStem(fileAPrime),
          mode,
          section_paths: sectionPaths,
          ...(imageRefsStripped ? { ragMarkdown } : {}),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(ref) }],
          details: { ...emitDetails, usage, retries },
        };
      } catch (err) {
        const fallback = fallbackRefinement(originalMarkdown, params.topic_hint, err);
        const fallbackRag = stripImageRefs(originalMarkdown);
        const ref = await store(fallback, storageDir, {
          stem: deriveStem(fallback.markdown),
          mode,
          ...(fallbackRag !== fallback.markdown ? { ragMarkdown: fallbackRag } : {}),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(ref) }],
          details: {
            ...emitDetails,
            fallback: true,
            error: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
  };

  return tool as RefineDocumentTool;
}

// --- G4.S3.T10: incremental wiki-edit refine mode ---
//
// NOT the full `refine_document` (raw docling) pass. Input = the corrected wiki
// markdown (ragMarkdown form — image refs stripped, VLM alt-text kept) + the
// minimal diff of what the user changed. Athena PRESERVES the corrected text
// verbatim, detects NEW entities/relations the correction introduces, re-derives
// the full chunks/entities/relations for the corrected doc and decides whether
// re-chunking is required (localized edit vs structural change).

/** Name of the constrained emit tool for the wiki-edit incremental refine. */
export const EMIT_WIKI_EDIT_REFINE_TOOL = "emit_wiki_edit_refinement";

export interface WikiEditRefineInput {
  /** Corrected page BODY in ragMarkdown form — the SOURCE OF TRUTH (preserve verbatim). */
  markdown: string;
  /** Previous page BODY in the same ragMarkdown form. */
  before: string;
  /** Minimal unified diff text (before → after). */
  diff: string;
  /** Whether the diff touched heading structure (forces a re-chunk decision). */
  structural: boolean;
}

/** The incremental wiki-edit refinement output contract: RefinedDocument + what the edit introduced. */
export interface WikiEditRefinement extends RefinedDocument {
  /** Entities the correction introduced (each is a member of `entities`). */
  new_entities: RefinementEntity[];
  /** Relations the correction introduced (each is a member of `relations`). */
  new_relations: RefinementRelation[];
  /** Whether the model decided re-chunking was required (structural/large edit). */
  rechunked: boolean;
}

/** JSON schema (TypeBox) of the wiki-edit refine output — constrained emit tool params. */
export const WIKI_EDIT_REFINE_SCHEMA = Type.Object({
  markdown: Type.String(),
  summary: Type.String(),
  sections: Type.Array(
    Type.Object({
      title: Type.String(),
      summary: Type.String(),
    }),
  ),
  frontmatter: Type.Object({
    type: Type.String(),
    topic: Type.String(),
  }),
  chunks: Type.Array(
    Type.Object({
      id: Type.String(),
      text: Type.String(),
      heading_path: Type.String(),
    }),
  ),
  entities: Type.Array(
    Type.Object({
      name: Type.String(),
      type: Type.String(),
      description: Type.String(),
      aliases: Type.Optional(Type.Array(Type.String())),
    }),
  ),
  relations: Type.Array(
    Type.Object({
      source: Type.String(),
      target: Type.String(),
      keywords: Type.Array(Type.String()),
      description: Type.String(),
    }),
  ),
  keywords: Type.Array(Type.String()),
  new_entities: Type.Array(
    Type.Object({
      name: Type.String(),
      type: Type.String(),
      description: Type.String(),
      aliases: Type.Optional(Type.Array(Type.String())),
    }),
  ),
  new_relations: Type.Array(
    Type.Object({
      source: Type.String(),
      target: Type.String(),
      keywords: Type.Array(Type.String()),
      description: Type.String(),
    }),
  ),
  rechunked: Type.Boolean(),
  quality: Type.Object({
    complete: Type.Boolean(),
    confidence: Type.Number(),
    issues: Type.Array(Type.String()),
    action: Type.Union([Type.Literal("auto_accept"), Type.Literal("review_required")]),
  }),
});

/** The incremental wiki-edit refine system prompt (G4.S3.T10). */
export const WIKI_EDIT_REFINE_SYSTEM_PROMPT = `You are Athena, the INCREMENTAL wiki-edit refine pass of the athena KB (G4.S3.T10).

A user manually corrected a wiki page — typically fixing a VLM/OCR mis-description in an image
description. You are NOT re-refining raw docling output; the input is the already-refined wiki plus
the exact diff of the user's correction.

You receive (in the user message):
  - CORRECTED markdown — the user's edit is the SOURCE OF TRUTH;
  - the PREVIOUS version of the page;
  - the DIFF showing exactly what changed (before -> after);
  - whether the change was STRUCTURAL (headings added/removed/renamed).

RULES:
1. PRESERVE THE USER'S EDIT. Emit the corrected markdown VERBATIM. NEVER rewrite, rephrase,
   reformat, "improve" or "correct" the user's corrected text — not a single word.
2. The correction is INTENTIONAL. Do NOT "fix it back" to the previous version.
3. Compare before vs after using the DIFF. Detect every NEW entity and NEW relation the correction
   introduces and list them in new_entities / new_relations (each must ALSO appear in the full
   entities / relations list of the corrected document).
4. Re-derive the corrected document's FULL entities, relations, keywords and chunks.
   - A LOCALIZED edit inside one section: keep the existing chunk boundaries, re-emit the chunks with
     the corrected text substituted, and set rechunked=false.
   - A STRUCTURAL change (heading added/removed/renamed) or a large rewrite: re-chunk the affected
     region(s) and set rechunked=true.
5. Reuse the existing type/topic when the edit did not change the document's classification.
6. Quality-check the corrected document as usual (completeness, confidence, issues, action).

Emit the COMPLETE corrected document via the emit_wiki_edit_refinement tool — do not truncate.`;

/** Build the user prompt for the incremental wiki-edit refine pass. */
export function buildWikiEditRefinePrompt(
  input: WikiEditRefineInput,
  existing: { type?: string; topic?: string } | undefined,
  attempt = 1,
): string {
  const retryNudge =
    attempt === 1
      ? ""
      : `\n\n[retry ${attempt - 1}] Your previous response was not usable. Respond with ONLY the emit_wiki_edit_refinement tool call carrying the COMPLETE corrected document.`;
  return `A user corrected this wiki page. The CORRECTED markdown is the source of truth — preserve it VERBATIM.

## CORRECTED markdown (preserve verbatim)
${input.markdown}

## PREVIOUS version
${input.before || "(empty page)"}

## DIFF (exactly what the user changed)
${input.diff || "(no textual change detected)"}

## Edit metadata
- structural (heading structure changed): ${String(input.structural)}
${existing?.type ? `- existing type: ${existing.type}` : ""}
${existing?.topic ? `- existing topic: ${existing.topic}` : ""}

Emit the corrected markdown VERBATIM, the re-derived chunks/entities/relations/keywords, the NEW
entities/relations the correction introduced (new_entities/new_relations), whether re-chunking was
required (rechunked), and the quality check.${retryNudge}`;
}

/** Coerce a parsed wiki-edit refine payload into the contract (JSON-string args accepted). */
export function normalizeWikiEditRefinement(raw: unknown): WikiEditRefinement {
  const args: Record<string, unknown> =
    typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : ((raw ?? {}) as Record<string, unknown>);
  const base = normalizeRefinedDocument(args);
  return {
    ...base,
    new_entities: normalizeEntityList(args.new_entities),
    new_relations: normalizeRelationList(args.new_relations),
    rechunked: args.rechunked === true,
  };
}

/** Extract the structured wiki-edit refinement from an assistant response (emit tool or text JSON). */
export function extractWikiEditRefinement(message: AssistantMessageLike): WikiEditRefinement {
  for (const part of message.content ?? []) {
    if (
      part.type === "toolCall" &&
      (part as AssistantToolCallPart).name === EMIT_WIKI_EDIT_REFINE_TOOL &&
      "arguments" in part
    ) {
      return normalizeWikiEditRefinement((part as AssistantToolCallPart).arguments);
    }
  }
  const text = (message.content ?? [])
    .filter((part): part is AssistantTextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (text) {
    const parsed = tryParseNestedJson(text);
    if (parsed !== undefined) {
      return normalizeWikiEditRefinement(parsed);
    }
  }
  throw new Error("wiki edit refine: assistant returned no structured output");
}

/** Mechanical fallback chunker: one chunk per top-level section of the corrected body. */
export function mechanicalWikiEditChunks(markdown: string): RefinementChunk[] {
  return splitByRefinedH1(markdown)
    .map((section, index) => ({
      id: `c${index + 1}`,
      text: section.markdown.trim(),
      heading_path: section.heading_path,
    }))
    .filter((chunk) => chunk.text.length > 0);
}

/**
 * Fallback for a failed wiki-edit refine — never worse than no refine: the
 * corrected text is kept verbatim, chunks come from the (unchanged) heading
 * structure, entities/relations are not fabricated, and the task is flagged
 * review_required so an operator knows the graph was not re-derived.
 */
export function fallbackWikiEditRefinement(
  input: WikiEditRefineInput,
  existing: { type?: string; topic?: string } | undefined,
  error: unknown,
): WikiEditRefinement {
  const message = error instanceof Error ? error.message : String(error);
  return {
    markdown: input.markdown,
    summary: deriveFallbackSummary(input.markdown),
    sections: deriveFallbackSections(input.markdown),
    frontmatter: { type: existing?.type ?? "document", topic: existing?.topic ?? "unclassified" },
    chunks: mechanicalWikiEditChunks(input.markdown),
    entities: [],
    relations: [],
    keywords: [],
    new_entities: [],
    new_relations: [],
    // A structural edit always re-chunks; a localized edit keeps the structure.
    rechunked: input.structural,
    quality: {
      complete: false,
      confidence: 0,
      issues: [`wiki edit refine LLM pass failed: ${message}`],
      action: "review_required",
    },
  };
}

function emitWikiEditRefinementTool() {
  return {
    name: EMIT_WIKI_EDIT_REFINE_TOOL,
    description:
      "Emit the incremental wiki-edit refinement as a single structured JSON value matching the wiki-edit refine contract.",
    parameters: WIKI_EDIT_REFINE_SCHEMA,
    constrainedSampling: { type: "json_schema" as const, strict: "require" as const },
  };
}

export interface WikiEditRefineOptions {
  /** Reasoning level for the incremental pass (default "high"). */
  thinkingLevel?: AthenaThinkingLevel;
  /** Override the wiki-edit refine system prompt. */
  systemPrompt?: string;
  /** Retries before giving up (default 3 — up to 4 attempts). */
  retries?: number;
}

/**
 * Run the incremental wiki-edit refine LLM pass: input = corrected markdown +
 * the diff. Preserves the corrected text (contract-enforced via the emit tool),
 * re-derives the full structure and flags new entities/relations. Retries on a
 * transient non-structured output; throws on persistent failure (caller falls
 * back to `fallbackWikiEditRefinement`).
 */
export async function runWikiEditRefine(
  modelRuntime: ModelRuntime,
  model: RefineModel,
  input: WikiEditRefineInput,
  existing?: { type?: string; topic?: string },
  options: WikiEditRefineOptions = {},
): Promise<{ document: WikiEditRefinement; retries: number }> {
  const retries = options.retries ?? 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      const assistant = await modelRuntime.completeSimple(
        model,
        {
          systemPrompt: options.systemPrompt ?? WIKI_EDIT_REFINE_SYSTEM_PROMPT,
          messages: [
            { role: "user", content: buildWikiEditRefinePrompt(input, existing, attempt), timestamp: Date.now() },
          ],
          tools: [emitWikiEditRefinementTool()],
        },
        { reasoning: options.thinkingLevel ?? "max" },
      );
      return { document: extractWikiEditRefinement(assistant), retries: attempt - 1 };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
