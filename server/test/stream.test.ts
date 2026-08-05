import { test } from "node:test";
import assert from "node:assert/strict";
import type { Agent } from "../src/agents/agent.js";
import { streamAgentText } from "../src/agents/stream.js";

type EventListener = (event: unknown) => void;

function makeFakeAgent(deltas: string[]): {
  agent: Agent;
  prompts: string[];
  unsubscribed: () => boolean;
} {
  const listeners = new Set<EventListener>();
  const prompts: string[] = [];
  let subscribed = false;

  const session = {
    prompts,
    async prompt(text: string): Promise<void> {
      prompts.push(text);
      for (const delta of deltas) {
        for (const l of listeners) {
          l({
            type: "message_update",
            message: {},
            assistantMessageEvent: { type: "text_delta", delta },
          });
        }
      }
      for (const l of listeners) {
        l({ type: "agent_end", messages: [], willRetry: false });
      }
    },
    subscribe(listener: EventListener): () => void {
      listeners.add(listener);
      subscribed = true;
      return () => {
        listeners.delete(listener);
        subscribed = false;
      };
    },
  };

  const agent = {
    session,
    model: "deepseek/deepseek-v4-flash",
    packages: [],
    extensionErrors: [],
    prompt: async () => "",
    dispose: () => {},
  } as unknown as Agent;

  return {
    agent,
    prompts,
    unsubscribed: () => !subscribed,
  };
}

test("streamAgentText 按序产出所有 text_delta 块", async () => {
  const { agent } = makeFakeAgent(["你", "好", "，", "世界"]);
  const chunks: string[] = [];
  for await (const chunk of streamAgentText(agent, "hi")) {
    chunks.push(chunk);
  }
  assert.deepEqual(chunks, ["你", "好", "，", "世界"]);
});

test("streamAgentText 把用户消息传给 session.prompt", async () => {
  const { agent, prompts } = makeFakeAgent(["ok"]);
  for await (const _ of streamAgentText(agent, "你好")) {
    // 消费完整个流
  }
  assert.deepEqual(prompts, ["你好"]);
});

test("streamAgentText 无 text_delta 时流为空", async () => {
  const { agent } = makeFakeAgent([]);
  const chunks: string[] = [];
  for await (const chunk of streamAgentText(agent, "hi")) {
    chunks.push(chunk);
  }
  assert.deepEqual(chunks, []);
});

test("streamAgentText 结束后退订 subscribe", async () => {
  const { agent, unsubscribed } = makeFakeAgent(["x"]);
  for await (const _ of streamAgentText(agent, "hi")) {
    // 消费完整个流
  }
  assert.equal(unsubscribed(), true, "流结束后应退订事件监听");
});
