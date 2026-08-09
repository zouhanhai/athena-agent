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
import { Type } from "typebox";
import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";

export const ATHENA_PROVIDER = "athena";
export const ATHENA_MODEL = "~deepseek/deepseek-v4-flash-latest";

/** pi ThinkingLevel values for the `reasoning` option (mirrors the SDK union). */
export type AthenaThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Name of the constrained emit tool the refinement LLM must call with the output contract. */
export const EMIT_REFINED_DOCUMENT_TOOL = "emit_refined_document";

// --- Athena refinement output contract (G4.S1 Spec) ---
export interface RefinementFrontmatter {
  type: string;
  topic: string;
}

export interface RefinementChunk {
  id: string;
  text: string;
  start: number;
  end: number;
  topic?: string;
}

export interface RefinementEntity {
  name: string;
  type: string;
  description: string;
}

export interface RefinementRelation {
  from: string;
  to: string;
  type: string;
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
      start: Type.Number(),
      end: Type.Number(),
      topic: Type.Optional(Type.String()),
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
      from: Type.String(),
      to: Type.String(),
      type: Type.String(),
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
 * Default refinement system prompt. The detailed document-refinement skill + prompt are G4.S1.T2;
 * this is the working single-pass instruction set.
 */
export const REFINE_DOCUMENT_SYSTEM_PROMPT = `You are Athena, the document-refinement pass of the athena ingest pipeline.
You receive the RAW docling markdown of one document and produce its refined form in ONE full read.

Tasks, in one pass:
1. HEADER RE-LEVELING — restore a semantic header hierarchy (# title, ## section, ### subsection).
   docling often emits flat headers (e.g. everything is h2); fix that from the document structure.
2. CLASSIFICATION — set frontmatter.type (document kind) and frontmatter.topic (hierarchical topic path).
3. CHUNKING — segment the re-leveled markdown into paragraph-semantic chunks (~1200 tokens, ~100 token
   overlap), each with a stable id, character start/end, and its section topic.
4. ENTITY EXTRACTION — knowledge-graph nodes: name (title-case, consistent naming — avoid "CALEO"/"caleo"
   variants), type (org/person/product/event/location/other), description.
5. RELATION EXTRACTION — binary edges only (from -> to -> type). Only direct, clearly-stated, meaningful
   relations; decompose multi-entity statements into binary edges.
6. KEYWORDS — retrieval keywords (high-level + low-level) for search.
7. QUALITY — report completeness vs the source, confidence, concrete issues (tables split, garbled text,
   missing figures), and an action: auto_accept or review_required.

Respond by calling the emit_refined_document tool with the COMPLETE refined document. Its JSON schema
constrains your output. Emit the entire re-leveled markdown and every chunk; do not truncate.`;

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
        start: typeof c.start === "number" ? c.start : 0,
        end: typeof c.end === "number" ? c.end : 0,
        ...(typeof c.topic === "string" ? { topic: c.topic } : {}),
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
        from: String(r.from ?? ""),
        to: String(r.to ?? ""),
        type: String(r.type ?? "related_to"),
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
