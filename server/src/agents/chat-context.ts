/**
 * Remote chat context management (G4.S7.T10).
 *
 * The platform's chat panel accumulates the full conversation client-side and
 * sends it as `history` with every remote-agent task. The server is the single
 * authority for context-size decisions: below a token threshold the history is
 * passed through unchanged (zero extra LLM calls); above it the OLD part (before
 * a recent turn window) is distilled into a system summary by an injected LLM
 * summarizer and replaced — the recent window and the current message are always
 * kept verbatim.
 *
 * Token estimation is a DOCUMENTED HEURISTIC, not a tokenizer: ASCII/CJK-mixed
 * text is charged ~1 token per 4 ASCII characters and ~1 token per CJK character
 * (CJK characters carry far more information per glyph than latin characters).
 * This is deliberately rough — it exists only to pick the summarize/truncate
 * trigger point and to show an approximate meter in the UI.
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AGENTIC_MODEL, AGENTIC_PROVIDER } from "../kb/agentic-llm.js";

/** A single conversation turn pushed to a remote agent (`messages: {role, content}[]`). */
export interface ChatTurn {
  role: string;
  content: string;
}

/**
 * LLM seam that distills `turns` into a short factual summary. Injectable so
 * unit tests never hit the network; the production implementation reuses the
 * athena model channel (createAthenaSummarizer).
 */
export type Summarizer = (turns: ChatTurn[]) => Promise<string>;

/** Below this estimated token count, history passes through unchanged. */
export const DEFAULT_CONTEXT_THRESHOLD_TOKENS = 40_000;
/** The newest N turns that are always kept verbatim when summarizing/truncating. */
export const DEFAULT_RECENT_MAX_TURNS = 40;
/** Defensive cap on the number of history turns a client may send per request. */
export const MAX_HISTORY_TURNS = 200;

/** CJK ideographic/Halfwidth ranges charged ~1 token per character. */
const CJK_RE = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/g;

/**
 * Heuristic token estimate: `ceil(nonCJK chars / 4) + CJK chars`. ASCII text
 * ≈ 4 chars/token; CJK ≈ 1 char/token. No tokenizer dependency; documented in
 * the module header. Empty input → 0.
 */
export function estimateTokens(text: string): number {
  const cjkCount = (text.match(CJK_RE) ?? []).length;
  const asciiLength = text.length - cjkCount;
  return Math.ceil(asciiLength / 4) + cjkCount;
}

function serializeTurns(turns: ChatTurn[]): string {
  return turns.map((t) => `${t.role}: ${t.content}`).join("\n\n");
}

/** Message sent to a remote agent when summarization is unavailable/failed. */
export const TRUNCATION_NOTE = "Earlier conversation context was omitted";

export interface BuildTaskMessagesOptions {
  /** Estimated-token threshold; history above it triggers summarization. */
  thresholdTokens: number;
  /** Number of most-recent turns kept verbatim (never summarized/truncated). */
  recentMaxTurns: number;
  /**
   * LLM seam used to distill the old turns. When absent (not configured) the
   * old part is truncated with an explicit omission note — never a hard error.
   */
  summarizer?: Summarizer;
}

/**
 * Build the messages array pushed to a remote agent for one chat turn:
 *
 * - Below (or at) the threshold → `[pageInjection?] + history + current message`.
 * - Above the threshold → `[pageInjection?] + [system summary] + recent window + current message`.
 *   The OLD turns (before `recentMaxTurns`) are summarized via `opts.summarizer`.
 *   If the summarizer is absent or fails, the old turns are dropped and a system
 *   note explains the earlier context was omitted — the request never fails.
 *
 * The current message is never dropped and the recent window is kept verbatim.
 */
export async function buildTaskMessages(
  history: ChatTurn[],
  message: string,
  pageInjection: string | undefined,
  opts: BuildTaskMessagesOptions,
): Promise<ChatTurn[]> {
  const current: ChatTurn = { role: "user", content: message };
  const totalTokens = estimateTokens(serializeTurns(history)) + estimateTokens(message);

  const recent = history.slice(-opts.recentMaxTurns);
  const old = history.slice(0, history.length - recent.length);

  // Below threshold, or nothing outside the recent window to summarize/truncate
  // → pass the history through unchanged (no LLM call).
  if (totalTokens <= opts.thresholdTokens || old.length === 0) {
    return [...(pageInjection ? [{ role: "system", content: pageInjection }] : []), ...history, current];
  }

  let summary = "";
  if (opts.summarizer) {
    try {
      summary = (await opts.summarizer(old)).trim();
    } catch {
      summary = "";
    }
  }

  const summaryTurn: ChatTurn = summary
    ? { role: "system", content: `Earlier conversation summary: ${summary}` }
    : { role: "system", content: TRUNCATION_NOTE };

  return [
    ...(pageInjection ? [{ role: "system", content: pageInjection }] : []),
    summaryTurn,
    ...recent,
    current,
  ];
}

/** System prompt for the production summarizer. */
const SUMMARIZE_SYSTEM_PROMPT =
  "You are a conversation summarizer for a remote agent. Distill the OLD turns below " +
  "into a concise factual summary that preserves names, decisions, constraints and " +
  "any already-established context the agent will need. No commentary, no questions.";

/**
 * Production Summarizer backed by the athena LLM channel (same provider/model as
 * the agentic pipeline). A missing model or an LLM error degrades to "" — the
 * caller then emits the truncation note instead of failing the chat request.
 */
export function createAthenaSummarizer(modelRuntime: ModelRuntime): Summarizer {
  return async (turns) => {
    const model = modelRuntime.getModel(AGENTIC_PROVIDER, AGENTIC_MODEL);
    if (!model) return "";
    try {
      const assistant = await modelRuntime.completeSimple(
        model,
        {
          systemPrompt: SUMMARIZE_SYSTEM_PROMPT,
          messages: [{ role: "user", content: serializeTurns(turns), timestamp: Date.now() }],
        },
        { reasoning: "low" },
      );
      return assistant.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
    } catch {
      return "";
    }
  };
}

/**
 * Shared production summarizer that lazily builds (and caches) a ModelRuntime on
 * first use, so the server's default wiring never pays for a runtime that a
 * request does not need. Inject your own Summarizer to bypass it in tests.
 */
let sharedRuntimePromise: Promise<ModelRuntime> | undefined;

export function createSharedAthenaSummarizer(): Summarizer {
  return async (turns) => {
    if (!sharedRuntimePromise) {
      sharedRuntimePromise = ModelRuntime.create();
    }
    let runtime: ModelRuntime;
    try {
      runtime = await sharedRuntimePromise;
    } catch {
      return "";
    }
    return createAthenaSummarizer(runtime)(turns);
  };
}
