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
 * (frontmatter/entities/keywords/quality/md_ref/preview — pi-docparser pattern). >1MB docs use the
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
  storeRefinementOutput,
  stripImageRefs,
  syncRefinedHeadersToSource,
  type HeaderBlock,
  type MarkdownSection,
  type RefineOutputRef,
  type RefinementMode,
} from "./refine-output.js";

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

export interface RefinedDocument {
  markdown: string;
  frontmatter: RefinementFrontmatter;
  chunks: RefinementChunk[];
  entities: RefinementEntity[];
  relations: RefinementRelation[];
  keywords: string[];
  quality: RefinementQuality;
}

/** JSON schema (TypeBox) of the refinement output contract, used as the constrained emit tool params. */
export const REFINED_DOCUMENT_SCHEMA = Type.Object({
  markdown: Type.String(),
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
  quality: Type.Object({
    complete: Type.Boolean(),
    confidence: Type.Number(),
    issues: Type.Array(Type.String()),
    action: Type.Union([Type.Literal("auto_accept"), Type.Literal("review_required")]),
  }),
});

/** Stage-1 emit schema: corrected heading level per header index (T3 two-stage). */
export const HEADER_LEVELS_SCHEMA = Type.Object({
  levels: Type.Array(Type.Object({ index: Type.Number(), level: Type.Number() })),
});

