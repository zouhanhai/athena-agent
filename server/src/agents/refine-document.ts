/**
 * Athena document-refinement custom tool (G4.S1.T1).
 *
 * `refine_document` is a Pi custom tool (ToolDefinition) registered on the athena agent. It runs the
 * SINGLE full-document LLM pass of the ingest chain (G4.S1 Spec): given the docling markdown it re-levels
 * headers, classifies type/topic, chunks, extracts entities/relations/keywords and quality-checks the
 * document — all in one read.
 *
 * G4.S8.T2: the three refinement LLM calls (stage-1 header re-level, stage-2 per-section, global merge)
 * hit OpenRouter DIRECTLY (fetch, via `callOpenRouter` in llm-direct.ts) with `reasoning.effort = none`
 * (no thinking tokens), a hard timeout and retry/backoff — NOT Pi `ModelRuntime.completeSimple`, which
 * had no timeout and could silently hang a stalled provider forever. The dedicated `athena` OpenRouter
 * key (independent from chat) keeps key separation.
 *
 * Structured output is enforced with provider-side constrained sampling: the direct HTTP path requests a
 * JSON object whose shape IS the refinement output contract (json_schema wrapped response_format), so the
 * model cannot drift into free-text JSON. There are NO tools on the direct path — the model returns plain
 * JSON matching the contract.
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
import { TYPE_CRITERIA_PROMPT, TOPIC_TREE_PROMPT, DOC_TYPES } from "../kb/taxonomy.js";
import { callOpenRouter, resolveRefineModel, type OpenRouterCallParams } from "./llm-direct.js";
import { refineReasoningFor } from "./refine-reasoning.js";
import {
  HEADER_RELEVEL_BATCH_SIZE,
  applyPatches,
  applyPatchesWithReport,
  batchHeaderBlocks,
  clampHeaderLevel,
  completeHeaderHierarchy,
  deriveStemWithFileName,
  enforceSectionSize,
  hasImageRefs,
  hasSingleH1,
  isFlatHeaderMarkdown,
  isLargeMarkdown,
  mergeObjectiveDefectsIntoQuality,
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
  type PatchApplyReport,
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

/**
 * G4.S8.T2 — the direct-OpenRouter caller seam. The three refinement LLM calls (stage-1 header
 * re-level, stage-2 per-section, global merge) are single-shot constrained-output calls with NO
 * agent loop; they call OpenRouter directly (reasoning effort none, timeout + retry) instead of Pi
 * `ModelRuntime.completeSimple`, which had no timeout → silent-hang on a stalled provider.
 *
 * Returns the assistant message (parsed from the HTTP response text) + usage, so the existing
 * extractors (`extractHeaderLevels` / `extractRefinementDelta` / `extractGlobalMerge`) work unchanged.
 */
export type RefineLlmCaller = (
  params: {
    systemPrompt: string;
    userContent: string;
    schema?: unknown;
    maxTokens?: number;
    /** Model id sent to OpenRouter (default: env ATHENA_REFINE_MODEL / deepseek default). */
    model?: string;
    /**
     * G4.S8.T16 unified reasoning strategy: task-class effort from refineReasoningFor()
     * ("extraction" → none by default, "analysis" → thinking). Both transports derive it
     * from the SAME strategy function.
     */
    reasoningEffort?: "none" | "low" | "medium" | "high";
  },
) => Promise<{ message: AssistantMessageLike; usage?: unknown }>;

/** Default caller: wraps `callOpenRouter` (direct HTTP) and frames the returned text as a message. */
export function defaultRefineLlmCaller(): RefineLlmCaller {
  return async (params) => {
    const { text, usage } = await callOpenRouter(toCallParams(params));
    return {
      usage,
      message: { role: "assistant", content: [{ type: "text", text }] },
    };
  };
}

function toCallParams(params: Parameters<RefineLlmCaller>[0]): OpenRouterCallParams {
  return {
    systemPrompt: params.systemPrompt,
    userContent: params.userContent,
    schema: params.schema,
    maxTokens: params.maxTokens,
    model: params.model,
    reasoningEffort: params.reasoningEffort,
  };
}

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

/**
 * Paragraph-semantic chunk (~1200 tokens), carrying its re-leveled heading path.
 * G4.S8.T16 contextual enrichment: `context` is a ONE-LINE retrieval sentence composed
 * LOCALLY from the document summary + heading path ("<summary>; this section covers <path>")
 * — zero additional LLM calls — stored in chunks.json AND as a Chunk node property; the RAG
 * embed path prepends it to the embedded text.
 */
export interface RefinementChunk {
  id: string;
  text: string;
  heading_path: string;
  context?: string;
}

/**
 * Knowledge-graph node. `name` is title-case for consistent naming ("CALEO", not "caleo").
 * `aliases` are bilingual (DE+EN) variants of the SAME node (e.g. name "ZOB München" → aliases
 * ["Zentraler Omnibusbahnhof", "Munich central bus station"]) so RAG finds one node in both
 * languages. `name` is the document-language canonical form.
 *
 * G4.S8.T19: `occurrences` are 1-3 SHORT verbatim quotes (≤80 chars) from the source markdown
 * where the entity appears — emitted by the main refinement pass at extraction time so the
 * audit session can anchor each name to its real textual context without a blind re-read.
 */
export interface RefinementEntity {
  name: string;
  type: string;
  description: string;
  aliases?: string[];
  occurrences?: string[];
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
  /**
   * G4.S8.T16 anchored issues (T17 review-UX contract): each issue that references document
   * content carries the EXACT quoted passage — validated to be present (whitespace-normalized)
   * in the source markdown by `validateRefineDelta`, and highlighted in-place by T17's
   * WikiView annotations.
   */
  issue_anchors?: Array<{ message: string; quote: string }>;
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
  /** G4.S8.T16 instrumentation of the local patch cycle (absent when no patches were emitted). */
  patchReport?: PatchApplyReport;
}

/**
 * A minimal, location-addressed text-level edit the refinement LLM may OPTIONALLY propose (G4.S8.T1).
 * `index` refers to the 0-based block grid of the ORIGINAL markdown (headings + paragraphs in document
 * order). Heading ops target heading blocks; paragraph ops target paragraph blocks. Patches are the
 * ONLY text the model emits — Athena applies them LOCALLY to rebuild the final markdown, so the model
 * never re-emits the document text it already read.
 *
 * G4.S8.T16: heading ops additionally accept an optional `anchor` — the heading's CURRENT text. When
 * the ordinal index drifts (the Mallorca flat-header failure), Athena locates the target heading by
 * normalized anchor text; text anchors survive block-count drift, ordinals do not.
 */
export type RefinementPatch =
  | { op: "retitle_heading"; index: number; text: string; anchor?: string }
  | { op: "refactor_heading"; index: number; level: number; anchor?: string }
  | { op: "replace_paragraph"; index: number; text: string }
  | { op: "insert_paragraph"; index: number; text: string }
  | { op: "delete_paragraph"; index: number };

const PATCH_ONE_OF = Type.Union([
  Type.Object({
    op: Type.Literal("retitle_heading"),
    index: Type.Number(),
    text: Type.String(),
    anchor: Type.Optional(Type.String()),
  }),
  Type.Object({
    op: Type.Literal("refactor_heading"),
    index: Type.Number(),
    level: Type.Number(),
    anchor: Type.Optional(Type.String()),
  }),
  Type.Object({ op: Type.Literal("replace_paragraph"), index: Type.Number(), text: Type.String() }),
  Type.Object({ op: Type.Literal("insert_paragraph"), index: Type.Number(), text: Type.String() }),
  Type.Object({ op: Type.Literal("delete_paragraph"), index: Type.Number() }),
]);

