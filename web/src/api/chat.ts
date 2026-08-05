import { consumeSSEStream } from "./sse";

const CHAT_ENDPOINT = "/api/chat";

interface ChatReply {
  reply: string;
}

export interface ChatStreamHandlers {
  onDelta: (delta: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

/**
 * Non-streaming chat: POST /api/chat { userId, message } → { reply }.
 * Throws an Error on failure (includes HTTP status code or network error).
 */
export async function sendChat(userId: string, message: string): Promise<string> {
  const res = await postChat(userId, message);
  const data = (await res.json()) as ChatReply;
  return data.reply;
}

/**
 * Streaming chat: POST /api/chat (Accept: text/event-stream),
 * calls onDelta chunk by chunk via consumeSSEStream, dispatches done/error to onDone/onError.
 */
export async function streamChat(
  userId: string,
  message: string,
  handlers: ChatStreamHandlers,
): Promise<void> {
  const res = await postChat(userId, message, { Accept: "text/event-stream" });
  await consumeSSEStream(res, handlers);
}

async function postChat(
  userId: string,
  message: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const res = await fetch(CHAT_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify({ userId, message }),
  });
  if (!res.ok) {
    throw new Error(`Request failed with status ${res.status}`);
  }
  return res;
}
