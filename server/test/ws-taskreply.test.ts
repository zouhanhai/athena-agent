import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { buildApp } from "../src/app.js";
import { AGENT_WS_PATH, type AgentWsGateway } from "../src/ws/agent.js";
import { MemoryAgentRegistry, type AgentRegistry } from "../src/agents/registry.js";

const CAPABILITIES = {
  system: "hermes",
  mcp: [],
  tools: ["shell"],
  skills: [],
  specialty: "coding",
};

interface TestHarness {
  app: FastifyInstance;
  registry: AgentRegistry;
  agentId: string;
  token: string;
  alias: string;
  hub: AgentWsGateway;
  wsUrl: string;
}

/** Build the app with a real (memory) registry so the WS gateway can authenticate. */
async function buildHarness(options: { idleTimeoutMs?: number } = {}): Promise<TestHarness> {
  const registry = new MemoryAgentRegistry();
  const invite = await registry.createInvitation({
    alias: "RemoteHermes",
    owner_employee_id: "e1",
    capabilities: CAPABILITIES,
    runtime: "hermes",
  });
  const app = buildApp({ registry, agentWsIdleTimeoutMs: options.idleTimeoutMs });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const hub = (app as unknown as { agentHub: AgentWsGateway }).agentHub;
  return {
    app,
    registry,
    agentId: invite.invite.agent_id,
    token: invite.invite.token,
    alias: "RemoteHermes",
    hub,
    wsUrl: `ws://127.0.0.1:${address.port}${AGENT_WS_PATH}`,
  };
}

interface WsClient {
  ws: WebSocket;
  waitOpen: () => Promise<void>;
  nextMessage: (timeoutMs?: number) => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
}

function openClient(url: string): WsClient {
  const ws = new WebSocket(url);
  const queue: Record<string, unknown>[] = [];
  const waiters: Array<{
    resolve: (m: Record<string, unknown>) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    } else {
      queue.push(msg);
    }
  });
  return {
    ws,
    waitOpen: () =>
      new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      }),
    nextMessage: (timeoutMs = 3000) => {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for ws message")),
          timeoutMs,
        );
        waiters.push({ resolve, reject, timer });
      });
    },
    close: () =>
      new Promise<void>((resolve) => {
        // A superseded socket (server closed it with 4002 on reconnect) no
        // longer emits "close" again; avoid hanging on repeated close.
        if (ws.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        ws.once("close", () => resolve());
        ws.close();
      }),
  };
}