/** Shared quality sub-schema (G4.S8.T16: optional anchored issues for T17). */
const QUALITY_SCHEMA = Type.Object({
  complete: Type.Boolean(),
  confidence: Type.Number(),
  issues: Type.Array(Type.String()),
  action: Type.Union([Type.Literal("auto_accept"), Type.Literal("review_required")]),
  issue_anchors: Type.Optional(
    Type.Array(
      Type.Object({
        message: Type.String(),
        quote: Type.String(),
      }),
    ),
  ),
});
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
      occurrences: Type.Optional(Type.Array(Type.String())),
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
  quality: QUALITY_SCHEMA,
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
  quality: QUALITY_SCHEMA,
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
  /**
   * G4.S8.T18 stem hardening: the upload file name. When the refined markdown
   * has no h1-derived slug, the storage stem derives from THIS name instead of
   * the generic "document" fallback — on every store path.
   */
  file_name?: string;
}

export interface RefineDocumentOptions {
  /** Model id sent to OpenRouter (default: env ATHENA_REFINE_MODEL or "~deepseek/deepseek-v4-flash-latest"). */
  modelId?: string;
  /**
   * Inject the direct-OpenRouter caller (tests stub the HTTP layer). Default: a wrapper over
   * `callOpenRouter` that parses the response text into the assistant message shape.
   */
  httpCaller?: RefineLlmCaller;
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
- refactor_heading { index, level, anchor } — change the block's heading level.
- retitle_heading { index, text, anchor } — change the heading text (only to fix a typo/OCR artifact).
Patch index (0-based) is the grid position of the block counting BOTH headings AND paragraphs in
document order. ALWAYS also set "anchor" to the heading's CURRENT text exactly as it appears in the
document: if your index drifts by even one paragraph, Athena locates the heading by its anchor text
instead — indices are unreliable, anchors are not.
Examples (grid = # T(0), intro para(1), ## A(2), body(3), ## B(4)):
  {"op":"refactor_heading","index":2,"level":3,"anchor":"A"}
  {"op":"refactor_heading","index":4,"level":1,"anchor":"B"}
Do NOT invent heading levels the document does not imply. Do NOT re-emit text to fix content —
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
- occurrences: 1-3 SHORT VERBATIM quotes (each ≤80 characters, copied character-for-character from
  the markdown) showing where this entity appears in THIS document. Copy exact substrings — never
  paraphrase or normalize them.
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
- tables/figures: note any table split across pages or figure caption dropped. IMPORTANT: small or
  decorative images (logos, icons, emojis, separators) are intentionally UNDESCRIBED in this pipeline —
  they are below the description threshold and their HTML-comment placeholders were removed before
  you saw the text. NEVER list them as missing captions or undescribed images; only flag REAL content
  figures whose caption/description was actually lost.
- garbled text: flag OCR/layout garbage, encoding issues.
- confidence: 0..1 how sure you are.
- issues: concrete list (e.g. "table on p3 split", "image caption missing"). When an issue quotes
  document content, ALSO add an entry to quality.issue_anchors with the EXACT verbatim quote from the
  markdown ({message, quote}) so review annotations can highlight it in-place; quotes must be copied
  character-for-character from the document.
- action: auto_accept (clean) or review_required (any doubt).

## Output
Return a single JSON object matching the DELTA contract — extraction fields + optional patches
(see the contract shape above). This pass has NO tools: your entire response must be the JSON object
itself (no prose, no tool calls, no markdown fence). Do NOT emit markdown, do NOT emit chunks. A section
that needs only header re-leveling returns patches with refactor_heading ops and no paragraph text. Do
not truncate — but also do not pad your output with text Athena already has.`;

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
      // LLM JSON is occasionally missing the comma BETWEEN adjacent object /
      // array elements (`}{` / `][` / `] {` / `}[`) — a classic strict-schema
      // slip. Repair by inserting a comma at those boundaries and retry.
      // Observed on wiki-edit refine: `"description": "..." }, { "name":
      // "ZOB München", ...` — plain JSON.parse rejected it and the whole
      // refinement fell back to the mechanical path.
      const repaired = trimmed.replace(/\}(\s*)\{/g, "},$1{").replace(/\](\s*)\[/g, "],$1[");
      if (repaired !== trimmed) {
        try {
          return JSON.parse(repaired);
        } catch {
          // fall through to the next candidate
        }
      }
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
  const quality = normalizeQuality(args.quality);

  if (!markdown || !frontmatter || !quality) {
    throw new Error("refine_document: output does not match the refinement contract (markdown/frontmatter/quality)");
  }

  return { markdown, summary, sections, frontmatter, chunks, entities, relations, keywords, quality };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asStringArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((item) => typeof item === "string") ? v : undefined;

/** Coerce a parsed entities array into the refinement contract (occurrences carried through, T19). */
export function normalizeEntityList(raw: unknown): RefinementEntity[] {
  return Array.isArray(raw)
    ? raw.filter(isRecord).map((e) => ({
        name: String(e.name ?? ""),
        type: String(e.type ?? "other"),
        description: String(e.description ?? ""),
        aliases: asStringArray(e.aliases) ?? [],
        occurrences: asStringArray(e.occurrences) ?? [],
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

/** Coerce a parsed patches array into the refinement contract (unknown ops dropped; anchors kept). */
export function normalizePatchList(raw: unknown): RefinementPatch[] {
  if (!Array.isArray(raw)) return [];
  const out: RefinementPatch[] = [];
  for (const p of raw) {
    if (!isRecord(p) || typeof p.index !== "number" || !Number.isFinite(p.index)) continue;
    const op = p.op;
    const index = p.index;
    const anchor = typeof p.anchor === "string" && p.anchor.trim().length > 0 ? { anchor: p.anchor } : {};
    if (op === "retitle_heading" && typeof p.text === "string") out.push({ op, index, text: p.text, ...anchor });
    else if (op === "refactor_heading" && typeof p.level === "number") out.push({ op, index, level: p.level, ...anchor });
    else if (op === "replace_paragraph" && typeof p.text === "string") out.push({ op, index, text: p.text });
    else if (op === "insert_paragraph" && typeof p.text === "string") out.push({ op, index, text: p.text });
    else if (op === "delete_paragraph") out.push({ op, index });
  }
  return out;
}

/** Coerce a parsed quality object into the contract (G4.S8.T16: issue_anchors carried through). */
export function normalizeQuality(raw: unknown): RefinementQuality | undefined {
  if (!isRecord(raw) || typeof raw.complete !== "boolean" || typeof raw.confidence !== "number") return undefined;
  const issueAnchors = Array.isArray(raw.issue_anchors)
    ? raw.issue_anchors
        .filter(isRecord)
        .map((a) => ({ message: String(a.message ?? ""), quote: String(a.quote ?? "") }))
        .filter((a) => a.message.length > 0 && a.quote.length > 0)
    : undefined;
  return {
    complete: raw.complete,
    confidence: raw.confidence,
    issues: asStringArray(raw.issues) ?? [],
    action: raw.action === "review_required" ? ("review_required" as const) : ("auto_accept" as const),
    ...(issueAnchors && issueAnchors.length > 0 ? { issue_anchors: issueAnchors } : {}),
  };
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
  const quality = normalizeQuality(args.quality);

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

// --- G4.S8.T16: cross-field delta validation + bounded repair loop ---

/** Whitespace-collapse + case-fold normalization — the closed-world name key shared with Neo4j's nameUpper fold. */
const normalizedEntityName = (name: string): string => name.replace(/\s+/g, " ").trim().toLowerCase();

/** Valid top-level topic prefixes of the CALEO hierarchical topic tree (docs/taxonomy.md §2). */
const TOPIC_ROOTS = ["sap", "finance", "it", "client", "corporate", "internal", "code"];

/**
 * Cross-field validation of a refinement DELTA against its source markdown (G4.S8.T16).
 *
 * The JSON schema constrains SHAPE only; these checks constrain CROSS-FIELD semantics:
 *   1. every relation source/target must reference an emitted entity name exactly
 *      (whitespace-normalized; case-insensitive to mirror the ingest nameUpper closed world)
 *   2. entities must be non-empty when relations exist (the Lüsen failure)
 *   3. every issue-anchor quote (T17 contract) must be present in the markdown
 *   4. frontmatter type/topic must be valid per the CALEO taxonomy
 *
 * Returns a list of CONCRETE error strings (fed back to the model verbatim by the repair loop).
 * Empty list = valid.
 */
export function validateRefineDelta(delta: RefinedDocumentDelta, sourceMarkdown: string): string[] {
  const errors: string[] = [];
  const declaredNames = new Set(delta.entities.map((e) => normalizedEntityName(e.name)));

  if ((delta.relations ?? []).length > 0 && delta.entities.length === 0) {
    errors.push(
      `entities array is EMPTY but ${delta.relations.length} relation(s) are declared — relations MUST reference emitted entities; either declare the endpoint entities or drop the relations`,
    );
  }

  for (const [i, relation] of (delta.relations ?? []).entries()) {
    for (const side of ["source", "target"] as const) {
      const raw = (relation[side] ?? "").trim();
      const key = normalizedEntityName(raw);
      if (!key) {
        errors.push(`relation ${i + 1} has an EMPTY ${side} — every relation needs a non-empty ${side} entity name`);
        continue;
      }
      if (!declaredNames.has(key)) {
        // G4.S8 dd65c95 tolerance: a slightly different form of an emitted entity ("Hotel Palma
        // Bellver By Affiliated by Melia", "München" vs "ZOB München") is NOT an error — the
        // fuzzy matcher accepts containment/token-overlap/small-edit-distance variants (the
        // ingest folds names via nameUpper anyway).
        const fuzzy = fuzzyEntityMatch(raw, delta.entities ?? []);
        if (!fuzzy) {
          // G4.S8.T19: genuinely foreign endpoints ARE validation errors again (T16 contract).
          // Name drift no longer nukes documents: the repair loop gets this SPECIFIC error, and
          // when repairs are exhausted the mandatory audit session rescues the delta by merging
          // drifted names into their canonical forms BEFORE any mechanical fallback runs.
          errors.push(
            `relation ${i + 1} references ${side} "${raw}" which does not match ANY declared entity — every endpoint MUST be one of: ${(delta.entities ?? []).map((e) => e.name).join("; ") || "(no entities emitted)"}`,
          );
        }
      }
    }
  }

  // T17 anchor contract: quoted passages must exist in the source (whitespace-normalized).
  const haystack = normalizedEntityName(sourceMarkdown);
  for (const anchor of delta.quality?.issue_anchors ?? []) {
    if (!normalizedEntityName(anchor.quote)) continue;
    if (!haystack.includes(normalizedEntityName(anchor.quote))) {
      errors.push(
        `issue-anchor quote not found in the document: "${anchor.quote.slice(0, 120)}" — quotes MUST be copied VERBATIM from the markdown so review annotations can highlight them`,
      );
    }
  }

  const fmType = (delta.frontmatter?.type ?? "").trim();
  if (!fmType || !(DOC_TYPES as readonly string[]).includes(fmType)) {
    errors.push(`frontmatter.type "${fmType}" is not a valid CALEO type — pick exactly ONE of: ${DOC_TYPES.join(", ")}`);
  }
  const fmTopic = (delta.frontmatter?.topic ?? "").trim();
  const root = fmTopic.split("/")[0]?.trim() ?? "";
  if (!fmTopic || !TOPIC_ROOTS.includes(root)) {
    errors.push(
      `frontmatter.topic "${fmTopic}" is not a valid CALEO topic path — use a slash path rooted at one of: ${TOPIC_ROOTS.join(", ")}`,
    );
  }

  return errors;
}

/**
 * Lenient endpoint-vs-entity match used by the T16 cross-field validator:
 * exact normalized equality, else normalized containment (either direction),
 * else a small Levenshtein distance (<= 3) after dropping filler tokens
 * (by, the, of, an, a, am, and, for, in, on, zu, am, der, die, das).
 * Returns the matched entity name (null when nothing is close).
 */
function fuzzyEntityMatch(raw: string, entities: { name?: unknown }[]): string | null {
  const clean = (t: string): string =>
    t.toLowerCase()
      .replace(/[^a-z0-9äöüß]+/g, " ")
      .trim();
  const norm = clean(normalizedEntityName(raw));
  if (!norm) return null;
  const stop = new Set(["by", "of", "an", "a", "am", "and", "for", "in", "with", "zu", "from", "der", "das", "the", "s"]);
  const words = norm.split(" ").filter((w) => w && !stop.has(w));
  if (words.length === 0) return null;
  for (const e of entities) {
    const en = clean(normalizedEntityName(String(e.name ?? "")));
    if (!en) continue;
    // containment
    if (en.includes(norm) || norm.includes(en)) return String(e.name);
    // token Jaccard-ish: >= 70% of the shorter side appears in the other —
    // tolerates the LLM replacing one token with a hallucinated near-duplicate
    // ("Belly" for "Affiliated") while still rejecting genuinely foreign names.
    const enWords = en.split(" ").filter(Boolean);
    const small = words.length <= enWords.length ? words : enWords;
    const big = words.length <= enWords.length ? enWords : words;
    const hits = small.filter((w) => big.includes(w)).length;
    if (small.length > 0 && hits / small.length >= 0.7) return String(e.name ?? "");
    // small edit distance on the compacted strings
    const d = editDistance(norm, en);
    if (d <= 3) return String(e.name);
  }
  return null;
}

/** Plain Levenshtein distance (<= cap scanning, fine for short names). */
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

/** Validation-repair budget (G4.S8.T16): re-invocations carrying the SPECIFIC error list. */
export const MAX_VALIDATION_RETRIES = 2;

/** Build the retry user-content: original markdown + the concrete validation error list. */
export function buildValidationRetryContent(markdown: string, attempt: number, errors: string[]): string {
  return `${markdown}\n\n[validation retry ${attempt}] Your previous output violated these cross-field constraints:\n${errors
    .map((e) => `- ${e}`)
    .join("\n")}\nFix EXACTLY these problems and return the COMPLETE corrected JSON object again (same contract).`;
}

/**
 * Assemble the full `RefinedDocument` from the ORIGINAL markdown + the LLM delta (G4.S8.T1). Athena
 * rebuilds `markdown` LOCALLY by applying the (optional) patches to the original text — zero LLM
 * information re-generation — and builds the `chunks` LOCALLY via `splitParagraphSemantic`. The
 * original already carries the stage-1 header re-level (two-stage) or is the untouched full doc whose
 * header corrections arrive as refactor_heading patches (single-pass).
 *
 * G4.S8.T16: the patch cycle is instrumented (`patchReport`), chunks are min-size merged, and every
 * chunk carries a locally-composed one-line `context` sentence derived from the delta summary.
 */
export function buildRefinedDocument(markdown: string, delta: RefinedDocumentDelta): RefinedDocument {
  const { markdown: mdFinal, report } = applyPatchesWithReport(markdown, delta.patches ?? []);
  return {
    markdown: mdFinal,
    summary: delta.summary,
    sections: delta.sections,
    frontmatter: delta.frontmatter,
    chunks: splitParagraphSemantic(mdFinal, { summary: delta.summary }),
    entities: delta.entities,
    relations: delta.relations,
    keywords: delta.keywords,
    quality: delta.quality,
    ...(report.emitted > 0 ? { patchReport: report } : {}),
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
Judge from the heading text + the excerpt only — you do NOT see the full document. There are NO tools:
return a JSON object of the form {"levels": [{"index": N, "level": L}, ...]} with a level for EVERY index
you were given. If uncertain, keep level 2.`;

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
Never invent entities or relations that are not present in the merged list. There are NO tools: your
entire response must be the JSON object matching this contract (no prose, no tool calls).`;

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
  }Section titles:\n${sectionTitles || "(none)"}\n\nMerged section summaries:\n${JSON.stringify(merged.sections)}\n\nMerged entities:\n${JSON.stringify(merged.entities, null, 2)}\n\nMerged relations:\n${JSON.stringify(merged.relations, null, 2)}\n\nMerged keywords:\n${JSON.stringify(merged.keywords)}\n\nMerged quality:\n${JSON.stringify(merged.quality)}\n\nReturn the final global view as a JSON object matching the contract above.`;
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
  const quality = normalizeQuality(args.quality);
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
  caller: RefineLlmCaller,
  blocks: HeaderBlock[],
  options: Pick<RefineDocumentOptions, "headerBatchSize" | "systemPrompt" | "modelId"> = {},
): Promise<HeaderBlock[]> {
  const batchSize = options.headerBatchSize ?? HEADER_RELEVEL_BATCH_SIZE;
  const batches = batchHeaderBlocks(blocks, batchSize);
  const corrected: HeaderBlock[] = [];
  for (const batch of batches) {
    let levels = new Map<number, number>();
    try {
      const { message } = await caller({
        systemPrompt: options.systemPrompt ?? HEADER_RELEVEL_SYSTEM_PROMPT,
        userContent: buildHeaderJudgePrompt(batch),
        schema: HEADER_LEVELS_SCHEMA,
        model: options.modelId,
        // G4.S8.T16 unified strategy: header judging = structured extraction class.
        reasoningEffort: refineReasoningFor("extraction").effort,
      });
      levels = extractHeaderLevels(message);
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
 * `buildRefinedDocument` (applyPatchesWithReport + splitParagraphSemantic), so output budget stays
 * ~1-5K tokens per call even on the largest docs — no truncation class of failure.
 *
 * G4.S2.T8: re-prompts up to `retries` times (default 3) on UNPARSEABLE output before giving up —
 * a transient "no structured output" on a long/image-heavy doc usually succeeds on an early retry.
 *
 * G4.S8.T16 validation/repair loop: after every parseable pass, `validateRefineDelta` checks the
 * delta's cross-field semantics (closed-world relation endpoints, entities-vs-relations, anchor
 * quotes, taxonomy). Violations re-invoke the model with the SPECIFIC error list attached, bounded
 * to MAX_VALIDATION_RETRIES (2); exhaustion throws → the caller's deterministic fallbackRefinement.
 * Every repair retry is logged ({attempt, errors[]}).
 */
/**
 * G4.S8 (post-loop) audit pass — runs for EVERY document after the main
 * refinement pass (and again as a last resort after repair exhaustion).
 *
 * The main pass is constrained-output (json_schema) and occasionally drifts
 * entity names between the entities[] list and relation endpoints (observed:
 * "Hotel Palma Bellver Belly by Melia" vs "...Affiliated by Melia"). A cheap
 * independent session (reasoning off, a few hundred tokens) reviews ONLY the
 * entities + relations against occurrence-anchored excerpts of the source
 * markdown and rewrites them to a CONSISTENT closed list:
 *   - every relation endpoint must exactly reference an entity in the list
 *   - near-duplicate entity names are merged into one canonical form
 *   - no new entities, no semantic changes, no invented relations
 * The audit output is re-validated; if it still fails, the original delta is
 * kept — audit is best-effort and never worse than no audit.
 *
 * G4.S8.T19 (Eng Director design update): the audit input is OCCURRENCE-
 * ANCHORED. The main pass emits `occurrences` (1-3 verbatim ≤80-char quotes)
 * per entity at extraction time; the prompt builder locates each quote in the
 * markdown and embeds the ±200-char context labeled with the entity name.
 * Entities whose quotes/name cannot be located are flagged "NO OCCURRENCE
 * FOUND". Legacy payloads without occurrences fall back to fuzzy location via
 * whitespace-normalized search of the name itself.
 */
const AUDIT_ENTITIES_PROMPT = `You are the final consistency auditor for a knowledge-graph extraction.
You receive a document's extracted ENTITIES and RELATIONS plus, for each name, an excerpt of the
document text around one real occurrence (labeled [name]). Rewrite the lists so that:

1. EVERY relation source/target EXACTLY matches the name of an entity in the
   entity list (case/whitespace-insensitive match is allowed, but the emitted
   name must be the EXACT entity name string you keep).
2. Merge entities that are clearly the same real-world object under different
   names (e.g. "Hotel Palma Bellver Affiliated by Melia" and "Hotel Palma
   Bellver Belly by Melia" -> keep ONE canonical name — prefer the variant the
   occurrence excerpts show is actually written in the document — and update
   all relation endpoints to it).
3. Keep every entity that a relation references; you may drop entities that no
   relation references and that are not clearly important on their own.
4. Do NOT invent new entities, do NOT change semantics, do NOT add relations.
5. Names flagged "NO OCCURRENCE FOUND" could not be located in the text: decide
   from their neighbouring entities/relations whether they are variants of a
   listed entity (merge them) or standalone (keep them).
6. Respond with ONLY a JSON object:
   {"entities":[{"name":string,"type":string,"description":string}],"relations":[{"source":string,"target":string,"keywords":string[],"description":string}]}`;

/** Whitespace-collapse helper for occurrence anchoring (same fold as the T17 anchor validation). */
const AUDIT_NORMALIZE_WS = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Locate `quote` in the whitespace-normalized markdown and return the ±200 char
 * context window around the BEST hit (first hit wins; case-insensitive). Long
 * quotes are truncated to 120 chars for matching robustness. Undefined when the
 * quote cannot be found (caller then flags NO OCCURRENCE FOUND).
 */
function locateOccurrenceContext(flatMarkdown: string, quote: string): string | undefined {
  const needle = AUDIT_NORMALIZE_WS(quote).slice(0, 120);
  if (!needle) return undefined;
  const hay = flatMarkdown;
  const idx = hay.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return undefined;
  const start = Math.max(0, idx - 200);
  const end = Math.min(hay.length, idx + needle.length + 200);
  return `${start > 0 ? "…" : ""}${hay.slice(start, end)}${end < hay.length ? "…" : ""}`;
}

/**
 * Build the occurrence-anchored audit prompt: one labeled ±200-char excerpt per
 * distinct entity/endpoint name (from its occurrences quotes, falling back to
 * fuzzy search of the bare name), then the CURRENT entities/relations lists.
 */
export function buildAuditPrompt(markdown: string, delta: RefinedDocumentDelta): string {
  const flat = AUDIT_NORMALIZE_WS(markdown);

  const labels: string[] = [];
  const seen = new Set<string>();
  const labelFor = (name: string, quotes?: string[]): void => {
    const key = AUDIT_NORMALIZE_WS(name).toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    let context: string | undefined;
    for (const q of [...(quotes ?? []), name]) {
      context = locateOccurrenceContext(flat, q);
      if (context) break;
    }
    labels.push(
      context
        ? `[${name}] ${context}`
        : `[${name}] NO OCCURRENCE FOUND — decide from neighbouring entities/relations only`,
    );
  };

  for (const e of delta.entities ?? []) labelFor(e.name, e.occurrences);
  for (const r of delta.relations ?? []) {
    labelFor(r.source, delta.entities?.find((e) => AUDIT_NORMALIZE_WS(e.name).toLowerCase() === AUDIT_NORMALIZE_WS(r.source).toLowerCase())?.occurrences);
    labelFor(r.target, delta.entities?.find((e) => AUDIT_NORMALIZE_WS(e.name).toLowerCase() === AUDIT_NORMALIZE_WS(r.target).toLowerCase())?.occurrences);
  }

  const entities = JSON.stringify(
    (delta.entities ?? []).map((e) => ({
      name: e.name,
      type: e.type,
      description: e.description,
      ...(e.occurrences && e.occurrences.length > 0 ? { occurrences: e.occurrences } : {}),
    })),
    null,
    2,
  );
  const relations = JSON.stringify(delta.relations ?? [], null, 2);
  return [
    "DOCUMENT CONTEXT (occurrence-anchored excerpts):",
    ...labels,
    "",
    "CURRENT ENTITIES:",
    entities,
    "",
    "CURRENT RELATIONS:",
    relations,
  ].join("\n");
}

export interface EntityAuditResult {
  /** The audited delta when adopted, else the ORIGINAL pre-audit delta object. */
  delta: RefinedDocumentDelta;
  /** true when the audited rewrite passed validation and was adopted. */
  adopted: boolean;
  /** Entity-name set symmetric difference between pre-audit and audited lists. */
  changedEntities: number;
  /** Relation endpoint-pair set symmetric difference between the two lists. */
  changedRelations: number;
  /** Token usage of the audit session when the caller provides it. */
  usage?: unknown;
}

/**
 * Run ONE independent audit session over a delta's entities/relations.
 *
 * Injectable (`caller`) and side-effect-free apart from one console line:
 *   - adopted + changed → "[refine_document] audit pass: changed N entities/M relations"
 *   - adopted unchanged → "[refine_document] audit pass: no-op"
 *   - rejected          → "[refine_document] audit pass: output invalid (...) — kept pre-audit delta"
 *   - caller failure    → "[refine_document] audit pass: unavailable (...) — kept pre-audit delta"
 *
 * Aliases/occurrences of surviving entities are carried over from the pre-audit
 * list (the narrow audit schema does not emit them; bilingual RAG lookup must
 * not regress). The result is adopted ONLY when it passes `validateRefineDelta`.
 */
export async function runEntityAudit(
  caller: RefineLlmCaller,
  markdown: string,
  delta: RefinedDocumentDelta,
  options: { modelId?: string } = {},
): Promise<EntityAuditResult> {
  const usageLine = (usage: unknown): string => {
    if (!usage || typeof usage !== "object") return "";
    const u = usage as { totalTokens?: unknown; cost?: { total?: unknown } };
    const parts: string[] = [];
    if (typeof u.totalTokens === "number") parts.push(`${u.totalTokens} tokens`);
    if (typeof u.cost?.total === "number") parts.push(`$${u.cost.total.toFixed(6)}`);
    return parts.length > 0 ? ` (${parts.join(", ")})` : "";
  };
  try {
    const { message, usage } = await caller({
      systemPrompt: AUDIT_ENTITIES_PROMPT,
      userContent: buildAuditPrompt(markdown, delta),
      schema: AUDIT_ENTITIES_SCHEMA,
      model: options.modelId,
      // Audit = cheap structured extraction: reasoning OFF, a few hundred tokens.
      reasoningEffort: refineReasoningFor("extraction").effort,
    });
    const parsed = tryParseNestedJson(
      (message.content ?? [])
        .filter((p): p is AssistantTextPart => p.type === "text")
        .map((p) => p.text)
        .join("\n"),
    );
    if (!parsed) {
      console.warn("[refine_document] audit pass: unparseable output — kept pre-audit delta");
      return { delta, adopted: false, changedEntities: 0, changedRelations: 0, ...(usage ? { usage } : {}) };
    }
    const raw = parsed as { entities?: unknown; relations?: unknown };
    const auditedEntities = normalizeEntityList(raw.entities);
    const auditedRelations = normalizeRelationList(raw.relations);
    if (auditedEntities.length === 0 && auditedRelations.length === 0) {
      console.warn("[refine_document] audit pass: empty output — kept pre-audit delta");
      return { delta, adopted: false, changedEntities: 0, changedRelations: 0, ...(usage ? { usage } : {}) };
    }

    // Carry aliases + occurrences over from the pre-audit entities (normalized-name join).
    const preByName = new Map(
      (delta.entities ?? []).map((e) => [AUDIT_NORMALIZE_WS(e.name).toLowerCase(), e]),
    );
    const merged: RefinementEntity[] = auditedEntities.map((e) => {
      const prev = preByName.get(AUDIT_NORMALIZE_WS(e.name).toLowerCase());
      return prev
        ? {
            ...e,
            ...(prev.aliases && prev.aliases.length > 0 ? { aliases: prev.aliases } : {}),
            ...(prev.occurrences && prev.occurrences.length > 0 ? { occurrences: prev.occurrences } : {}),
          }
        : e;
    });

    const audited: RefinedDocumentDelta = {
      ...delta,
      entities: merged,
      relations: auditedRelations,
      // Patches were already applied by buildRefinedDocument upstream semantics —
      // the audit rewrites ONLY entities/relations; keep everything else verbatim.
    };
    const errors = validateRefineDelta(audited, markdown);
    if (errors.length > 0) {
      console.warn(
        `[refine_document] audit pass: output invalid (${errors.length} error(s)) — kept pre-audit delta`,
      );
      return { delta, adopted: false, changedEntities: 0, changedRelations: 0, ...(usage ? { usage } : {}) };
    }

    // Change counters: normalized-name set symmetric differences.
    const normNames = (list: RefinementEntity[]): Set<string> =>
      new Set(list.map((e) => AUDIT_NORMALIZE_WS(e.name).toLowerCase()));
    const normPairs = (list: RefinementRelation[]): Set<string> =>
      new Set(list.map((r) => `${AUDIT_NORMALIZE_WS(r.source).toLowerCase()}|${AUDIT_NORMALIZE_WS(r.target).toLowerCase()}`));
    const diffCount = <T>(a: Set<T>, b: Set<T>): number => {
      let n = 0;
      for (const x of a) if (!b.has(x)) n += 1;
      for (const x of b) if (!a.has(x)) n += 1;
      return n;
    };
    const changedEntities = diffCount(normNames(delta.entities ?? []), normNames(merged));
    const changedRelations = diffCount(normPairs(delta.relations ?? []), normPairs(auditedRelations));

    if (changedEntities === 0 && changedRelations === 0) {
      console.warn(`[refine_document] audit pass: no-op${usageLine(usage)}`);
    } else {
      console.warn(
        `[refine_document] audit pass: changed ${changedEntities} entities/${changedRelations} relations${usageLine(usage)}`,
      );
    }
    return { delta: audited, adopted: true, changedEntities, changedRelations, ...(usage ? { usage } : {}) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[refine_document] audit pass: unavailable (${msg}) — kept pre-audit delta`);
    return { delta, adopted: false, changedEntities: 0, changedRelations: 0 };
  }
}

/** Audit schema — entities + relations only (narrow, cheap). */
export const AUDIT_ENTITIES_SCHEMA = Type.Object({
  entities: Type.Array(
    Type.Object({
      name: Type.String(),
      type: Type.String(),
      description: Type.Optional(Type.String()),
    }),
  ),
  relations: Type.Array(
    Type.Object({
      source: Type.String(),
      target: Type.String(),
      keywords: Type.Array(Type.String()),
      description: Type.Optional(Type.String()),
    }),
  ),
});

async function runRefinePass(
  caller: RefineLlmCaller,
  markdown: string,
  topicHint: string | undefined,
  options: Pick<RefineDocumentOptions, "systemPrompt" | "retries" | "modelId">,
): Promise<{
  document: RefinedDocument;
  assistant: AssistantMessageLike;
  usage?: unknown;
  retries: number;
  /** G4.S8.T16: one entry per validation-repair retry, with the exact errors fed back. */
  validationRetries: Array<{ attempt: number; errors: string[] }>;
  /** G4.S8.T19: outcome of the mandatory post-pass audit session. */
  audit: EntityAuditResult;
}> {
  const retries = options.retries ?? 3;
  const reasoning = refineReasoningFor("extraction").effort;
  let lastError: unknown;
  let usage: unknown;
  let genericRetries = 0;
  const validationRetries: Array<{ attempt: number; errors: string[] }> = [];

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    let userContent =
      attempt === 1 ? markdown : `${markdown}\n\n[retry ${attempt - 1}] Your previous response was not usable. Return ONLY a JSON object carrying the extraction fields + optional patches (no tool calls, no prose). Do NOT re-emit the markdown.`;
    if (validationRetries.length > 0) {
      userContent = buildValidationRetryContent(markdown, validationRetries.length, validationRetries[validationRetries.length - 1]!.errors);
    }
    try {
      const resp = await caller({
        systemPrompt: options.systemPrompt ?? buildRefineSystemPrompt(topicHint),
        userContent,
        schema: REFINED_DOCUMENT_SCHEMA,
        model: options.modelId,
        reasoningEffort: reasoning,
      });
      const message = resp.message;
      usage = resp.usage;
      const delta = extractRefinementDelta(message);

      // G4.S8.T16: cross-field validation BEFORE accepting — schema shape is not semantics.
      const errors = validateRefineDelta(delta, markdown);
      if (errors.length > 0) {
        if (validationRetries.length >= MAX_VALIDATION_RETRIES) {
          // G4.S8.T19 audit rescue: ONE independent session rewrites entities/
          // relations to a consistent closed set before we give up on the LLM
          // path entirely (mechanical fallback = topic unclassified, 0 chunks).
          const rescue = await runEntityAudit(caller, markdown, delta, { modelId: options.modelId });
          if (rescue.adopted) {
            console.warn(
              `[refine_document] audit pass rescued validation-exhausted delta: changed ${rescue.changedEntities} entities/${rescue.changedRelations} relations`,
            );
            return {
              document: buildRefinedDocument(markdown, rescue.delta),
              assistant: message,
              usage,
              retries: genericRetries,
              validationRetries,
              audit: rescue,
            };
          }
          console.warn("[refine_document] audit rescue failed — mechanical fallback");
          throw new Error(
            `refine_document: delta failed cross-field validation after ${validationRetries.length} repair retries — remaining errors: ${errors.join(" | ")}`,
          );
        }
        console.warn(`[refine_document] validation retry ${validationRetries.length + 1}/${MAX_VALIDATION_RETRIES}: ${JSON.stringify(errors)}`);
        validationRetries.push({ attempt, errors });
        continue;
      }

      // G4.S8.T19 MANDATORY audit gate: EVERY validated document gets ONE
      // independent consistency session over entities/relations. Adopted only
      // when the audited rewrite itself validates; otherwise keep pre-audit.
      const audit = await runEntityAudit(caller, markdown, delta, { modelId: options.modelId });

      return {
        document: buildRefinedDocument(markdown, audit.delta),
        assistant: message,
        usage,
        retries: genericRetries,
        validationRetries,
        audit,
      };
    } catch (err) {
      // A thrown VALIDATION-exhaustion error must NOT be retried generically.
      if (err instanceof Error && err.message.includes("cross-field validation")) throw err;
      lastError = err;
      genericRetries += 1;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Global-merge production implementation: final type/topic + dedup over the merged sections. */
async function runGlobalMerge(
  caller: RefineLlmCaller,
  refinements: RefinedDocument[],
  topicHint: string | undefined,
  model?: string,
): Promise<RefinedDocument> {
  const merged = mergeRefinements(refinements);
  try {
    const { message } = await caller({
      systemPrompt: GLOBAL_MERGE_SYSTEM_PROMPT,
      userContent: buildGlobalMergePrompt(merged, topicHint, refinements.length),
      schema: GLOBAL_MERGE_SCHEMA,
      model,
      // G4.S8.T16 unified strategy: summary/sections/quality synthesis = ANALYSIS class (thinking).
      reasoningEffort: refineReasoningFor("analysis").effort,
    });
    const global = extractGlobalMerge(message);
    if (!global) return merged;
    const candidate: RefinedDocument = {
      ...merged,
      summary: global.summary ?? merged.summary,
      sections: global.sections && global.sections.length > 0 ? global.sections : merged.sections,
      frontmatter: global.frontmatter ?? merged.frontmatter,
      entities: global.entities && global.entities.length > 0 ? global.entities : merged.entities,
      relations: global.relations && global.relations.length > 0 ? global.relations : merged.relations,
      keywords: global.keywords && global.keywords.length > 0 ? global.keywords : merged.keywords,
      quality: global.quality ?? merged.quality,
    };
    // G4.S8.T16 closed-world guard: a merge view whose relations reference undeclared entities is
    // rejected in favor of the mechanical merge — never worse, never silently inconsistent.
    const validationErrors = validateRefineDelta(
      {
        summary: candidate.summary,
        sections: candidate.sections ?? [],
        frontmatter: candidate.frontmatter ?? { type: "document", topic: "unclassified" },
        entities: candidate.entities,
        relations: candidate.relations,
        keywords: candidate.keywords,
        quality: candidate.quality,
      },
      "",
    ).filter((e) => /relation/i.test(e));
    if (validationErrors.length > 0) {
      console.warn(`[refine_document] global merge view rejected (${validationErrors.length} cross-field errors) — keeping mechanical merge`);
      return merged;
    }
    return candidate;
  } catch {
    // never worse: keep the mechanically merged result
    return merged;
  }
}

/**
 * Create the `refine_document` Pi custom tool wired into the athena agent.
 *
 * The tool executes the Athena refinement LLM pass with constrained sampling on the output contract,
 * calling OpenRouter directly (G4.S8.T2 — reasoning effort none, hard timeout + retry, dedicated
 * `athena` key), then STORES the full re-leveled markdown + chunks on disk (pi-docparser big-output
 * pattern, T3) and returns only the SMALL metadata + refs (frontmatter/entities/keywords/quality/
 * md_ref/preview). >1MB docs take the two-stage path. The leading `modelRuntime` argument is retained
 * for call-site compatibility; the LLM calls use `options.httpCaller` (default: direct OpenRouter).
 */
export function createRefineDocumentTool(
  _modelRuntime: ModelRuntime,
  options: RefineDocumentOptions = {},
): RefineDocumentTool {
  const httpCaller = options.httpCaller ?? defaultRefineLlmCaller();
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
      "Calls OpenRouter directly (dedicated athena key) with deepseek-v4-flash-latest, reasoning effort NONE (no thinking tokens), hard timeout + retry.",
      "Sub-1MB docs are refined in ONE full-doc read; >1MB docs use two-stage refinement (local header pass → split → per-section pass).",
    ],
    parameters: Type.Object({
      markdown: Type.String(),
      topic_hint: Type.Optional(Type.String()),
      file_name: Type.Optional(Type.String()),
    }),
    executionMode: "sequential",
    async execute(
      _toolCallId: string,
      params: RefineDocumentParams,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      _ctx?: unknown,
    ) {
      const mode: RefinementMode = isLargeMarkdown(params.markdown) ? "two-stage" : "single";
      // G4.S1.T6 two-file design: File A = full docling md (image refs + VLM descriptions) for
      // llm_wiki display; File B = image-ref lines stripped (text + VLM descriptions only) fed to
      // the refinement LLM + RAG. Refinement reads text only — image refs are noise that made the
      // constrained-sampling output unstable.
      const originalMarkdown = params.markdown;
      const textMarkdown = stripImageRefs(originalMarkdown);
      const imageRefsStripped = textMarkdown !== originalMarkdown;
      // G4.S8.T6: details.model reflects the model ACTUALLY used — explicit modelId, else the env
      // ATHENA_REFINE_MODEL override (resolveRefineModel), else the package deepseek default.
      const emitDetails = { model: options.modelId ?? resolveRefineModel(), mode, imageRefsStripped };
      let usage: unknown;
      let retries = 0;
      let validationRetries: Array<{ attempt: number; errors: string[] }> = [];
      let audit: EntityAuditResult | undefined;

      try {
        let document: RefinedDocument;
        let sectionPaths: string[] = [];
        let headerRelevelFallback = false;
        if (mode === "two-stage") {
          const result = await refineLargeDocument(
            textMarkdown,
            {
              judgeHeaderLevels:
                options.judgeHeaderLevelsImpl ??
                ((blocks) => judgeHeaderLevelsLLM(httpCaller, blocks, options)),
              refineSection:
                options.refineSectionImpl ??
                (async (section, hint) => (await runRefinePass(httpCaller, section.markdown, hint, options)).document),
              globalMerge:
                options.globalMergeImpl ??
                ((refinements, hint) => runGlobalMerge(httpCaller, refinements, hint, options.modelId)),
            },
            params.topic_hint,
          );
          document = result.document;
          sectionPaths = result.sections;
        } else {
          const single = await runRefinePass(httpCaller, textMarkdown, params.topic_hint, options);
          document = single.document;

          // G4.S8.T16 deterministic recovery: the model applied ZERO heading patches to a FLAT
          // document (>3 same-level headings) → run the batched HEADER_RELEVEL stage as a fallback.
          const report = document.patchReport ?? { emitted: 0, applied: 0, dropped: [] };
          if (report.applied === 0 && isFlatHeaderMarkdown(document.markdown)) {
            console.warn("[refine_document] flat headers + zero patches applied — running batched HEADER_RELEVEL recovery");
            const split = splitByHeaders(document.markdown);
            const releveled = await judgeHeaderLevelsLLM(httpCaller, split.blocks, options);
            const recovered = rebuildMarkdown(split.preamble, releveled);
            document = {
              ...document,
              markdown: recovered,
              chunks: splitParagraphSemantic(recovered, { summary: document.summary }),
            };
            headerRelevelFallback = true;
          }
          usage = single.usage;
          retries = single.retries;
          validationRetries = single.validationRetries;
          audit = single.audit;
        }
        // G4.S8.T18 single-h1 post-condition (Mallorca root cause): partial patch
        // application can re-level ##/### yet never promote a title — a coherent
        // tree with ZERO h1 escaped both the T16 flat-recovery trigger and the
        // contract. Enforce deterministically, keeping counters truthful. The
        // TWO-STAGE layout keeps its by-design h1 sections (only a MISSING title
        // is promoted there); the single pass enforces exactly one h1.
        let headerCompletion: { promoted: number; demoted: number } | undefined;
        const completion = completeHeaderHierarchy(document.markdown, {
          ...(mode === "two-stage" ? { demoteSurplus: false } : {}),
        });
        if (completion.changed) {
          console.warn(
            `[refine_document] header hierarchy completion: +${completion.promoted} h1 title, -${completion.demoted} surplus h1`,
          );
          document = {
            ...document,
            markdown: completion.markdown,
            chunks: splitParagraphSemantic(completion.markdown, { summary: document.summary }),
          };
          headerCompletion = { promoted: completion.promoted, demoted: completion.demoted };
        }
        if (!hasSingleH1(document.markdown) && mode !== "two-stage") {
          console.error("[refine_document] single-h1 contract STILL violated after completion — flagging for review");
        }
        // G4.S8.T18 deterministic placeholder pre-check: objective defects force
        // review_required + complete=false regardless of the LLM's own verdict.
        const merged = mergeObjectiveDefectsIntoQuality(document.quality, document.markdown);
        if (merged.appended.length > 0 || merged.quality !== document.quality) {
          document = { ...document, quality: merged.quality };
        }
        // File B = refined text-only markdown (RAG working copy). Sync the header re-level back
        // onto File A (keeping its image refs) → File A′ (durable, llm_wiki).
        const ragMarkdown = document.markdown;
        const fileAPrime = syncRefinedHeadersToSource(originalMarkdown, ragMarkdown);
        const ref = await store({ ...document, markdown: fileAPrime }, storageDir, {
          stem: deriveStemWithFileName(fileAPrime, params.file_name),
          mode,
          section_paths: sectionPaths,
          ...(imageRefsStripped ? { ragMarkdown } : {}),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(ref) }],
          details: {
            ...emitDetails,
            usage,
            retries,
            // G4.S8.T16 patch-cycle + repair-loop instrumentation, per run.
            patches: document.patchReport ?? { emitted: 0, applied: 0, dropped: [] },
            validationRetries,
            ...(audit
              ? {
                  audit: {
                    adopted: audit.adopted,
                    changedEntities: audit.changedEntities,
                    changedRelations: audit.changedRelations,
                  },
                  // G4.S8.T19: per-document audit cost/usage when the caller provides it.
                  ...(audit.usage !== undefined ? { auditUsage: audit.usage } : {}),
                }
              : {}),
            ...(headerRelevelFallback ? { headerRelevelFallback } : {}),
            ...(headerCompletion ? { headerCompletion } : {}),
          },
        };
      } catch (err) {
        const fallback = fallbackRefinement(originalMarkdown, params.topic_hint, err);
        // G4.S8.T18: even the deterministic fallback satisfies the single-h1 contract.
        const completedFallback = completeHeaderHierarchy(fallback.markdown, {
          ...(mode === "two-stage" ? { demoteSurplus: false } : {}),
        });
        const finalFallback = completedFallback.changed
          ? { ...fallback, markdown: completedFallback.markdown }
          : fallback;
        const fallbackRag = stripImageRefs(originalMarkdown);
        const ref = await store(finalFallback, storageDir, {
          stem: deriveStemWithFileName(finalFallback.markdown, params.file_name),
          mode,
          ...(fallbackRag !== finalFallback.markdown ? { ragMarkdown: fallbackRag } : {}),
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
  quality: QUALITY_SCHEMA,
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

/** Union two entity lists by name (new wins for fields, keyed on normalized name). */
function unionEntities(
  base: RefinementEntity[],
  extra: RefinementEntity[],
): RefinementEntity[] {
  const seen = new Map<string, RefinementEntity>();
  for (const e of [...base, ...extra]) {
    const key = (e.name ?? "").trim().toLowerCase();
    if (key) seen.set(key, e);
  }
  return [...seen.values()];
}

/** Union two relation lists by (source,target) key (new wins). */
function unionRelations(
  base: RefinementRelation[],
  extra: RefinementRelation[],
): RefinementRelation[] {
  const seen = new Map<string, RefinementRelation>();
  for (const r of [...base, ...extra]) {
    const key = `${(r.source ?? "").trim().toLowerCase()}|${(r.target ?? "").trim().toLowerCase()}`;
    if (key.endsWith("|")) continue; // drop dangling endpoints
    seen.set(key, r);
  }
  return [...seen.values()];
}

export function normalizeWikiEditRefinement(raw: unknown): WikiEditRefinement {
  const args: Record<string, unknown> =
    typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : ((raw ?? {}) as Record<string, unknown>);
  const base = normalizeRefinedDocument(args);
  const newEntities = normalizeEntityList(args.new_entities);
  const newRelations = normalizeRelationList(args.new_relations);
  return {
    ...base,
    // G4.S8.T18 hardening: insist the "new" items are ALSO part of the full
    // lists. The prompt demands it, but a lenient model can write them only
    // under new_* -- without this union the overwrite would silently drop the
    // correction's entities/relations from the graph (observed: CALEO Office
    // was returned in new_entities only and never landed in Neo4j).
    entities: unionEntities(base.entities, newEntities),
    relations: unionRelations(base.relations, newRelations),
    new_entities: newEntities,
    new_relations: newRelations,
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

export interface WikiEditRefineOptions {
  /**
   * G4.S8.T16: reasoning now follows the unified strategy function
   * (wiki-edit = structured extraction class → default no thinking), NOT a
   * per-path accident. An explicit override still wins.
   */
  thinkingLevel?: AthenaThinkingLevel;
  /** Override the wiki-edit refine system prompt. */
  systemPrompt?: string;
  /** Retries before giving up (default 3 — up to 4 attempts). */
  retries?: number;
  /**
   * G4.S8.T16: inject the direct-OpenRouter caller (tests stub the HTTP layer).
   * Default: the SAME direct transport the upload path uses — the Pi
   * ModelRuntime dependency is GONE (timeout/retry/provider.ignore for free).
   */
  httpCaller?: RefineLlmCaller;
  /** Model id sent to OpenRouter (default: env ATHENA_REFINE_MODEL / deepseek default). */
  modelId?: string;
}

/**
 * Run the incremental wiki-edit refine LLM pass: input = corrected markdown +
 * the diff. Preserves the corrected text (contract-enforced constrained output),
 * re-derives the full structure and flags new entities/relations. Retries on a
 * transient non-structured output; throws on persistent failure (caller falls
 * back to `fallbackWikiEditRefinement`).
 *
 * G4.S8.T16: this pass previously ran on Pi `ModelRuntime.completeSimple` with an
 * accidental `reasoning: "max"` while every other refinement call went direct with
 * effort none. It NOW uses the same direct-OpenRouter transport as the upload path
 * (hard timeout, retry/backoff, provider.ignore) and derives its reasoning level
 * from `refineReasoningFor("extraction")` — one strategy function for both paths.
 * The emit contract is UNCHANGED.
 */
/**
 * G4.S8.T19 extension: audit a wiki-edit refine result exactly like the
 * upload path audits its full-document delta — one cheap independent session
 * (reasoning off, entities/relations only) that canonicalizes entity names
 * and closes relation endpoints against the entity list. Runs on EVERY
 * wiki-edit save. If the audit fails or produces an invalid rewrite, the
 * original extraction is kept (best-effort, never worse).
 */
export async function auditWikiEditDocument(
  caller: RefineLlmCaller,
  markdown: string,
  doc: WikiEditRefinement,
  modelId?: string,
): Promise<WikiEditRefinement> {
  const delta: RefinedDocumentDelta = {
    summary: doc.summary ?? "",
    sections: doc.sections ?? [],
    frontmatter: doc.frontmatter ?? { type: "document", topic: "unclassified" },
    entities: doc.entities ?? [],
    relations: doc.relations ?? [],
    keywords: doc.keywords ?? [],
    quality: doc.quality ?? { complete: true, confidence: 1, issues: [], action: "auto_accept" },
  };
  const result = await runEntityAudit(caller, markdown, delta, { modelId });
  if (!result.adopted || result.delta === delta) return doc; // no change / refused
  const audited = result.delta;
  const origNames = new Set((doc.entities ?? []).map((e) => normalizedEntityName(e.name)));
  const newEntities = (audited.entities ?? []).filter((e) => !origNames.has(normalizedEntityName(e.name)));
  console.warn(
    `[refine_document] wiki-edit audit pass: changed ${result.changedEntities} entities/${result.changedRelations} relations`,
  );
  return {
    ...doc,
    entities: (audited.entities?.length ?? 0) > 0 ? audited.entities : doc.entities ?? [],
    // An EMPTY relation array from the audit must NOT wipe the extraction's
    // relations ([] is truthy — `??` does not protect it). Observed live:
    // wiki-edit audit returned entities but no relations; the graph lost all
    // relations even though the task log said overwrite ok.
    relations: (audited.relations?.length ?? 0) > 0 ? audited.relations : doc.relations ?? [],
    new_entities: newEntities,
    new_relations: doc.new_relations ?? [],
    rechunked: doc.rechunked,
  };
}

export async function runWikiEditRefine(
  input: WikiEditRefineInput,
  existing?: { type?: string; topic?: string },
  options: WikiEditRefineOptions = {},
): Promise<{ document: WikiEditRefinement; retries: number }> {
  const httpCaller = options.httpCaller ?? defaultRefineLlmCaller();
  const policy = refineReasoningFor("extraction");
  const reasoningEffort = options.thinkingLevel ? normalizeThinkingLevelToEffort(options.thinkingLevel) : policy.effort;
  const retries = options.retries ?? 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      const { message } = await httpCaller({
        systemPrompt: options.systemPrompt ?? WIKI_EDIT_REFINE_SYSTEM_PROMPT,
        userContent: buildWikiEditRefinePrompt(input, existing, attempt),
        schema: WIKI_EDIT_REFINE_SCHEMA,
        model: options.modelId,
        reasoningEffort,
      });
      const extracted = extractWikiEditRefinement(message);
      // Mandatory audit for wiki-edit saves (T19): canonicalize names /
      // close endpoints with a cheap independent session. Never fatal.
      try {
        const audited = await auditWikiEditDocument(httpCaller, input.markdown, extracted, options.modelId);
        if (audited !== extracted) {
          // audit applied (logged inside auditWikiEditDocument)
        } else {
          console.warn(`[refine_document] wiki-edit audit pass: no-op`);
        }
        return { document: audited, retries: attempt - 1 };
      } catch (auditErr) {
        console.warn(`[refine_document] wiki-edit audit skipped (${auditErr instanceof Error ? auditErr.message : String(auditErr)}) — keeping extraction`);
        return { document: extracted, retries: attempt - 1 };
      }
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Map a Pi-style thinking level onto the canonical OpenRouter effort set. */
function normalizeThinkingLevelToEffort(level: AthenaThinkingLevel): "none" | "low" | "medium" | "high" {
  switch (level) {
    case "minimal":
      return "none";
    case "low":
      return "low";
    case "medium":
      return "medium";
    default:
      return "high";
  }
}
