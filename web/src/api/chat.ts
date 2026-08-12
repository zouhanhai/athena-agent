import { consumeSSEStream, type ChatClarification } from "./sse";

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

export interface ChatStreamHandlers {
  onDelta: (delta: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
  /** G4.S3.T13: a clarification follow-up (question + options) from the chat stream. */
  onClarify?: (clarify: ChatClarification) => void;
}

/**
 * Non-streaming chat: POST /api/chat { userId, message, page? } → { reply }.
 * The optional `page` is the current route path; the server injects that page's
 * relevant agent capabilities into the conversation context. Throws an Error on
 * failure (includes HTTP status code or network error).
 */
export async function sendChat(
  userId: string,
  message: string,
  page?: string,
): Promise<string> {
  const res = await postChat(userId, message, {}, page);
  const data = (await res.json()) as ChatReply;
  return data.reply;
}

/**
 * Streaming chat: POST /api/chat (Accept: text/event-stream),
 * calls onDelta chunk by chunk via consumeSSEStream, dispatches done/error/clarify
 * to onDone/onError/onClarify. When `clarifyAnswer` is provided, the request body
 * carries `clarify: { query, answer }` so the server re-runs the original query
 * with the user's chosen context (G4.S3.T13).
 */
export async function streamChat(
  userId: string,
  message: string,
  handlers: ChatStreamHandlers,
  page?: string,
  clarifyAnswer?: ChatClarifyAnswer,
): Promise<void> {
  const res = await postChat(userId, message, { Accept: "text/event-stream" }, page, clarifyAnswer);
  await consumeSSEStream(res, handlers);
}

async function postChat(
  userId: string,
  message: string,
  extraHeaders: Record<string, string> = {},
  page?: string,
  clarifyAnswer?: ChatClarifyAnswer,
): Promise<Response> {
  const body: Record<string, unknown> = { userId, message };
  if (page) {
    body.page = page;
  }
  if (clarifyAnswer) {
    body.clarify = clarifyAnswer;
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
