export interface SSEHandlers {
  onDelta?: (delta: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
  /** G4.S3.T13: a clarification follow-up (question + options) relayed from the chat stream. */
  onClarify?: (clarify: ChatClarification) => void;
  /** G4.S7.T4: a remote agent's reasoning/thinking token (kept apart from the final answer). */
  onThinking?: (text: string) => void;
  /** G4.S7.T4: tool progress from a remote agent (tool.started / tool.completed). */
  onTool?: (tool: ToolProgress) => void;
}

/** G4.S7.T4: a tool-progress row streamed by a remote agent over its reverse tunnel. */
export interface ToolProgress {
  state: "started" | "completed" | "failed";
  name: string;
  detail?: string;
  error?: string;
}

/** G4.S3.T13: a clarification the agent wants the user to answer. `query` is the
 *  original user question so the answer can re-run the query with the chosen context. */
export interface ChatClarification {
  question: string;
  options: string[];
  query?: string;
}

const EVENT_SEPARATOR = "\n\n";

/**
 * Consumes an SSE Response body, dispatching each event to handlers.
 * Event data is JSON: {"delta":"..."} | {"done":true} | {"error":"..."} | {"clarify":{...}}
 * Uses fetch streaming read; events may span chunk boundaries, requiring buffer reassembly.
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

  let parsed: {
    delta?: unknown;
    done?: unknown;
    error?: unknown;
    clarify?: unknown;
    thinking?: unknown;
    tool?: unknown;
  };
  try {
    parsed = JSON.parse(payload) as {
      delta?: unknown;
      done?: unknown;
      error?: unknown;
      clarify?: unknown;
      thinking?: unknown;
      tool?: unknown;
    };
  } catch {
    return;
  }

  if (typeof parsed.error === "string") {
    handlers.onError?.(parsed.error);
  } else if (parsed.done === true) {
    handlers.onDone?.();
  } else if (isChatClarification(parsed.clarify)) {
    handlers.onClarify?.(parsed.clarify);
  } else if (typeof parsed.thinking === "string") {
    handlers.onThinking?.(parsed.thinking);
  } else if (isToolProgress(parsed.tool)) {
    handlers.onTool?.(parsed.tool);
  } else if (typeof parsed.delta === "string") {
    handlers.onDelta?.(parsed.delta);
  }
}

function isChatClarification(value: unknown): value is ChatClarification {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.question !== "string") return false;
  if (!Array.isArray(v.options) || !v.options.every((o) => typeof o === "string")) return false;
  return v.query === undefined || typeof v.query === "string";
}

function isToolProgress(value: unknown): value is ToolProgress {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.state !== "started" && v.state !== "completed" && v.state !== "failed") return false;
  if (typeof v.name !== "string") return false;
  if (v.detail !== undefined && typeof v.detail !== "string") return false;
  if (v.error !== undefined && typeof v.error !== "string") return false;
  return true;
}