async function registerAgent(client: WsClient, agentId: string, token: string) {
  await client.waitOpen();
  await client.nextMessage(); // drain welcome
  client.ws.send(JSON.stringify({ type: "register", agent_id: agentId, token }));
  const frame = await client.nextMessage();
  assert.equal(frame.type, "registered");
  assert.equal(frame.agent_id, agentId);
  return frame;
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor condition not met before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("WS contract: registered frame carries the self-describing taskReply contract", async () => {
  const harness = await buildHarness();
  try {
    const client = openClient(harness.wsUrl);
    const frame = await registerAgent(client, harness.agentId, harness.token);
    try {
      const reply = frame.taskReply as Record<string, unknown> | undefined;
      assert.ok(reply, "registered frame must include taskReply");
      assert.equal(reply.mustEchoTaskId, true);
      assert.deepEqual(reply.frames, [
        "task.start",
        "delta",
        "thinking",
        "tool.started",
        "tool.completed",
        "task.complete",
        "task.error",
      ]);
      assert.deepEqual(reply.terminateWith, ["task.complete", "task.error"]);
      assert.equal(typeof reply.idleTimeoutMs, "number");
      assert.match(String((reply.reconnect as Record<string, unknown>).inFlightTasks), /task\.error/i);
    } finally {
      await client.close();
    }
  } finally {
    await harness.app.close();
  }
});

test("WS contract: the taskReply contract is re-sent on EVERY handshake (new connection)", async () => {
  const harness = await buildHarness();
  try {
    const first = openClient(harness.wsUrl);
    const f1 = await registerAgent(first, harness.agentId, harness.token);
    assert.ok(f1.taskReply);
    // Second connection (e.g. agent restart / new session) gets it again
    // without any shared state — handshake self-describes each time.
    const second = openClient(harness.wsUrl);
    const f2 = await registerAgent(second, harness.agentId, harness.token);
    try {
      assert.ok(f2.taskReply, "second handshake must also carry taskReply");
      assert.deepEqual(f2.taskReply, f1.taskReply);
    } finally {
      await second.close();
      await first.close();
    }
  } finally {
    await harness.app.close();
  }
});

test("WS contract: idle timeout auto-errors a task that never acks (task.start) — no silent hang", async () => {
  const harness = await buildHarness({ idleTimeoutMs: 120 });
  try {
    const client = openClient(harness.wsUrl);
    await registerAgent(client, harness.agentId, harness.token);
    try {
      let failed = "";
      const taskId = harness.hub.sendTask(
        harness.agentId,
        { type: "chat.completions", messages: [{ role: "user", content: "hi" }] },
        { onError: (message) => { failed = message; } },
      );
      assert.ok(taskId);
      // Agent receives the task but never sends task.start/delta → server must
      // auto-derive task.error after idleTimeoutMs instead of pending forever.
      const taskFrame = await client.nextMessage();
      assert.equal(taskFrame.type, "task");

      await waitFor(() => failed !== "", 2000);
      assert.match(failed, /idle/i);
    } finally {
      await client.close();
    }
  } finally {
    await harness.app.close();
  }
});

test("WS contract: activity frames (task.start / delta) reset the idle timer", async () => {
  const harness = await buildHarness({ idleTimeoutMs: 150 });
  try {
    const client = openClient(harness.wsUrl);
    await registerAgent(client, harness.agentId, harness.token);
    try {
      let failed = "";
      let completed = false;
      const taskId = harness.hub.sendTask(
        harness.agentId,
        { type: "chat.completions", messages: [] },
        {
          onError: (message) => { failed = message; },
          onComplete: () => { completed = true; },
        },
      );
      assert.ok(taskId);

      const taskFrame = await client.nextMessage();
      assert.equal(taskFrame.type, "task");

      // task.start ack proves receipt → clears the "never received" window.
      client.ws.send(JSON.stringify({ type: "task.start", task_id: taskFrame.task_id }));
      await new Promise((resolve) => setTimeout(resolve, 90)); // less than idle
      assert.equal(failed, "", "task.start must keep the task alive");

      // A delta after that resets the timer again.
      client.ws.send(JSON.stringify({ type: "delta", task_id: taskFrame.task_id, text: "working" }));
      await new Promise((resolve) => setTimeout(resolve, 90));
      assert.equal(failed, "", "delta must keep the task alive");

      // Now finish before the next idle window elapses.
      client.ws.send(JSON.stringify({ type: "task.complete", task_id: taskFrame.task_id }));
      await waitFor(() => completed);
      assert.equal(failed, "");
    } finally {
      await client.close();
    }
  } finally {
    await harness.app.close();
  }
});

test("WS contract: idle error after long silence between activity frames", async () => {
  const harness = await buildHarness({ idleTimeoutMs: 100 });
  try {
    const client = openClient(harness.wsUrl);
    await registerAgent(client, harness.agentId, harness.token);
    try {
      let failed = "";
      const taskId = harness.hub.sendTask(
        harness.agentId,
        { type: "chat.completions", messages: [] },
        { onError: (message) => { failed = message; } },
      );
      assert.ok(taskId);
      const taskFrame = await client.nextMessage();
      assert.equal(taskFrame.type, "task");

      // One ack, then silence long enough to exceed idle.
      client.ws.send(JSON.stringify({ type: "task.start", task_id: taskFrame.task_id }));
      await waitFor(() => failed !== "", 2000);
      assert.match(failed, /idle/i);
    } finally {
      await client.close();
    }
  } finally {
    await harness.app.close();
  }
});

test("WS contract: task complete/error clears the idle timer (no late auto-error)", async () => {
  const harness = await buildHarness({ idleTimeoutMs: 100 });
  try {
    const client = openClient(harness.wsUrl);
    await registerAgent(client, harness.agentId, harness.token);
    try {
      let failed = "";
      let completed = false;
      const taskId = harness.hub.sendTask(
        harness.agentId,
        { type: "chat.completions", messages: [] },
        {
          onError: (message) => { failed = message; },
          onComplete: () => { completed = true; },
        },
      );
      assert.ok(taskId);
      const taskFrame = await client.nextMessage();
      assert.equal(taskFrame.type, "task");

      client.ws.send(JSON.stringify({ type: "delta", task_id: taskFrame.task_id, text: "fast" }));
      client.ws.send(JSON.stringify({ type: "task.complete", task_id: taskFrame.task_id }));
      await waitFor(() => completed);

      // Wait well past idleTimeoutMs — the completed task must NOT error.
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(failed, "");
    } finally {
      await client.close();
    }
  } finally {
    await harness.app.close();
  }
});

test("WS contract: reconnect — in-flight tasks are marked task.error, no re-delivery (documented)", async () => {
  const harness = await buildHarness();
  try {
    const client = openClient(harness.wsUrl);
    await registerAgent(client, harness.agentId, harness.token);
    try {
      let failed = "";
      const taskId = harness.hub.sendTask(
        harness.agentId,
        { type: "chat.completions", messages: [] },
        { onError: (message) => { failed = message; } },
      );
      assert.ok(taskId);
      await client.nextMessage(); // task frame

      // Socket drops mid-task (remote agents see constant 1006 resets).
      await client.close();
      await waitFor(() => failed !== "");
      assert.match(failed, /connection closed/i);
    } finally {
      await client.close();
    }
  } finally {
    await harness.app.close();
  }
});