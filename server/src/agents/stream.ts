import type { Agent } from "./agent.js";

/**
 * Produce a conversation's answer text chunks as an event stream.
 * Subscribe to text_delta before prompting, yield as it is produced, avoiding buffering until the end.
 */
export async function* streamAgentText(agent: Agent, message: string): AsyncGenerator<string> {
  const queue: string[] = [];
  let resolveWait: (() => void) | null = null;
  let closed = false;

  const wake = (): void => {
    const r = resolveWait;
    resolveWait = null;
    r?.();
  };

  const unsubscribe = agent.session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      queue.push(event.assistantMessageEvent.delta);
      wake();
    }
  });

  try {
    const pending = agent.session.prompt(message);
    void pending
      .catch(() => {})
      .then(() => {
        closed = true;
        wake();
      });
    while (!closed || queue.length > 0) {
      if (queue.length > 0) {
        yield queue.shift() as string;
        continue;
      }
      if (closed) {
        break;
      }
      await new Promise<void>((resolve) => {
        resolveWait = resolve;
      });
    }
    await pending;
  } finally {
    closed = true;
    wake();
    unsubscribe();
  }
}

/** A clarification signal relayed from the search_knowledge tool result (G4.S3.T13). */
export interface ClarificationSignal {
  question: string;
  options: string[];
  query: string;
}

/** A structured chat-stream event: either a text delta or a real user clarification. */
export type AgentChatEvent =
  | { type: "delta"; text: string }
  | { type: "clarify"; clarification: ClarificationSignal };

/** Extract a clarification from a search_knowledge tool result (its details block). */
export function extractClarification(result: unknown): ClarificationSignal | undefined {
  const details = (result as { details?: unknown } | undefined)?.details;
  const clarification = (details as { clarification?: unknown } | undefined)?.clarification;
  if (!clarification || typeof clarification !== "object") return undefined;
  const c = clarification as { question?: unknown; options?: unknown; query?: unknown };
  if (typeof c.question !== "string" || !Array.isArray(c.options)) return undefined;
  return {
    question: c.question,
    options: c.options.filter((o): o is string => typeof o === "string"),
    query: typeof c.query === "string" ? c.query : "",
  };
}

/**
 * Produce a conversation's answer as a stream of chat events (text deltas and
 * clarification follow-ups, G4.S3.T13).
 *
 * Subscribes to the session's tool-execution events: when the `search_knowledge`
 * tool returns a structured clarification (a REAL question for the user, not a
 * final answer), it yields a single `{ type: "clarify", clarification }` event
 * and then ends the stream — the agent's dead-end text after the tool call is
 * NOT forwarded. The caller (the chat route) relays the clarification to the
 * front-end chat, and the user's answer re-runs the query.
 */
export async function* streamAgentChat(agent: Agent, message: string): AsyncGenerator<AgentChatEvent> {
  const queue: AgentChatEvent[] = [];
  let resolveWait: (() => void) | null = null;
  let closed = false;
  let clarifyEmitted = false;

  const wake = (): void => {
    const r = resolveWait;
    resolveWait = null;
    r?.();
  };

  const unsubscribe = agent.session.subscribe((event) => {
    if (event.type === "tool_execution_end" && event.toolName === "search_knowledge") {
      const clarification = extractClarification(event.result);
      if (clarification && !clarifyEmitted) {
        clarifyEmitted = true;
        queue.push({ type: "clarify", clarification });
        // Stop the agent's current run so it does not produce a dead-end answer
        // after the clarification tool result. Best-effort.
        const session = agent.session as unknown as { abort?: () => Promise<void> };
        void session.abort?.().catch(() => {});
        wake();
        return;
      }
    }
    if (!clarifyEmitted) {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        queue.push({ type: "delta", text: event.assistantMessageEvent.delta });
        wake();
      }
    }
  });

  try {
    const pending = agent.session.prompt(message);
    void pending
      .catch(() => {})
      .then(() => {
        closed = true;
        wake();
      });
    while (!closed || queue.length > 0) {
      if (queue.length > 0) {
        const event = queue.shift() as AgentChatEvent;
        yield event;
        if (event.type === "clarify") {
          break;
        }
        continue;
      }
      if (closed) {
        break;
      }
      await new Promise<void>((resolve) => {
        resolveWait = resolve;
      });
    }
    // After a clarify we already have what the caller needs and the run was
    // aborted on purpose — a rejection from the aborted run must not surface
    // as a spurious SSE error frame. Normal runs propagate errors as before.
    if (clarifyEmitted) {
      await pending.catch(() => {});
    } else {
      await pending;
    }
  } finally {
    closed = true;
    wake();
    unsubscribe();
  }
}
