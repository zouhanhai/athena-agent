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
async function buildHarness(): Promise<TestHarness> {
  const registry = new MemoryAgentRegistry();
  const invite = await registry.createInvitation({
    alias: "RemoteHermes",
    owner_employee_id: "e1",
    capabilities: CAPABILITIES,
    runtime: "hermes",
  });
  const app = buildApp({ registry });
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
        ws.once("close", () => resolve());
        ws.close();
      }),
  };
}

async function registerAgent(client: WsClient, agentId: string, token: string): Promise<Record<string, unknown>> {
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

test("WS reverse tunnel: agent registers auth'd → registered frame + agent marked reachable/connected", async () => {
  const harness = await buildHarness();
  try {
    const client = openClient(harness.wsUrl);
    await registerAgent(client, harness.agentId, harness.token);
    try {
      assert.equal(harness.hub.isConnected(harness.agentId), true);
      assert.deepEqual(harness.hub.connectedAgentIds(), [harness.agentId]);

      // The platform's agent API reflects live reachability (status + connected flag).
      const res = await harness.app.inject({ method: "GET", url: `/api/agents/${harness.alias}` });
      assert.equal(res.statusCode, 200);
      const record = res.json();
      assert.equal(record.status, "reachable");
      assert.equal(record.connected, true);
    } finally {
      await client.close();
    }
    await waitFor(() => !harness.hub.isConnected(harness.agentId));
    assert.deepEqual(harness.hub.connectedAgentIds(), []);
  } finally {
    await harness.app.close();
  }
});

test("WS reverse tunnel: invalid token → error frame + socket closed", async () => {
  const harness = await buildHarness();
  try {
    const client = openClient(harness.wsUrl);
    await client.waitOpen();
    await client.nextMessage(); // drain welcome

    client.ws.send(JSON.stringify({ type: "register", agent_id: harness.agentId, token: "wrong-token" }));
    const frame = await client.nextMessage();
    assert.equal(frame.type, "error");
    assert.match(String(frame.message), /invalid agent_id or token/);

    const closed: { code?: number } = {};
    await new Promise<void>((resolve) => {
      client.ws.once("close", (code) => {
        closed.code = code;
        resolve();
      });
    });
    assert.equal(closed.code, 4001);
    assert.equal(harness.hub.isConnected(harness.agentId), false);
  } finally {
    await harness.app.close();
  }
});

test("WS reverse tunnel: platform pushes a task; agent streams tool.started/tool.completed + deltas + complete", async () => {
  const harness = await buildHarness();
  try {
    const client = openClient(harness.wsUrl);
    await registerAgent(client, harness.agentId, harness.token);
    try {
      const events: string[] = [];
      let completed = false;
      const taskId = harness.hub.sendTask(
        harness.agentId,
        { type: "chat.completions", messages: [{ role: "user", content: "deploy" }] },
        {
          onToolStarted: (tool, detail) => events.push(`started:${tool}:${detail ?? ""}`),
          onToolCompleted: (tool) => events.push(`completed:${tool}`),
          onDelta: (text) => events.push(`delta:${text}`),
          onThinking: (text) => events.push(`thinking:${text}`),
          onComplete: () => {
            completed = true;
          },
        },
      );
      assert.ok(taskId, "task should be pushed to a connected agent");

      const taskFrame = await client.nextMessage();
      assert.equal(taskFrame.type, "task");
      assert.equal((taskFrame.payload as { messages?: unknown[] }).messages?.[0]?.content, "deploy");

      client.ws.send(JSON.stringify({ type: "thinking", task_id: taskFrame.task_id, text: "hmm" }));
      client.ws.send(JSON.stringify({ type: "tool.started", task_id: taskFrame.task_id, tool: "shell", detail: "npm run" }));
      client.ws.send(JSON.stringify({ type: "delta", task_id: taskFrame.task_id, text: "working" }));
      client.ws.send(JSON.stringify({ type: "tool.completed", task_id: taskFrame.task_id, tool: "shell" }));
      client.ws.send(JSON.stringify({ type: "task.complete", task_id: taskFrame.task_id }));

      await waitFor(() => completed);
      assert.deepEqual(events, ["thinking:hmm", "started:shell:npm run", "delta:working", "completed:shell"]);
    } finally {
      await client.close();
    }
  } finally {
    await harness.app.close();
  }
});

test("WS reverse tunnel: tool.completed WITHOUT output (old agent) still relays — output is undefined", async () => {
  const harness = await buildHarness();
  try {
    const client = openClient(harness.wsUrl);
    await registerAgent(client, harness.agentId, harness.token);
    try {
      let completedTool = "";
      let completedError: string | undefined = "sentinel";
      let completedOutput: string | undefined = "sentinel";
      const taskId = harness.hub.sendTask(
        harness.agentId,
        { type: "chat.completions", messages: [] },
        {
          onToolCompleted: (tool, _detail, error, output) => {
            completedTool = tool;
            completedError = error;
            completedOutput = output;
          },
        },
      );
      assert.ok(taskId);
      const taskFrame = await client.nextMessage();
      assert.equal(taskFrame.type, "task");

      // Old-style frame: only detail, no output → must not fail and must not
      // fabricate output.
      client.ws.send(JSON.stringify({ type: "tool.completed", task_id: taskFrame.task_id, tool: "shell", detail: "ran" }));
      await waitFor(() => completedTool === "shell");
      assert.equal(completedError, undefined);
      assert.equal(completedOutput, undefined, "absent output relays as undefined (old-agent compat)");
    } finally {
      await client.close();
    }
  } finally {
    await harness.app.close();
  }
});

test("WS reverse tunnel: tool.completed WITH output relays the tool result content", async () => {
  const harness = await buildHarness();
  try {
    const client = openClient(harness.wsUrl);
    await registerAgent(client, harness.agentId, harness.token);
    try {
      let receivedOutput: string | undefined;
      let receivedDetail: string | undefined;
      const taskId = harness.hub.sendTask(
        harness.agentId,
        { type: "chat.completions", messages: [] },
        {
          onToolCompleted: (tool, detail, _error, output) => {
            receivedDetail = detail;
            receivedOutput = output;
          },
        },
      );
      assert.ok(taskId);
      const taskFrame = await client.nextMessage();
      assert.equal(taskFrame.type, "task");

      client.ws.send(
        JSON.stringify({
          type: "tool.completed",
          task_id: taskFrame.task_id,
          tool: "shell",
          detail: "npm run build",
          output: "exit 0\nbuild artifacts written",
        }),
      );
      await waitFor(() => receivedOutput === "exit 0\nbuild artifacts written");
      assert.equal(receivedDetail, "npm run build");
    } finally {
      await client.close();
    }
  } finally {
    await harness.app.close();
  }
});

test("WS reverse tunnel: chat route streams tool progress + result over the tunnel (end-to-end)", async () => {
  const harness = await buildHarness();
  try {
    const client = openClient(harness.wsUrl);
    await registerAgent(client, harness.agentId, harness.token);
    try {
      const ssePromise = harness.app.inject({
        method: "POST",
        url: "/api/chat",
        headers: { accept: "text/event-stream" },
        payload: { userId: "hermes", message: "deploy the app", agent_id: harness.agentId },
      });

      const taskFrame = await client.nextMessage();
      assert.equal(taskFrame.type, "task");
      client.ws.send(JSON.stringify({ type: "thinking", task_id: taskFrame.task_id, text: "reasoning" }));
      client.ws.send(JSON.stringify({ type: "tool.started", task_id: taskFrame.task_id, tool: "shell", detail: "build" }));
      client.ws.send(JSON.stringify({ type: "delta", task_id: taskFrame.task_id, text: "Building..." }));
      client.ws.send(JSON.stringify({ type: "tool.completed", task_id: taskFrame.task_id, tool: "shell" }));
      client.ws.send(JSON.stringify({ type: "delta", task_id: taskFrame.task_id, text: "done" }));
      client.ws.send(JSON.stringify({ type: "task.complete", task_id: taskFrame.task_id }));

      const sse = await ssePromise;
      assert.equal(sse.statusCode, 200);
      const body: string = sse.body;
      assert.ok(body.includes(`data: ${JSON.stringify({ thinking: "reasoning" })}\n\n`), "thinking relayed");
      assert.ok(body.includes(`data: ${JSON.stringify({ tool: { state: "started", name: "shell", detail: "build" } })}\n\n`), "tool.started relayed");
      assert.ok(body.includes(`data: ${JSON.stringify({ delta: "Building..." })}\n\n`), "delta relayed");
      assert.ok(body.includes(`data: ${JSON.stringify({ tool: { state: "completed", name: "shell" } })}\n\n`), "tool.completed relayed");
      assert.ok(body.includes(`data: ${JSON.stringify({ done: true })}\n\n`), "done frame");
    } finally {
      await client.close();
    }
  } finally {
    await harness.app.close();
  }
});

test("WS reverse tunnel: chat route relays tool output (tool.completed output) into the SSE tool frame", async () => {
  const harness = await buildHarness();
  try {
    const client = openClient(harness.wsUrl);
    await registerAgent(client, harness.agentId, harness.token);
    try {
      const ssePromise = harness.app.inject({
        method: "POST",
        url: "/api/chat",
        headers: { accept: "text/event-stream" },
        payload: { userId: "hermes", message: "inspect", agent_id: harness.agentId },
      });

      const taskFrame = await client.nextMessage();
      assert.equal(taskFrame.type, "task");
      client.ws.send(
        JSON.stringify({
          type: "tool.completed",
          task_id: taskFrame.task_id,
          tool: "shell",
          detail: "inspect",
          output: "pid 1234 is healthy",
        }),
      );
      client.ws.send(JSON.stringify({ type: "task.complete", task_id: taskFrame.task_id }));

      const sse = await ssePromise;
      assert.equal(sse.statusCode, 200);
      assert.ok(
        sse.body.includes(
          `data: ${JSON.stringify({ tool: { state: "completed", name: "shell", detail: "inspect", output: "pid 1234 is healthy" } })}\n\n`,
        ),
        "tool output relayed into the SSE tool frame",
      );
      assert.ok(sse.body.includes(`data: ${JSON.stringify({ done: true })}\n\n`), "done frame");
    } finally {
      await client.close();
    }
  } finally {
    await harness.app.close();
  }
});

test("WS reverse tunnel: non-streaming chat collects the agent's answer over the tunnel", async () => {
  const harness = await buildHarness();
  try {
    const client = openClient(harness.wsUrl);
    await registerAgent(client, harness.agentId, harness.token);
    try {
      const injectPromise = harness.app.inject({
        method: "POST",
        url: "/api/chat",
        payload: { userId: "hermes", message: "sum it up", agent_id: harness.agentId },
      });

      const taskFrame = await client.nextMessage();
      assert.equal(taskFrame.type, "task");
      client.ws.send(JSON.stringify({ type: "delta", task_id: taskFrame.task_id, text: "the " }));
      client.ws.send(JSON.stringify({ type: "delta", task_id: taskFrame.task_id, text: "answer" }));
      client.ws.send(JSON.stringify({ type: "task.complete", task_id: taskFrame.task_id }));

      const res = await injectPromise;
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { reply: "the answer" });
    } finally {
      await client.close();
    }
  } finally {
    await harness.app.close();
  }
});