/** Global-merge emit schema: the final single-document view (type/topic + deduped extraction). */
export const GLOBAL_MERGE_SCHEMA = Type.Object({
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
  /** Provider id (default "athena" — dedicated OpenRouter provider, independent key). */
  providerId?: string;
  /** Model id within the provider (default "~deepseek/deepseek-v4-flash-latest"). */
  modelId?: string;
  /** Reasoning level for the refinement pass (default "high" — header re-leveling needs it). */
  thinkingLevel?: AthenaThinkingLevel;
  /** Retries before giving up to fallbackRefinement (default 1 — re-prompt once, G4.S1.T6). */
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
  options?: { stem?: string; mode?: RefinementMode; sections?: string[] },
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
markdown once and emit everything downstream needs — re-leveled markdown, frontmatter(type+topic),
chunks, entities, relations, keywords, quality — in ONE read. No other LLM re-reads the document.

## 1. Header re-level (semantic hierarchy)
Restore a semantic # / ## / ### hierarchy from document structure, not the raw docling levels.
docling often emits FLAT headers (e.g. everything is h2 — a Sommerseminar doc came out with 16x h2).
Decide levels by section meaning: exactly one # title, ## major sections, ### subsections. Promote or
demote so the tree is coherent. Do NOT invent heading levels that the document does not imply.

## 2. Classification (type + topic) — from docs/taxonomy.md
Pick EXACTLY ONE type and ONE hierarchical topic per the CALEO taxonomy (docs/taxonomy.md is
authoritative; the criteria below are embedded for you).

${TYPE_CRITERIA_PROMPT}

${TOPIC_TREE_PROMPT}

## 3. Chunking (paragraph-semantic)
Segment the re-leveled markdown into paragraph-semantic chunks (~1200 tokens, ~100 token overlap —
LightRAG paragraph_semantic style). Prefer whole paragraphs / semantically complete sections over fixed
token windows. Each chunk: stable id ("c1", "c2", ...), its text, and heading_path = the heading path
of the section it belongs to (e.g. "Sommerseminar / Workshops") so downstream knows the context.

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
meaningful relations (GraphRAG/LightRAG best practice) — skip speculative ones.

## 6. Keywords (relationship + query)
Emit retrieval keywords: relationship keywords (edge vocabulary, e.g. "hosts", "part of") AND query
keywords, high-level + low-level (e.g. "sommerseminar", "schedule", "workshop").

## 7. Quality checklist
- completeness: did the refined markdown capture the whole source (all sections, tables, figures)?
- tables/figures: note any table split across pages or figure caption dropped.
- garbled text: flag OCR/layout garbage, encoding issues.
- confidence: 0..1 how sure you are.
- issues: concrete list (e.g. "table on p3 split", "image caption missing").
- action: auto_accept (clean) or review_required (any doubt).

## Output
Call the emit_refined_document tool with the COMPLETE refined document — its JSON schema constrains
your output. Emit the ENTIRE re-leveled markdown and every chunk; do not truncate.`;

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

  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const asStringArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.every((item) => typeof item === "string") ? v : undefined;

  const markdown = typeof args.markdown === "string" ? args.markdown : undefined;
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
        source: String(r.source ?? r.from ?? ""),
        target: String(r.target ?? r.to ?? ""),
        keywords: asStringArray(r.keywords) ?? [],
        description: String(r.description ?? ""),
      }))
    : [];
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

  return { markdown, frontmatter, chunks, entities, relations, keywords, quality };
}

/** Fallback refinement when the LLM pass fails — never worse than the raw docling output (G4.S1 Spec). */
export function fallbackRefinement(markdown: string, topicHint: string | undefined, error: unknown): RefinedDocument {
  const message = error instanceof Error ? error.message : String(error);
  return {
    markdown,
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
refinement. A large document was refined section-by-section; each section produced its own frontmatter,
entities, relations, keywords and quality. Produce the FINAL single-document view:
  - frontmatter: ONE type + ONE hierarchical topic for the whole document (docs/taxonomy.md).
  - entities: deduplicated with consistent TITLE-CASE naming (one canonical form per entity).
    Preserve each entity's bilingual (DE+EN) aliases for RAG retrieval.
  - relations: deduplicated binary edges whose source/target match an emitted entity.
  - keywords: unified relationship + query keywords.
  - quality: the overall completeness/confidence and a single action (auto_accept | review_required).
Never invent entities or relations that are not present in the merged list. Emit via the
emit_global_refinement tool.`;

/** Build the global-merge prompt from the mechanically merged per-section refinements. */
export function buildGlobalMergePrompt(
  merged: RefinedDocument,
  topicHint: string | undefined,
  sectionCount: number,
): string {
  const headings = merged.markdown
    .split(/\r?\n/)
    .filter((line) => /^#{1,6}\s+/.test(line))
    .slice(0, 200)
    .join("\n");
  return `The document was refined in ${sectionCount} section(s). Here is the merged extraction.\n\n${
    topicHint ? `Topic hint from the operator: ${topicHint}\n\n` : ""
  }Section headings:\n${headings || "(none)"}\n\nMerged entities:\n${JSON.stringify(merged.entities, null, 2)}\n\nMerged relations:\n${JSON.stringify(merged.relations, null, 2)}\n\nMerged keywords:\n${JSON.stringify(merged.keywords)}\n\nMerged quality:\n${JSON.stringify(merged.quality)}\n\nEmit the final global view via emit_global_refinement.`;
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
  const quality =
    isRecord(args.quality) && typeof args.quality.complete === "boolean" && typeof args.quality.confidence === "number"
      ? {
          complete: args.quality.complete,
          confidence: args.quality.confidence,
          issues: asStringArray(args.quality.issues) ?? [],
          action: args.quality.action === "review_required" ? ("review_required" as const) : ("auto_accept" as const),
        }
      : undefined;
  if (!frontmatter && entities.length === 0 && relations.length === 0 && keywords.length === 0 && !quality) {
    return undefined;
  }
  return { frontmatter, entities, relations, keywords, quality };
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
        { reasoning: options.thinkingLevel ?? "high" },
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
 * G4.S1.T6: re-prompts once (default) before giving up — a transient "no structured output"
 * on a long/image-heavy doc usually succeeds on the retry, avoiding the fallback. The retry
 * nudge re-asserts the emit tool call.
 */
async function runRefinePass(
  modelRuntime: ModelRuntime,
  model: RefineModel,
  markdown: string,
  topicHint: string | undefined,
  options: Pick<RefineDocumentOptions, "thinkingLevel" | "systemPrompt" | "retries">,
): Promise<{ document: RefinedDocument; assistant: AssistantMessageLike; retries: number }> {
  const retries = options.retries ?? 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const userContent =
        attempt === 1
          ? markdown
          : `${markdown}\n\n[retry ${attempt - 1}] Your previous response was not usable. Respond with ONLY the emit_refined_document tool call carrying the complete refined document.`;
      const assistant = await modelRuntime.completeSimple(
        model,
        {
          systemPrompt: options.systemPrompt ?? buildRefineSystemPrompt(topicHint),
          messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
          tools: [emitRefinedDocumentTool()],
        },
        { reasoning: options.thinkingLevel ?? "high" },
      );
      return { document: extractRefinedDocument(assistant), assistant, retries: attempt - 1 };
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
      "Emit the refined document as a single structured JSON value matching the refinement output contract.",
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
      { reasoning: options.thinkingLevel ?? "high" },
    );
    const global = extractGlobalMerge(assistant);
    if (!global) return merged;
    return {
      ...merged,
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
  const thinkingLevel = options.thinkingLevel ?? "high";
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
        let sections: string[] = [];
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
          sections = result.sections;
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
          sections,
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
