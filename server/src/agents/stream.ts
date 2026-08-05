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
