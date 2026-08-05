export interface SSEHandlers {
  onDelta?: (delta: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

const EVENT_SEPARATOR = "\n\n";

/**
 * 消费一个 SSE Response body，逐事件分发给 handlers。
 * 事件 data 行为 JSON: {"delta":"..."} | {"done":true} | {"error":"..."}
 * fetch 流式读取，事件可能跨 chunk 边界，需缓冲重组。
 */
export async function consumeSSEStream(
  response: Response,
  handlers: SSEHandlers = {},
): Promise<void> {
  if (!response.body) {
    throw new Error("Response body is missing");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = dispatchEvents(buffer, handlers);
    }
    buffer += decoder.decode();
    dispatchEvents(buffer, handlers);
  } finally {
    reader.releaseLock();
  }
}

function dispatchEvents(buffer: string, handlers: SSEHandlers): string {
  let idx: number;
  while ((idx = buffer.indexOf(EVENT_SEPARATOR)) !== -1) {
    const event = buffer.slice(0, idx);
    buffer = buffer.slice(idx + EVENT_SEPARATOR.length);
    dispatchEvent(event, handlers);
  }
  return buffer;
}

function dispatchEvent(event: string, handlers: SSEHandlers): void {
  const dataLine = event
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("data:"));
  if (!dataLine) return;

  const payload = dataLine.slice("data:".length).trim();
  if (!payload) return;

  let parsed: { delta?: unknown; done?: unknown; error?: unknown };
  try {
    parsed = JSON.parse(payload) as { delta?: unknown; done?: unknown; error?: unknown };
  } catch {
    return;
  }

  if (typeof parsed.error === "string") {
    handlers.onError?.(parsed.error);
  } else if (parsed.done === true) {
    handlers.onDone?.();
  } else if (typeof parsed.delta === "string") {
    handlers.onDelta?.(parsed.delta);
  }
}