test("WS reverse tunnel: chat to an offline agent returns an SSE offline error", async () => {
  const harness = await buildHarness();
  try {
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { accept: "text/event-stream" },
      payload: { userId: "hermes", message: "ping", agent_id: harness.agentId },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes("offline"), "should explain the agent is offline");
    assert.ok(res.body.includes(`data: ${JSON.stringify({ done: true })}\n\n`));
  } finally {
    await harness.app.close();
  }
});

test("WS reverse tunnel: reconnect supersedes the old tunnel and disconnects report in-flight error", async () => {
  const harness = await buildHarness();
  try {
    const first = openClient(harness.wsUrl);
    await registerAgent(first, harness.agentId, harness.token);
    assert.equal(harness.hub.isConnected(harness.agentId), true);

    // An in-flight task on the first connection fails fast when the tunnel is
    // superseded/closed.
    let failed = "";
    const taskId = harness.hub.sendTask(harness.agentId, { type: "chat.completions", messages: [] }, {
      onError: (message) => {
        failed = message;
      },
    });
    assert.ok(taskId);

    // Second connection re-authenticates and takes over the tunnel slot.
    const second = openClient(harness.wsUrl);
    await registerAgent(second, harness.agentId, harness.token);
    try {
      await waitFor(() => failed !== "");
      assert.match(failed, /superseded|connection/i);

      // Old socket is retired; the newest tunnel answers task pushes.
      const events: string[] = [];
      await waitFor(() => harness.hub.connectedAgentIds().length === 1);
      const newTask = harness.hub.sendTask(harness.agentId, { type: "chat.completions", messages: [] }, {
        onDelta: (text) => events.push(text),
      });
      assert.ok(newTask);
      const taskFrame = await second.nextMessage();
      assert.equal(taskFrame.type, "task");
      second.ws.send(JSON.stringify({ type: "delta", task_id: taskFrame.task_id, text: "resumed" }));
      second.ws.send(JSON.stringify({ type: "task.complete", task_id: taskFrame.task_id }));
      await waitFor(() => events.length > 0);
      assert.deepEqual(events, ["resumed"]);
    } finally {
      await second.close();
    }
  } finally {
    await harness.app.close();
  }
});

