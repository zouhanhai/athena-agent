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
 * Big-output handling (full md + chunks to storage) and the two-stage path for >1MB docs are G4.S1.T3.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { TYPE_CRITERIA_PROMPT, TOPIC_TREE_PROMPT } from "../kb/taxonomy.js";

export const ATHENA_PROVIDER = "athena";
export const ATHENA_MODEL = "~deepseek/deepseek-v4-flash-latest";

/** pi ThinkingLevel values for the `reasoning` option (mirrors the SDK union). */
export type AthenaThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Name of the constrained emit tool the refinement LLM must call with the output contract. */
export const EMIT_REFINED_DOCUMENT_TOOL = "emit_refined_document";

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

/** Knowledge-graph node. `name` is title-case for consistent naming ("CALEO", not "caleo"). */
export interface RefinementEntity {
  name: string;
  type: string;
  description: string;
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
  /** Override the refinement system prompt. */
  systemPrompt?: string;
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
- type: org | person | product | event | location | concept | other (preset types; else "other").
- description: one concise sentence stating what it is in this document's context.
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
 * Prefers the constrained `emit_refined_document` tool call; falls back to plain-text JSON.
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
    return normalizeRefinedDocument(JSON.parse(text));
  }
  throw new Error("refine_document: assistant returned no structured output");
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

/**
 * Create the `refine_document` Pi custom tool wired into the athena agent.
 * The tool executes the one-shot Athena refinement LLM pass with constrained sampling on the output
 * contract, using the dedicated `athena` provider at thinkingLevel `high`.
 */
export function createRefineDocumentTool(
  modelRuntime: ModelRuntime,
  options: RefineDocumentOptions = {},
): RefineDocumentTool {
  const providerId = options.providerId ?? ATHENA_PROVIDER;
  const modelId = options.modelId ?? ATHENA_MODEL;
  const thinkingLevel = options.thinkingLevel ?? "high";

  const tool: ToolDefinition = {
    name: "refine_document",
    label: "Refine Document (Athena)",
    description:
      "Run the Athena full-document refinement pass on docling markdown: re-level headers, classify " +
      "type/topic, chunk, extract entities/relations/keywords and quality-check — in one LLM read " +
      "using the dedicated athena provider.",
    promptGuidelines: [
      "Use for the ingest refinement step: pass the raw docling markdown, get the re-leveled markdown + structured output contract back.",
      "Uses the dedicated athena OpenRouter provider (independent key/cost) with deepseek-v4-flash-latest at thinkingLevel high.",
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

      try {
        const assistant = await modelRuntime.completeSimple(
          model,
          {
            systemPrompt: options.systemPrompt ?? buildRefineSystemPrompt(params.topic_hint),
            messages: [{ role: "user", content: params.markdown, timestamp: Date.now() }],
            tools: [
              {
                name: EMIT_REFINED_DOCUMENT_TOOL,
                description:
                  "Emit the refined document as a single structured JSON value matching the refinement output contract.",
                parameters: REFINED_DOCUMENT_SCHEMA,
                constrainedSampling: { type: "json_schema", strict: "require" },
              },
            ],
          },
          { reasoning: thinkingLevel },
        );
        const refined = extractRefinedDocument(assistant);
        return {
          content: [{ type: "text", text: JSON.stringify(refined) }],
          details: {
            provider: providerId,
            model: modelId,
            usage: (assistant as { usage?: unknown }).usage,
          },
        };
      } catch (err) {
        const fallback = fallbackRefinement(params.markdown, params.topic_hint, err);
        return {
          content: [{ type: "text", text: JSON.stringify(fallback) }],
          details: {
            provider: providerId,
            model: modelId,
            fallback: true,
            error: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
  };

  return tool as RefineDocumentTool;
}
