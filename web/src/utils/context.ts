/**
 * Remote chat context meter (G4.S7.T10) — mirrors the server-side heuristic in
 * `server/src/agents/chat-context.ts` so the UI shows the same estimated token
 * count / threshold the server uses to decide summarize-vs-passthrough.
 *
 * The estimate is deliberately rough (no tokenizer): ~1 token per 4 ASCII chars,
 * ~1 token per CJK char. It only drives the meter display + trigger-state badge.
 */

/** Same default as the server's DEFAULT_CONTEXT_THRESHOLD_TOKENS. */
export const CONTEXT_THRESHOLD_TOKENS = 40_000;

/** CJK ideographic/Halfwidth ranges charged ~1 token per character. */
const CJK_RE = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/g;

/** Heuristic token estimate mirroring the server: ceil(non-CJK / 4) + CJK chars. */
export function estimateTokens(text: string): number {
  const cjkCount = (text.match(CJK_RE) ?? []).length;
  const asciiLength = text.length - cjkCount;
  return Math.ceil(asciiLength / 4) + cjkCount;
}

export type ContextMeterState = "normal" | "warning" | "summarizing";

/** Meter state: normal < 80%, warning 80–100%, summarizing >= 100% (server will
 *  summarize the history on the next message). */
export function contextMeterState(
  tokens: number,
  threshold: number = CONTEXT_THRESHOLD_TOKENS,
): ContextMeterState {
  if (tokens >= threshold) return "summarizing";
  if (tokens / threshold >= 0.8) return "warning";
  return "normal";
}

/** Fill percentage (clamped to 100) for the meter bar. */
export function contextMeterPercent(
  tokens: number,
  threshold: number = CONTEXT_THRESHOLD_TOKENS,
): number {
  return Math.min(100, Math.round((tokens / threshold) * 100));
}

/** Human label like `~12k / 40k tokens`. */
export function formatContextMeter(
  tokens: number,
  threshold: number = CONTEXT_THRESHOLD_TOKENS,
): string {
  return `~${Math.round(tokens / 1000)}k / ${Math.round(threshold / 1000)}k tokens`;
}