test("WS registered frame carries frameSchema (per-frame field contract) — connectors read payload field names from the handshake", async () => {
  const harness = await buildHarness();
  try {
    const client = openClient(harness.wsUrl);
    const registered = await registerAgent(client, harness.agentId, harness.token);
    try {
      const taskReply = registered.taskReply as Record<string, unknown>;
      assert.ok(taskReply, "registered frame must carry taskReply");
      const schema = taskReply.frameSchema as Record<string, unknown>;
      assert.ok(schema, "taskReply must carry frameSchema");
      const delta = schema.delta as { payloadField?: string };
      const thinking = schema.thinking as { payloadField?: string };
      assert.equal(delta.payloadField, "delta");
      assert.equal(thinking.payloadField, "thinking");
    } finally {
      await client.close();
    }
  } finally {
    await harness.app.close();
  }
});

test("WS delta/thinking frames from the reference connector (`delta`/`thinking` field names) are relayed — compat with `text`", async () => {
  const harness = await buildHarness();
  try {
    const client = openClient(harness.wsUrl);
    await registerAgent(client, harness.agentId, harness.token);
    try {
      const events: string[] = [];
      let completed = false;
      const taskId = harness.hub.sendTask(
        harness.agentId,
        { type: "chat.completions", messages: [{ role: "user", content: "hi" }] },
        {
          onDelta: (text) => events.push(`delta:${text}`),
          onThinking: (text) => events.push(`thinking:${text}`),
          onComplete: () => {
            completed = true;
          },
        },
      );
      assert.ok(taskId, "task should be pushed to a connected agent");

      const taskFrame = await client.nextMessage();
      assert.equal(taskFrame.type, "task");

      // Reference connector (connectors/reference-node/index.js) sends the
      // payload under the frame name itself: `delta` and `thinking`.
      client.ws.send(JSON.stringify({ type: "delta", task_id: taskFrame.task_id, delta: "Hello! " }));
      client.ws.send(JSON.stringify({ type: "thinking", task_id: taskFrame.task_id, thinking: "reasoning" }));
      client.ws.send(JSON.stringify({ type: "delta", task_id: taskFrame.task_id, delta: "What can I help?" }));
      client.ws.send(JSON.stringify({ type: "task.complete", task_id: taskFrame.task_id }));

      await waitFor(() => completed);
      assert.deepEqual(events, ["delta:Hello! ", "thinking:reasoning", "delta:What can I help?"]);
    } finally {
      await client.close();
    }
  } finally {
    await harness.app.close();
  }
});