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
    model: "openrouter/~deepseek/deepseek-v4-flash-latest",
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

test("getAgent creates independent AgentSession for different employees", async () => {
  const calls: string[] = [];
  const manager = new AgentManager({}, async (userId) => {
    calls.push(userId);
    return makeStubAgent();
  });
  const alice = await manager.getAgent("alice");
  const bob = await manager.getAgent("bob");
  assert.notEqual(alice, bob, "different employees should have independent instances");
  assert.deepEqual(calls, ["alice", "bob"]);
});

test("getAgent reuses the same session for the same employee", async () => {
  let createCount = 0;
  const manager = new AgentManager({}, async () => {
    createCount++;
    return makeStubAgent();
  });
  const a = await manager.getAgent("alice");
  const b = await manager.getAgent("alice");
  assert.equal(a, b, "same employee should reuse the same instance");
  assert.equal(createCount, 1);
});

test("getAgent concurrent requests reuse the same session (created only once)", async () => {
  let createCount = 0;
  const manager = new AgentManager({}, async () => {
    createCount++;
    await new Promise((r) => setTimeout(r, 10));
    return makeStubAgent();
  });
  const results = await Promise.all(
    Array.from({ length: 10 }, () => manager.getAgent("alice")),
  );
  assert.equal(createCount, 1, "concurrent duplicate requests should create only once");
  for (const agent of results) {
    assert.equal(agent, results[0]);
  }
});

test("removeAgent disposes the session, then getAgent creates a new instance", async () => {
  let disposedCount = 0;
  const manager = new AgentManager({}, async () =>
    makeStubAgent(() => {
      disposedCount++;
    }),
  );
  const first = await manager.getAgent("alice");
  assert.equal(manager.size, 1);
  await manager.removeAgent("alice");
  assert.equal(disposedCount, 1, "old instance should be disposed");
  assert.equal(manager.size, 0);
  const second = await manager.getAgent("alice");
  assert.notEqual(first, second, "should create a new instance after disposal");
  assert.equal(disposedCount, 1);
});

test("removeAgent is a no-op for non-existent users", async () => {
  const manager = new AgentManager({}, async () => makeStubAgent());
  await manager.removeAgent("ghost");
  assert.equal(manager.size, 0);
});

test("createEmployeeSessionManager has an independent persistent session directory per employee", () => {
  const alice = createEmployeeSessionManager("alice", { cwd: CWD, sessionDir: sessionBase });
  const bob = createEmployeeSessionManager("bob", { cwd: CWD, sessionDir: sessionBase });
  const alice2 = createEmployeeSessionManager("alice", { cwd: CWD, sessionDir: sessionBase });
  assert.ok(alice.isPersisted());
  assert.notEqual(alice.getSessionDir(), bob.getSessionDir(), "different employee directories should differ");
  assert.equal(alice.getSessionDir(), alice2.getSessionDir(), "same employee directories should be identical");
  assert.ok(
    alice.getSessionDir().startsWith(sessionBase),
    "session should reside under configured sessionDir",
  );
});

test("createEmployeeSessionManager restores the same session after restart", () => {
  const first = createEmployeeSessionManager("alice", { cwd: CWD, sessionDir: sessionBase });
  const id = first.getSessionId();
  type SessionMessage = Parameters<typeof first.appendMessage>[0];
  first.appendMessage({ role: "user", content: "hi" } as unknown as SessionMessage);
  first.appendMessage({ role: "assistant", content: "hello" } as unknown as SessionMessage);
  const resumed = createEmployeeSessionManager("alice", { cwd: CWD, sessionDir: sessionBase });
  assert.equal(resumed.getSessionId(), id, "should restore the same session after restart");
  assert.equal(resumed.buildSessionContext().messages.length, 2, "should restore persisted conversations");
});

test("createEmployeeSessionManager inMemory does not persist", () => {
  const sm = createEmployeeSessionManager("alice", { cwd: CWD, sessionDir: sessionBase, inMemory: true });
  assert.equal(sm.isPersisted(), false);
});
