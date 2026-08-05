import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Agent } from "../src/agents/agent.js";
import { AgentManager, createEmployeeSessionManager } from "../src/agents/manager.js";

const CWD = "/tmp/athena-agent-employee";
let sessionBase: string;
let tmpRoots: string[] = [];

function makeStubAgent(disposed: () => void = () => {}): Agent {
  return {
    session: {} as never,
    model: "deepseek/deepseek-v4-flash",
    packages: [],
    extensionErrors: [],
    prompt: async () => "ok",
    dispose: disposed,
  } as unknown as Agent;
}

function tmpSessionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "athena-manager-"));
  tmpRoots.push(dir);
  return dir;
}

beforeEach(() => {
  sessionBase = tmpSessionDir();
  tmpRoots = [sessionBase];
});

test.after(() => {
  for (const root of tmpRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("getAgent 不同员工创建独立 AgentSession", async () => {
  const calls: string[] = [];
  const manager = new AgentManager({}, async (userId) => {
    calls.push(userId);
    return makeStubAgent();
  });
  const alice = await manager.getAgent("alice");
  const bob = await manager.getAgent("bob");
  assert.notEqual(alice, bob, "不同员工应为独立实例");
  assert.deepEqual(calls, ["alice", "bob"]);
});

test("getAgent 同一员工复用同一 session", async () => {
  let createCount = 0;
  const manager = new AgentManager({}, async () => {
    createCount++;
    return makeStubAgent();
  });
  const a = await manager.getAgent("alice");
  const b = await manager.getAgent("alice");
  assert.equal(a, b, "同员工应复用同一实例");
  assert.equal(createCount, 1);
});

test("getAgent 并发请求复用同一 session（只创建一次）", async () => {
  let createCount = 0;
  const manager = new AgentManager({}, async () => {
    createCount++;
    await new Promise((r) => setTimeout(r, 10));
    return makeStubAgent();
  });
  const results = await Promise.all(
    Array.from({ length: 10 }, () => manager.getAgent("alice")),
  );
  assert.equal(createCount, 1, "并发重复请求应只创建一次");
  for (const agent of results) {
    assert.equal(agent, results[0]);
  }
});

test("removeAgent 销毁会话，之后 getAgent 创建新实例", async () => {
  let disposedCount = 0;
  const manager = new AgentManager({}, async () =>
    makeStubAgent(() => {
      disposedCount++;
    }),
  );
  const first = await manager.getAgent("alice");
  assert.equal(manager.size, 1);
  await manager.removeAgent("alice");
  assert.equal(disposedCount, 1, "旧实例应被销毁");
  assert.equal(manager.size, 0);
  const second = await manager.getAgent("alice");
  assert.notEqual(first, second, "销毁后应创建新实例");
  assert.equal(disposedCount, 1);
});

test("removeAgent 不存在的用户为 no-op", async () => {
  const manager = new AgentManager({}, async () => makeStubAgent());
  await manager.removeAgent("ghost");
  assert.equal(manager.size, 0);
});

test("createEmployeeSessionManager 每员工独立持久化 session 目录", () => {
  const alice = createEmployeeSessionManager("alice", { cwd: CWD, sessionDir: sessionBase });
  const bob = createEmployeeSessionManager("bob", { cwd: CWD, sessionDir: sessionBase });
  const alice2 = createEmployeeSessionManager("alice", { cwd: CWD, sessionDir: sessionBase });
  assert.ok(alice.isPersisted());
  assert.notEqual(alice.getSessionDir(), bob.getSessionDir(), "不同员工目录应不同");
  assert.equal(alice.getSessionDir(), alice2.getSessionDir(), "同员工目录应一致");
  assert.ok(
    alice.getSessionDir().startsWith(sessionBase),
    "session 应落在配置的 sessionDir 下",
  );
});

test("createEmployeeSessionManager 重启后恢复同一会话", () => {
  const first = createEmployeeSessionManager("alice", { cwd: CWD, sessionDir: sessionBase });
  const id = first.getSessionId();
  type SessionMessage = Parameters<typeof first.appendMessage>[0];
  first.appendMessage({ role: "user", content: "hi" } as unknown as SessionMessage);
  first.appendMessage({ role: "assistant", content: "hello" } as unknown as SessionMessage);
  const resumed = createEmployeeSessionManager("alice", { cwd: CWD, sessionDir: sessionBase });
  assert.equal(resumed.getSessionId(), id, "重启后应恢复同一会话");
  assert.equal(resumed.buildSessionContext().messages.length, 2, "应恢复已持久化的对话");
});

test("createEmployeeSessionManager inMemory 不持久化", () => {
  const sm = createEmployeeSessionManager("alice", { cwd: CWD, sessionDir: sessionBase, inMemory: true });
  assert.equal(sm.isPersisted(), false);
});
