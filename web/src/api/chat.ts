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
 *  agent keeps multi-turn context (same `{ role, content }` shape as the task).
 *
 *  G4.S7.T11 full-transfer history: an assistant turn may additionally carry
 *  `thinking` (the accumulated reasoning text) and one `toolOutput` (the tool
 *  result content) + `toolName`/`toolCallId` so the prior reasoning and tool
 *  results are replayed to the agent, aligning with Hermes' own replay. All are
 *  optional — pre-T11 clients send plain `{ role, content }`. */
export interface ChatHistoryTurn {
  role: string;
  content: string;
  thinking?: string;
  toolOutput?: string;
  toolName?: string;
  toolCallId?: string;
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
  /** G4.S7.T12: the server resolved/created the chat session for this turn. */
  onSessionId?: (sessionId: string) => void;
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
  sessionId?: string,
): Promise<string> {
  const res = await postChat(
    userId,
    message,
    {},
    page,
    undefined,
    targetAgentId,
    history,
    sessionId,
  );
  const data = (await res.json()) as ChatReply;
  return data.reply;
}

/** G4.S7.T11-followup: persisted per-user chat history (F5 restore). */
export interface PersistedChatMessageDto {
  message_id: string;
  employee_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  speaker_id: string;
  speaker_name: string;
  page: string;
  thinking: string;
  progress: Array<Record<string, unknown>>;
  created_at: string;
}

/** G4.S7.T12: one picker row for a user's chat session. */
export interface ChatSessionDto {
  session_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

/** G4.S7.T12: fetch the user's recent chat sessions (max 10, most-recent first).
 *  Cheap list — no messages; restore happens via fetchChatHistory per session. */
export async function fetchChatSessions(
  userId: string,
  limit = 10,
): Promise<ChatSessionDto[]> {
  const res = await fetch(`/api/chat/sessions?userId=${encodeURIComponent(userId)}&limit=${limit}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Sessions request failed with status ${res.status}`);
  }
  const data = (await res.json()) as { sessions: ChatSessionDto[] };
  return data.sessions ?? [];
}

/** G4.S7.T11-followup: fetch the signed-in user's persisted chat history.
 *  G4.S7.T12: with `sessionId` the window is scoped to that one session. */
export async function fetchChatHistory(
  userId: string,
  limit = 200,
  sessionId?: string,
): Promise<PersistedChatMessageDto[]> {
  const params = new URLSearchParams({ userId, limit: String(limit) });
  if (sessionId !== undefined) params.set("sessionId", sessionId);
  const res = await fetch(`/api/chat/history?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`History request failed with status ${res.status}`);
  }
  const data = (await res.json()) as { messages: PersistedChatMessageDto[] };
  return data.messages ?? [];
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
  sessionId?: string,
): Promise<void> {
  const res = await postChat(
    userId,
    message,
    { Accept: "text/event-stream" },
    page,
    clarifyAnswer,
    targetAgentId,
    history,
    sessionId,
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
  sessionId?: string,
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
  if (sessionId) {
    // G4.S7.T12: resume this session; omitted → server creates a NEW one.
    body.session_id = sessionId;
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
