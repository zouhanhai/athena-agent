import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { buildApp } from "../src/app.js";
import { AGENT_WS_PATH, type AgentWsGateway } from "../src/ws/agent.js";
import { MemoryAgentRegistry, type AgentRegistry } from "../src/agents/registry.js";
import { KnowledgeRetrievalService } from "../src/kb/retrieval.js";
import { LlmWikiClient } from "../src/kb/llmwiki.js";
import type { Summarizer, ChatTurn } from "../src/agents/chat-context.js";

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
  hub: AgentWsGateway;
  wsUrl: string;
}

async function buildHarness(summarizer?: Summarizer): Promise<TestHarness> {
  // The default taskQueue/retrieval build OpenRouterEmbedder which requires
  // EMBEDDING_OPENROUTER_KEY at construction (never called in these tests).
  process.env.EMBEDDING_OPENROUTER_KEY ??= "test-embedding-key";
  const registry = new MemoryAgentRegistry();
  const invite = await registry.createInvitation({
    alias: "RemoteHermes",
    owner_employee_id: "e1",
    capabilities: CAPABILITIES,
    runtime: "hermes",
  });
  // A minimal retrieval (no Neo4j/embedding wiring) keeps the harness independent
  // of the ambient EMBEDDING_OPENROUTER_KEY env used by the default retrieval.
  const retrieval = new KnowledgeRetrievalService({ llmwiki: new LlmWikiClient() });
  const app = buildApp({ registry, retrieval, summarizer });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const hub = (app as unknown as { agentHub: AgentWsGateway }).agentHub;
  return {
    app,
    registry,
    agentId: invite.invite.agent_id,
    token: invite.invite.token,
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

async function registerAgent(client: WsClient, agentId: string, token: string) {
  await client.waitOpen();
  await client.nextMessage(); // drain welcome
  client.ws.send(JSON.stringify({ type: "register", agent_id: agentId, token }));
  const frame = await client.nextMessage();
  assert.equal(frame.type, "registered");
  assert.equal(frame.agent_id, agentId);
}

test("remote chat: history body field is accepted and pushed with the task (passthrough below threshold)", async () => {
  const harness = await buildHarness();
  try {
    const client = openClient(harness.wsUrl);
    await registerAgent(client, harness.agentId, harness.token);
    try {
      const history: ChatTurn[] = [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second question" },
      ];
      const injectPromise = harness.app.inject({
        method: "POST",
        url: "/api/chat",
        headers: { accept: "text/event-stream" },
        payload: {
          userId: "hermes",
          message: "deploy the app",
          agent_id: harness.agentId,
          history,
        },
      });

      const taskFrame = await client.nextMessage();
      assert.equal(taskFrame.type, "task");
      const messages = (taskFrame.payload as { messages?: ChatTurn[] }).messages;
      assert.ok(messages, "task carries messages");
      assert.deepEqual(
        messages!.slice(0, 3),
        history,
        "history preserved verbatim in the remote task payload",
      );
      assert.equal(messages![messages!.length - 1]!.content, "deploy the app");
      assert.equal(messages![messages!.length - 1]!.role, "user");

      client.ws.send(JSON.stringify({ type: "delta", task_id: taskFrame.task_id, text: "ok" }));
      client.ws.send(JSON.stringify({ type: "task.complete", task_id: taskFrame.task_id }));
      const res = await injectPromise;
      assert.equal(res.statusCode, 200);
    } finally {
      await client.close();
    }
  } finally {
    await harness.app.close();
  }
});

test("remote chat: malformed history is filtered (empty content dropped, capped at 200 turns)", async () => {
  const harness = await buildHarness();
  try {
    const client = openClient(harness.wsUrl);
    await registerAgent(client, harness.agentId, harness.token);
    try {
      const history = [
        { role: "user", content: "  " },
        { role: "assistant", content: "kept answer" },
        { role: "user", content: "kept question" },
        { role: "bogus", content: 123 },
        { role: "system", content: "system kept" },
      ];
      const injectPromise = harness.app.inject({
        method: "POST",
        url: "/api/chat",
        headers: { accept: "text/event-stream" },
        payload: {
          userId: "hermes",
          message: "go",
          agent_id: harness.agentId,
          history,
        },
      });

      const taskFrame = await client.nextMessage();
      const messages = (taskFrame.payload as { messages?: ChatTurn[] }).messages!;
      assert.deepEqual(
        messages.slice(0, 3),
        [
          { role: "assistant", content: "kept answer" },
          { role: "user", content: "kept question" },
          { role: "system", content: "system kept" },
        ],
        "empty + non-string entries dropped, valid ones kept in order",
      );

      client.ws.send(JSON.stringify({ type: "task.complete", task_id: taskFrame.task_id }));
      await injectPromise;
    } finally {
      await client.close();
    }
  } finally {
    await harness.app.close();
  }
});

test("remote chat: history carrying thinking + tool output is accepted and forwarded into the task payload", async () => {
  const harness = await buildHarness();
  try {
    const client = openClient(harness.wsUrl);
    await registerAgent(client, harness.agentId, harness.token);
    try {
      const history: ChatTurn[] = [
        { role: "user", content: "find the bug" },
        {
          role: "assistant",
          content: "looks like a race",
          thinking: "checking the timestamps first",
          toolOutput: "pid 1234 crashed",
          toolName: "debugger",
          toolCallId: "call_debug",
        },
        { role: "user", content: "file a ticket" },
      ];
      const injectPromise = harness.app.inject({
        method: "POST",
        url: "/api/chat",
        headers: { accept: "text/event-stream" },
        payload: {
          userId: "hermes",
          message: "continue",
          agent_id: harness.agentId,
          history,
        },
      });

      const taskFrame = await client.nextMessage();
      assert.equal(taskFrame.type, "task");
      const messages = (taskFrame.payload as { messages?: ChatTurn[] }).messages!;
      assert.equal(messages[0]!.content, "find the bug");
      const assistant = messages[1] as { role: string; content: string; thinking?: string };
      assert.equal(assistant.role, "assistant");
      assert.equal(assistant.content, "looks like a race");
      assert.equal(assistant.thinking, "checking the timestamps first", "thinking forwarded verbatim");
      const tool = messages[2] as { role: string; content: string; name?: string; tool_call_id?: string };
      assert.equal(tool.role, "tool");
      assert.equal(tool.content, "pid 1234 crashed", "tool output forwarded as a role:tool message");
      assert.equal(tool.name, "debugger");
      assert.equal(tool.tool_call_id, "call_debug");
      assert.equal(messages[3]!.content, "file a ticket");
      assert.equal(messages[messages.length - 1]!.content, "continue");

      client.ws.send(JSON.stringify({ type: "task.complete", task_id: taskFrame.task_id }));
      const res = await injectPromise;
      assert.equal(res.statusCode, 200);
    } finally {
      await client.close();
    }
  } finally {
    await harness.app.close();
  }
});

test("remote chat: thinking/tool output absent or blank is tolerated (pre-T11 clients still work)", async () => {
  const harness = await buildHarness();
  try {
    const client = openClient(harness.wsUrl);
    await registerAgent(client, harness.agentId, harness.token);
    try {
      const history = [
        { role: "assistant", content: "kept", thinking: "   ", toolOutput: "" },
        { role: "user", content: "kept q", thinking: 42, toolOutput: null },
      ];
      const injectPromise = harness.app.inject({
        method: "POST",
        url: "/api/chat",
        headers: { accept: "text/event-stream" },
        payload: {
          userId: "hermes",
          message: "go",
          agent_id: harness.agentId,
          history,
        },
      });

      const taskFrame = await client.nextMessage();
      const messages = (taskFrame.payload as { messages?: ChatTurn[] }).messages!;
      assert.deepEqual(
        messages.slice(0, 2),
        [
          { role: "assistant", content: "kept" },
          { role: "user", content: "kept q" },
        ],
        "blank/non-string thinking+output ignored; plain {role, content} turns forwarded",
      );
      assert.equal(messages[messages.length - 1]!.content, "go");

      client.ws.send(JSON.stringify({ type: "task.complete", task_id: taskFrame.task_id }));
      await injectPromise;
    } finally {
      await client.close();
    }
  } finally {
    await harness.app.close();
  }
});

test("remote chat: above threshold → injected summarizer summarizes old turns into the task payload", async () => {
  const calls: ChatTurn[][] = [];
  const summarizer: Summarizer = async (turns) => {
    calls.push(turns);
    return "EARLIER CONTEXT";
  };
  const harness = await buildHarness(summarizer);
  try {
    const client = openClient(harness.wsUrl);
    await registerAgent(client, harness.agentId, harness.token);
    try {
      // 60 turns × ~13.7k chars each ≈ 820k chars ≈ 205k estimated tokens — above
      // the route's 200_000 threshold, with 20 turns outside the 40-turn window.
      const history: ChatTurn[] = [];
      for (let i = 0; i < 60; i += 1) {
        history.push({
          role: i % 2 === 0 ? "user" : "assistant",
          content: `message number ${i} ${"y".repeat(13_600)}`,
        });
      }
      const injectPromise = harness.app.inject({
        method: "POST",
        url: "/api/chat",
        headers: { accept: "text/event-stream" },
        payload: {
          userId: "hermes",
          message: "wrap it up",
          agent_id: harness.agentId,
          history,
        },
      });

      const taskFrame = await client.nextMessage();
      const messages = (taskFrame.payload as { messages?: ChatTurn[] }).messages!;
      assert.equal(calls.length, 1, "summarizer invoked once");
      assert.equal(calls[0]!.length, 20, "summarizer sees exactly the old turns");
      assert.equal(messages[0]!.role, "system");
      assert.ok(
        messages[0]!.content.includes("EARLIER CONTEXT"),
        "summary lands as the leading system message",
      );
      assert.equal(messages[messages.length - 1]!.content, "wrap it up");

      client.ws.send(JSON.stringify({ type: "task.complete", task_id: taskFrame.task_id }));
      await injectPromise;
    } finally {
      await client.close();
    }
  } finally {
    await harness.app.close();
  }
});
