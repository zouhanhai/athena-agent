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
    prompt: async () => "mock reply",
    dispose: () => {},
  } as unknown as Agent;
}

let app: FastifyInstance;

beforeEach(async () => {
  const manager = new AgentManager({}, async (userId) => makeStubAgent(makeFakeSession([`${userId}-chunk1`, "-chunk2"])));
  app = buildApp({ manager });
});

after(async () => {
  if (app) {
    await app.close();
  }
});

test("POST /api/chat non-streaming returns Pi answer", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/chat",
    payload: { userId: "alice", message: "hi" },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { reply: "mock reply" });
});

test("POST /api/chat streaming (Accept: text/event-stream) returns SSE chunk by chunk", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/chat",
    headers: { accept: "text/event-stream" },
    payload: { userId: "alice", message: "hi" },
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /^text\/event-stream/);
  const body = res.body;
  assert.ok(body.includes(`data: ${JSON.stringify({ delta: "alice-chunk1" })}\n\n`), "should contain first delta chunk");
  assert.ok(body.includes(`data: ${JSON.stringify({ delta: "-chunk2" })}\n\n`), "should contain second delta chunk");
  assert.ok(body.includes(`data: ${JSON.stringify({ done: true })}\n\n`), "should end with done event");
});

test("POST /api/chat missing message returns 400", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/chat",
    payload: { userId: "alice" },
  });
  assert.equal(res.statusCode, 400);
});

test("POST /api/chat missing userId returns 400", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/chat",
    payload: { message: "hi" },
  });
  assert.equal(res.statusCode, 400);
});

test("POST /api/chat different userId creates independent sessions", async () => {
  const manager = new AgentManager({}, async (userId) => makeStubAgent(makeFakeSession([`${userId}-dedicated`])));
  const chatApp = buildApp({ manager });
  try {
    const res = await chatApp.inject({
      method: "POST",
      url: "/api/chat",
      headers: { accept: "text/event-stream" },
      payload: { userId: "bob", message: "hi" },
    });
    assert.ok(res.body.includes("data: {\"delta\":\"bob-dedicated\"}\n\n"), "bob should hit bob's session");
  } finally {
    await chatApp.close();
  }
});
