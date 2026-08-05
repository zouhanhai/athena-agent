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
          throw new Error("服务未启动");
        },
      } as never,
      model: "deepseek/deepseek-v4-flash",
      packages: [],
      extensionErrors: [],
      prompt: async () => {
        throw new Error("服务未启动");
      },
      dispose: () => {},
    } as unknown as Agent;
  });
}

test("E2E 单条消息 → 非流式返回回答并写入会话", async () => {
  const res = await chat("alice", "用一句话介绍你自己");
  assert.equal(res.statusCode, 200);
  const reply = (res.json() as { reply: string }).reply;
  assert.equal(typeof reply, "string");
  assert.ok(reply.trim().length > 0, "回答不应为空");
  const users = (await sessionMessages("alice")).filter((m) => m.role === "user");
  assert.equal(users.length, 1, "会话应记录该用户消息");
});

test("E2E 单条消息 → 流式逐块返回 delta 并以 done 结束", async () => {
  const res = await chat("alice", "用一句话介绍你自己", { accept: "text/event-stream" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /^text\/event-stream/);
  const frames = res.body
    .trim()
    .split("\n\n")
    .map((f) => JSON.parse(f.replace(/^data: /, "")));
  assert.ok(
    frames.some((f) => typeof f.delta === "string" && f.delta.length > 0),
    "应产出文本 delta",
  );
  assert.equal(frames[frames.length - 1].done, true, "应以 done 事件结束");
});

test("E2E 多轮对话（同 userId）保持上下文并复用 session", async () => {
  const first = await chat("alice", "我的名字是林小满。请记住我的名字，这一轮只回复两个字：好的");
  assert.equal(first.statusCode, 200);

  const second = await chat("alice", "我叫什么名字？只回答我的名字");
  assert.equal(second.statusCode, 200);
  const reply = (second.json() as { reply: string }).reply;
  assert.ok(reply.includes("林小满"), `第二轮应能记住第一轮的名字, 实际: ${reply}`);

  assert.equal(manager.size, 1, "同一员工不应新建会话实例");
  const users = (await sessionMessages("alice")).filter((m) => m.role === "user");
  assert.equal(users.length, 2, "会话历史应保留两轮用户消息");
  assert.ok(users[0].content.includes("林小满"), "第一轮消息应保留在会话历史中");
});

test("E2E 不同 userId 上下文隔离（不串会话）", async () => {
  const token = randomToken();
  await chat("alice", `请记住这个令牌: ${token}。这一轮只回复: ok`);
  const bobRes = await chat("bob", "你好，打个招呼");
  assert.equal(bobRes.statusCode, 200);

  assert.equal(manager.size, 2, "两位员工应为独立会话");
  const bobMessages = await sessionMessages("bob");
  const aliceMessages = await sessionMessages("alice");
  assert.ok(!JSON.stringify(bobMessages).includes(token), "bob 的会话不应包含 alice 的令牌");
  assert.ok(JSON.stringify(aliceMessages).includes(token), "alice 的会话应保留她自己的令牌");
  assert.ok(
    !(bobRes.json() as { reply: string }).reply.includes(token),
    "bob 的回答不应泄露 alice 的令牌",
  );
});

test("E2E 错误处理: 空消息/缺字段/非字符串 → 400", async () => {
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
    assert.equal(res.statusCode, 400, `payload=${JSON.stringify(payload)} 应返回 400`);
    assert.equal(typeof (res.json() as { error: string }).error, "string");
  }
});

test("E2E 错误处理: 对话服务未启动 → 非流式返回 500 + 错误信息", async () => {
  const failingManager = makeFailingManager();
  const failingApp = buildApp({ manager: failingManager });
  try {
    const res = await failingApp.inject({
      method: "POST",
      url: "/api/chat",
      payload: { userId: "alice", message: "hi" },
    });
    assert.equal(res.statusCode, 500, "上游模型不可用应返回 500");
    assert.equal((res.json() as { error: string }).error, "服务未启动");
  } finally {
    await failingApp.close();
  }
});

test("E2E 错误处理: 对话服务未启动 → 流式返回 SSE error 帧", async () => {
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
    assert.match(res.body, /"error":"服务未启动"/, "流式响应应包含 error 帧");
  } finally {
    await failingApp.close();
  }
});
