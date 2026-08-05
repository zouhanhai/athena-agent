import { randomBytes } from "node:crypto";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { AgentManager } from "../src/agents/manager.js";
import type { Agent } from "../src/agents/agent.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let manager: AgentManager;

beforeEach(() => {
  manager = new AgentManager({ inMemory: true });
  app = buildApp({ manager });
});

afterEach(async () => {
  if (app) {
    await app.close();
  }
  if (manager) {
    await manager.dispose();
  }
});

async function chat(
  userId: string,
  message: string,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: "/api/chat",
    headers,
    payload: { userId, message },
  });
}

async function sessionMessages(userId: string): Promise<Array<{ role: string; content: string }>> {
  return manager.getSessionMessages(userId);
}

function randomToken(): string {
  return `SKY-${randomBytes(3).toString("hex").toUpperCase()}`;
}

function makeFailingManager(): AgentManager {
  return new AgentManager({}, async () => {
    return {
      session: {
        subscribe() {
          return () => {};
        },
        prompt: async () => {
          throw new Error("service not started");
        },
      } as never,
      model: "openrouter/deepseek/deepseek-v4-flash",
      packages: [],
      extensionErrors: [],
      prompt: async () => {
        throw new Error("service not started");
      },
      dispose: () => {},
    } as unknown as Agent;
  });
}

test("E2E single message → non-streaming response with answer written to session", async () => {
  const res = await chat("alice", "用一句话介绍你自己");
  assert.equal(res.statusCode, 200);
  const reply = (res.json() as { reply: string }).reply;
  assert.equal(typeof reply, "string");
  assert.ok(reply.trim().length > 0, "reply should not be empty");
  const users = (await sessionMessages("alice")).filter((m) => m.role === "user");
  assert.equal(users.length, 1, "session should record the user message");
});

test("E2E single message → streaming returns deltas chunk by chunk and ends with done", async () => {
  const res = await chat("alice", "用一句话介绍你自己", { accept: "text/event-stream" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /^text\/event-stream/);
  const frames = res.body
    .trim()
    .split("\n\n")
    .map((f) => JSON.parse(f.replace(/^data: /, "")));
  assert.ok(
    frames.some((f) => typeof f.delta === "string" && f.delta.length > 0),
    "should produce text deltas",
  );
  assert.equal(frames[frames.length - 1].done, true, "should end with done event");
});

test("E2E multi-turn conversation (same userId) maintains context and reuses session", async () => {
  const first = await chat("alice", "我的名字是林小满。请记住我的名字，这一轮只回复两个字：好的");
  assert.equal(first.statusCode, 200);

  const second = await chat("alice", "我叫什么名字？只回答我的名字");
  assert.equal(second.statusCode, 200);
  const reply = (second.json() as { reply: string }).reply;
  assert.ok(reply.includes("林小满"), `second round should remember the name from first round, actual: ${reply}`);

  assert.equal(manager.size, 1, "same employee should not create new session instance");
  const users = (await sessionMessages("alice")).filter((m) => m.role === "user");
  assert.equal(users.length, 2, "session history should retain two rounds of user messages");
  assert.ok(users[0].content.includes("林小满"), "first round message should remain in session history");
});

test("E2E different userId context isolation (no cross-session leak)", async () => {
  const token = randomToken();
  await chat("alice", `请记住这个令牌: ${token}。这一轮只回复: ok`);
  const bobRes = await chat("bob", "你好，打个招呼");
  assert.equal(bobRes.statusCode, 200);

  assert.equal(manager.size, 2, "two employees should have independent sessions");
  const bobMessages = await sessionMessages("bob");
  const aliceMessages = await sessionMessages("alice");
  assert.ok(!JSON.stringify(bobMessages).includes(token), "bob's session should not contain alice's token");
  assert.ok(JSON.stringify(aliceMessages).includes(token), "alice's session should preserve her own token");
  assert.ok(
    !(bobRes.json() as { reply: string }).reply.includes(token),
    "bob's reply should not leak alice's token",
  );
});

test("E2E error handling: empty message/missing field/non-string → 400", async () => {
  const cases: Array<{ payload: unknown }> = [
    { payload: { userId: "alice", message: "" } },
    { payload: { userId: "alice", message: "   " } },
    { payload: { userId: "alice" } },
    { payload: { message: "hi" } },
    { payload: { userId: "", message: "hi" } },
    { payload: { userId: "alice", message: 42 } },
  ];
  for (const { payload } of cases) {
    const res = await app.inject({ method: "POST", url: "/api/chat", payload });
    assert.equal(res.statusCode, 400, `payload=${JSON.stringify(payload)} should return 400`);
    assert.equal(typeof (res.json() as { error: string }).error, "string");
  }
});

test("E2E error handling: agent service not started → non-streaming returns 500 + error message", async () => {
  const failingManager = makeFailingManager();
  const failingApp = buildApp({ manager: failingManager });
  try {
    const res = await failingApp.inject({
      method: "POST",
      url: "/api/chat",
      payload: { userId: "alice", message: "hi" },
    });
    assert.equal(res.statusCode, 500, "upstream model unavailable should return 500");
    assert.equal((res.json() as { error: string }).error, "service not started");
  } finally {
    await failingApp.close();
  }
});

test("E2E error handling: agent service not started → streaming returns SSE error frame", async () => {
  const failingManager = makeFailingManager();
  const failingApp = buildApp({ manager: failingManager });
  try {
    const res = await failingApp.inject({
      method: "POST",
      url: "/api/chat",
      headers: { accept: "text/event-stream" },
      payload: { userId: "alice", message: "hi" },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /"error":"service not started"/, "streaming response should contain error frame");
  } finally {
    await failingApp.close();
  }
});
