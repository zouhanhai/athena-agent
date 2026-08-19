import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokens,
  buildTaskMessages,
  DEFAULT_CONTEXT_THRESHOLD_TOKENS,
  DEFAULT_RECENT_MAX_TURNS,
  type ChatTurn,
  type Summarizer,
} from "../src/agents/chat-context.js";

/** A summarizer that records the turns it was given and returns a fixed summary. */
function recordingSummarizer(
  out: ChatTurn[][],
  summary = "SUMMARY",
  error?: Error,
): Summarizer {
  return async (turns) => {
    out.push(turns);
    if (error) throw error;
    return summary;
  };
}

const MESSAGE = "current user message";

/** Build a history of `n` turns, each with content long enough to be counted. */
function historyOf(n: number, prefix = "turn"): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (let i = 0; i < n; i += 1) {
    turns.push({ role: i % 2 === 0 ? "user" : "assistant", content: `${prefix}-${i}: hello` });
  }
  return turns;
}

test("estimateTokens: heuristic sanity — ASCII ≈ len/4, CJK ≈ len, empty = 0", () => {
  assert.equal(estimateTokens(""), 0);
  // 16 ASCII chars → 4 tokens.
  assert.equal(estimateTokens("abcdefghijklmnop"), 4);
  // 1 char → 1 token (ceil).
  assert.equal(estimateTokens("a"), 1);
  // CJK: each char counts ~1 token (no 4:1 compression).
  const cjk = "你好世界";
  assert.equal(estimateTokens(cjk), 4);
  // Mixed: 12 ASCII (3 tokens) + 2 CJK (2 tokens) = 5.
  assert.equal(estimateTokens("abcdefghijkl你好"), 5);
});

test("estimateTokens: len/4 is an upper estimate of the tokenizer-free heuristic (documented chars/4)", () => {
  const ascii = "The quick brown fox jumps over the lazy dog.";
  assert.equal(estimateTokens(ascii), Math.ceil(ascii.length / 4));
});

test("buildTaskMessages: below threshold passes history through unchanged (no summarizer call)", async () => {
  const history = historyOf(3);
  const calls: ChatTurn[][] = [];
  const messages = await buildTaskMessages(history, MESSAGE, undefined, {
    thresholdTokens: DEFAULT_CONTEXT_THRESHOLD_TOKENS,
    recentMaxTurns: DEFAULT_RECENT_MAX_TURNS,
    summarizer: recordingSummarizer(calls),
  });

  assert.deepEqual(messages, [...history, { role: "user", content: MESSAGE }]);
  assert.deepEqual(calls, [], "no summarizer call below the threshold");
});

test("buildTaskMessages: prepends page injection below threshold when provided", async () => {
  const history = historyOf(2);
  const messages = await buildTaskMessages(history, MESSAGE, "[Current page: Workbench]", {
    thresholdTokens: DEFAULT_CONTEXT_THRESHOLD_TOKENS,
    recentMaxTurns: DEFAULT_RECENT_MAX_TURNS,
    summarizer: recordingSummarizer([]),
  });

  assert.equal(messages[0]!.role, "system");
  assert.equal(messages[0]!.content, "[Current page: Workbench]");
  assert.deepEqual(messages.slice(1), [...history, { role: "user", content: MESSAGE }]);
});

test("buildTaskMessages: above threshold summarizes OLD turns and keeps the recent window verbatim + current message", async () => {
  // Every turn is 16+ ASCII chars → at least 4 tokens each; 30 turns ≈ 120+ tokens
  // far exceeds a tiny threshold, forcing the summarize path.
  const history = historyOf(10);
  const recentMaxTurns = 3;
  const oldTurns = history.slice(0, history.length - recentMaxTurns);
  const recentTurns = history.slice(-recentMaxTurns);

  const calls: ChatTurn[][] = [];
  const messages = await buildTaskMessages(history, MESSAGE, undefined, {
    thresholdTokens: 10,
    recentMaxTurns,
    summarizer: recordingSummarizer(calls),
  });

  assert.deepEqual(calls, [oldTurns], "summarizer receives exactly the OLD turns");
  assert.equal(messages[0]!.role, "system");
  assert.ok(messages[0]!.content.startsWith("Earlier conversation summary:"), "summary is a system message");
  assert.ok(messages[0]!.content.includes("SUMMARY"));
  assert.deepEqual(
    messages.slice(1),
    [...recentTurns, { role: "user", content: MESSAGE }],
    "recent window verbatim (order preserved) + current message last",
  );
});

test("buildTaskMessages: never drops the current message and never summarizes the recent window", async () => {
  const history = historyOf(8);
  const recentMaxTurns = 2;
  const recent = history.slice(-recentMaxTurns);
  const calls: ChatTurn[][] = [];
  const messages = await buildTaskMessages(history, MESSAGE, undefined, {
    thresholdTokens: 5,
    recentMaxTurns,
    summarizer: recordingSummarizer(calls),
  });

  // The recent window must appear verbatim in the output, in order.
  for (const turn of recent) {
    const idx = messages.findIndex((m) => m === turn);
    assert.ok(idx !== -1, "recent turn present");
  }
  assert.equal(messages[messages.length - 1]!.content, MESSAGE, "current message is the last turn");
  assert.equal(calls[0]!.length, history.length - recentMaxTurns, "summarizer only sees pre-window turns");
});

test("buildTaskMessages: summarizer failure falls back to a truncation note (never blocks)", async () => {
  const history = historyOf(6);
  const recentMaxTurns = 2;
  const recentTurns = history.slice(-recentMaxTurns);
  const calls: ChatTurn[][] = [];
  const messages = await buildTaskMessages(history, MESSAGE, undefined, {
    thresholdTokens: 5,
    recentMaxTurns,
    summarizer: recordingSummarizer(calls, "unused", new Error("llm down")),
  });

  assert.equal(messages[0]!.role, "system");
  assert.equal(
    messages[0]!.content,
    "Earlier conversation context was omitted",
    "failure → explicit omission note",
  );
  assert.deepEqual(
    messages.slice(1),
    [...recentTurns, { role: "user", content: MESSAGE }],
    "recent window + current message survive a summarizer failure",
  );
});

test("buildTaskMessages: absent summarizer (not configured) short-circuits to the truncation note", async () => {
  const history = historyOf(6);
  const recentMaxTurns = 2;
  const messages = await buildTaskMessages(history, MESSAGE, undefined, {
    thresholdTokens: 5,
    recentMaxTurns,
    summarizer: undefined,
  });

  assert.equal(messages[0]!.role, "system");
  assert.equal(messages[0]!.content, "Earlier conversation context was omitted");
  assert.equal(messages[messages.length - 1]!.content, MESSAGE);
  assert.equal(messages.length, 1 + recentMaxTurns + 1, "note + window + current message");
});

test("buildTaskMessages: above threshold with an empty recent window (nothing to summarize) passes through", async () => {
  const history = historyOf(3);
  const messages = await buildTaskMessages(history, MESSAGE, undefined, {
    thresholdTokens: 5,
    recentMaxTurns: 10,
    summarizer: recordingSummarizer([]),
  });
  assert.deepEqual(messages, [...history, { role: "user", content: MESSAGE }]);
});

test("defaults are exported tuning constants", () => {
  assert.equal(DEFAULT_CONTEXT_THRESHOLD_TOKENS, 200_000);
  assert.equal(DEFAULT_RECENT_MAX_TURNS, 40);
});
