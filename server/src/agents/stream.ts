import type { Agent } from "./agent.js";

/**
 * 以事件流方式产出一次对话的回答文本块。
 * 在 prompt 前订阅 text_delta 事件，随产出随 yield，避免全部缓冲到结束。
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
