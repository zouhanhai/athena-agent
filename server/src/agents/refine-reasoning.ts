/**
 * Unified reasoning strategy for ALL Athena refinement LLM calls (G4.S8.T16).
 *
 * Policy by TASK CLASS, not by call-path accident. Before T16 the initial-upload
 * path hardcoded OpenRouter `reasoning.effort = "none"` while the wiki-edit
 * diff-refine ran Pi's default `reasoning: "max"` — two different behaviors for
 * structurally similar jobs, decided by whichever transport each pass happened
 * to use. Both paths now derive their reasoning parameter from THIS module:
 *
 *   - "extraction" — structured-output calls constrained to a JSON contract
 *     (delta emit, patches/entities/relations extraction, header re-level judge,
 *     wiki-edit re-derivation). Thinking is OFF by default: quality is guarded
 *     by the G4.S8.T16 cross-field validation + repair loop instead of tokens.
 *   - "analysis" — understanding/generation calls that synthesize prose
 *     (global merge: file-level summary, section summaries, final quality
 *     view). Thinking is ON by default; tunable via REFINE_REASONING_ANALYSIS.
 *
 * Env knobs (values: none | minimal | low | medium | high | xhigh | max):
 *   REFINE_REASONING_EXTRACTION  (default "none")
 *   REFINE_REASONING_ANALYSIS    (default "high")
 */

/** Task class driving the reasoning policy (see module docs). */
export type RefineTaskClass = "extraction" | "analysis";

/**
 * Canonical effort levels shared by both transports. OpenRouter takes these
 * verbatim as `reasoning.effort`; Pi thinking levels map onto them.
 */
export const REFINE_REASONING_EFFORTS = ["none", "low", "medium", "high"] as const;
export type RefineReasoningEffort = (typeof REFINE_REASONING_EFFORTS)[number];

const DEFAULTS: Record<RefineTaskClass, RefineReasoningEffort> = {
  extraction: "none",
  analysis: "high",
};

const ENV_KEYS: Record<RefineTaskClass, string> = {
  extraction: "REFINE_REASONING_EXTRACTION",
  analysis: "REFINE_REASONING_ANALYSIS",
};

/**
 * Normalize any of none|minimal|low|medium|high|xhigh|max into the canonical
 * effort set. Unknown values fall back to `fallback` (never throws).
 */
export function normalizeRefineReasoning(raw: string | undefined, fallback: RefineReasoningEffort): RefineReasoningEffort {
  switch (raw?.trim().toLowerCase()) {
    case "none":
      return "none";
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
    case "max":
      return "high";
    default:
      return fallback;
  }
}

export interface RefineReasoningPolicy {
  task: RefineTaskClass;
  /** Canonical effort — sent to OpenRouter as `reasoning.effort` on the direct path. */
  effort: RefineReasoningEffort;
  /** Pi `ThinkingLevel` for the runtime path (`ModelRuntime.completeSimple`). */
  piThinkingLevel: "minimal" | "low" | "medium" | "high";
}

const PI_LEVEL: Record<RefineReasoningEffort, RefineReasoningPolicy["piThinkingLevel"]> = {
  none: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
};

/**
 * The ONE strategy function both refinement transports consult.
 * Direct-OpenRouter callers send `policy.effort`; Pi-runtime callers send
 * `policy.piThinkingLevel` — same decision, transport-shaped.
 */
export function refineReasoningFor(
  task: RefineTaskClass,
  env: NodeJS.ProcessEnv = process.env,
): RefineReasoningPolicy {
  const fallback = DEFAULTS[task];
  const effort = normalizeRefineReasoning(env[ENV_KEYS[task]], fallback);
  return { task, effort, piThinkingLevel: PI_LEVEL[effort] };
}
