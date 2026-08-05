import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { AgentManager } from "../src/agents/manager.js";
import type { Agent } from "../src/agents/agent.js";
import type { FastifyInstance } from "fastify";

type EventListener = (event: unknown) => void;

interface FakeSession {
  chunks: string[];
  subscribe(listener: EventListener): () => void;
  prompt(text: string): Promise<void>;
}

function makeFakeSession(chunks: string[]): FakeSession {
  const listeners = new Set<EventListener>();
  return {
    chunks,
    subscribe(listener: EventListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async prompt(): Promise<void> {
      for (const delta of chunks) {
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
  };
}

function makeStubAgent(session: FakeSession): Agent {
  return {
    session,
    model: "deepseek/deepseek-v4-flash",
    packages: [],
    extensionErrors: [],
    prompt: async () => "模拟回复",
    dispose: () => {},
  } as unknown as Agent;
}

let app: FastifyInstance;

beforeEach(async () => {
  const manager = new AgentManager({}, async (userId) => makeStubAgent(makeFakeSession([`${userId}-块1`, "-块2"])));
  app = buildApp({ manager });
});

after(async () => {
  if (app) {
    await app.close();
  }
});

test("POST /api/chat 非流式返回 Pi 回答", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/chat",
    payload: { userId: "alice", message: "hi" },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { reply: "模拟回复" });
});

test("POST /api/chat 流式 (Accept: text/event-stream) 逐块返回 SSE", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/chat",
    headers: { accept: "text/event-stream" },
    payload: { userId: "alice", message: "hi" },
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /^text\/event-stream/);
  const body = res.body;
  assert.ok(body.includes(`data: ${JSON.stringify({ delta: "alice-块1" })}\n\n`), "应包含第一块 delta");
  assert.ok(body.includes(`data: ${JSON.stringify({ delta: "-块2" })}\n\n`), "应包含第二块 delta");
  assert.ok(body.includes(`data: ${JSON.stringify({ done: true })}\n\n`), "应以 done 事件结束");
});

test("POST /api/chat 缺少 message 返回 400", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/chat",
    payload: { userId: "alice" },
  });
  assert.equal(res.statusCode, 400);
});

test("POST /api/chat 缺少 userId 返回 400", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/chat",
    payload: { message: "hi" },
  });
  assert.equal(res.statusCode, 400);
});

test("POST /api/chat 不同 userId 各自创建独立会话", async () => {
  const manager = new AgentManager({}, async (userId) => makeStubAgent(makeFakeSession([`${userId}-专属`])));
  const chatApp = buildApp({ manager });
  try {
    const res = await chatApp.inject({
      method: "POST",
      url: "/api/chat",
      headers: { accept: "text/event-stream" },
      payload: { userId: "bob", message: "hi" },
    });
    assert.ok(res.body.includes("data: {\"delta\":\"bob-专属\"}\n\n"), "bob 应命中 bob 的会话");
  } finally {
    await chatApp.close();
  }
});
