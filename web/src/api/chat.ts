import { consumeSSEStream, type ChatClarification, type ToolProgress } from "./sse";

const CHAT_ENDPOINT = "/api/chat";

interface ChatReply {
  reply: string;
}

/** G4.S3.T13: the user's answer to a clarification — re-runs the original query
 *  with the chosen context (sent to the server in the chat request body). */
export interface ChatClarifyAnswer {
  query: string;
  answer: string;
}

/** G4.S7.T10: one accumulated conversation turn sent as `history` so the remote
 *  agent keeps multi-turn context (same `{ role, content }` shape as the task). */
export interface ChatHistoryTurn {
  role: string;
  content: string;
}

export interface ChatStreamHandlers {
  onDelta: (delta: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
  /** G4.S3.T13: a clarification follow-up (question + options) from the chat stream. */
  onClarify?: (clarify: ChatClarification) => void;
  /** G4.S7.T4: reasoning/thinking tokens from a remote agent. */
  onThinking?: (text: string) => void;
  /** G4.S7.T4: tool progress rows from a remote agent. */
  onTool?: (tool: ToolProgress) => void;
}

/**
 * Non-streaming chat: POST /api/chat { userId, message, page? } → { reply }.
 * The optional `page` is the current route path; the server injects that page's
 * relevant agent capabilities into the conversation context. `history` (G4.S7.T10)
 * carries the accumulated turns when provided. Throws an Error on failure
 * (includes HTTP status code or network error).
 */
export async function sendChat(
  userId: string,
  message: string,
  page?: string,
  targetAgentId?: string,
  history?: ChatHistoryTurn[],
): Promise<string> {
  const res = await postChat(userId, message, {}, page, undefined, targetAgentId, history);
  const data = (await res.json()) as ChatReply;
  return data.reply;
}

/**
 * Streaming chat: POST /api/chat (Accept: text/event-stream),
 * calls onDelta chunk by chunk via consumeSSEStream, dispatches done/error/clarify
 * to onDone/onError/onClarify. When `clarifyAnswer` is provided, the request body
 * carries `clarify: { query, answer }` so the server re-runs the original query
 * with the user's chosen context (G4.S3.T13). When `targetAgentId` is provided
 * (G4.S7.T4), the message is routed to that remote agent over its reverse tunnel.
 * `history` (G4.S7.T10) carries the accumulated turns so the remote agent keeps
 * multi-turn context (the server summarizes/truncates above its token threshold).
 */
export async function streamChat(
  userId: string,
  message: string,
  handlers: ChatStreamHandlers,
  page?: string,
  clarifyAnswer?: ChatClarifyAnswer,
  targetAgentId?: string,
  history?: ChatHistoryTurn[],
): Promise<void> {
  const res = await postChat(
    userId,
    message,
    { Accept: "text/event-stream" },
    page,
    clarifyAnswer,
    targetAgentId,
    history,
  );
  await consumeSSEStream(res, handlers);
}

async function postChat(
  userId: string,
  message: string,
  extraHeaders: Record<string, string> = {},
  page?: string,
  clarifyAnswer?: ChatClarifyAnswer,
  targetAgentId?: string,
  history?: ChatHistoryTurn[],
): Promise<Response> {
  const body: Record<string, unknown> = { userId, message };
  if (page) {
    body.page = page;
  }
  if (clarifyAnswer) {
    body.clarify = clarifyAnswer;
  }
  if (targetAgentId) {
    body.agent_id = targetAgentId;
  }
  if (history && history.length > 0) {
    body.history = history;
  }
  const res = await fetch(CHAT_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Request failed with status ${res.status}`);
  }
  return res;
}
