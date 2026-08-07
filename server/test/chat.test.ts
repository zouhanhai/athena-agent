import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { AgentManager } from "../src/agents/manager.js";
import type { Agent } from "../src/agents/agent.js";
import type { FastifyInstance } from "fastify";

type EventListener = (event: unknown) => void;

interface FakeSession {
  chunks: string[];
  prompts: string[];
  subscribe(listener: EventListener): () => void;
  prompt(text: string): Promise<void>;
}

function makeFakeSession(chunks: string[]): FakeSession {
  const listeners = new Set<EventListener>();
  const session: FakeSession = {
    chunks,
    prompts: [],
    subscribe(listener: EventListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async prompt(text: string): Promise<void> {
      session.prompts.push(text);
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
  return session;
}

function makeStubAgent(session: FakeSession): Agent {
  return {
    session,
    model: "openrouter/~deepseek/deepseek-v4-flash-latest",
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

test("POST /api/chat injects page-specific capabilities into the prompt (Workbench → GitHub)", async () => {
  const session = makeFakeSession(["w1", "-chunk"]);
  const manager = new AgentManager({}, async () => makeStubAgent(session));
  const chatApp = buildApp({ manager });
  try {
    const res = await chatApp.inject({
      method: "POST",
      url: "/api/chat",
      headers: { accept: "text/event-stream" },
      payload: { userId: "alice", message: "list my repos", page: "/workbench" },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(session.prompts.length === 1, "session should have received one prompt");
    const prompt = session.prompts[0]!;
    assert.ok(prompt.includes("Workbench"), "should name the current page");
    assert.ok(prompt.includes("GitHub"), "should inject GitHub capabilities");
    assert.ok(prompt.endsWith("list my repos"), "user message should be preserved at the end");
  } finally {
    await chatApp.close();
  }
});

test("POST /api/chat injects knowledge tools for Knowledge / Wiki pages", async () => {
  for (const page of ["/knowledge", "/wiki"]) {
    const session = makeFakeSession(["k"]);
    const manager = new AgentManager({}, async () => makeStubAgent(session));
    const chatApp = buildApp({ manager });
    try {
      await chatApp.inject({
        method: "POST",
        url: "/api/chat",
        headers: { accept: "text/event-stream" },
        payload: { userId: "alice", message: "explain RAG", page },
      });
      assert.ok(session.prompts[0]!.includes("knowledge_search"), `${page} should inject knowledge_search`);
      assert.ok(session.prompts[0]!.includes("wiki_search"), `${page} should inject wiki_search`);
    } finally {
      await chatApp.close();
    }
  }
});

test("POST /api/chat with no page leaves the prompt unchanged (no injection)", async () => {
  const session = makeFakeSession(["n"]);
  const manager = new AgentManager({}, async () => makeStubAgent(session));
  const chatApp = buildApp({ manager });
  try {
    const res = await chatApp.inject({
      method: "POST",
      url: "/api/chat",
      headers: { accept: "text/event-stream" },
      payload: { userId: "alice", message: "plain question" },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(session.prompts, ["plain question"]);
  } finally {
    await chatApp.close();
  }
});

test("POST /api/chat same userId across pages keeps ONE shared session (context persists)", async () => {
  let factoryCalls = 0;
  const session = makeFakeSession(["c"]);
  const manager = new AgentManager({}, async () => {
    factoryCalls++;
    return makeStubAgent(session);
  });
  const chatApp = buildApp({ manager });
  try {
    await chatApp.inject({
      method: "POST",
      url: "/api/chat",
      headers: { accept: "text/event-stream" },
      payload: { userId: "alice", message: "first", page: "/knowledge" },
    });
    await chatApp.inject({
      method: "POST",
      url: "/api/chat",
      headers: { accept: "text/event-stream" },
      payload: { userId: "alice", message: "second", page: "/workbench" },
    });
    assert.equal(factoryCalls, 1, "switching pages must not create a new session");
    assert.equal(session.prompts.length, 2, "both turns should go to the same session");
    assert.ok(session.prompts[0]!.includes("knowledge"), "first turn carries knowledge injection");
    assert.ok(session.prompts[1]!.includes("GitHub"), "second turn carries workbench injection");
  } finally {
    await chatApp.close();
  }
});
