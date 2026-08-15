import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { buildApp } from "../src/app.js";
import { AGENT_WS_PATH, AGENT_WS_PROTOCOL_VERSION } from "../src/ws/agent.js";

/** Listen on an ephemeral port, hand `wsUrl` to the runner, always close. */
async function withListeningApp(
  run: (wsUrl: string, app: FastifyInstance) => Promise<void>,
): Promise<void> {
  const app = buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  try {
    const address = app.server.address();
    assert.ok(address && typeof address === "object", "server should have a bound address");
    await run(`ws://127.0.0.1:${address.port}${AGENT_WS_PATH}`, app);
  } finally {
    await app.close();
  }
}

interface WsClient {
  ws: WebSocket;
  waitOpen: () => Promise<void>;
  nextMessage: (timeoutMs?: number) => Promise<Record<string, unknown>>;
}

/** A ws client that buffers incoming frames so a frame arriving before `open`
 *  (the server sends the welcome immediately after the handshake) is not lost. */
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
    nextMessage: (timeoutMs = 2000) => {
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
  };
}

test("WS /ws/agent sends a welcome handshake frame on connect", async () => {
  await withListeningApp(async (url) => {
    const { ws, waitOpen, nextMessage } = openClient(url);
    await waitOpen();
    try {
      const welcome = await nextMessage();
      assert.equal(welcome.type, "welcome");
      assert.equal(welcome.service, "athena-agent-ws");
      assert.equal(welcome.path, AGENT_WS_PATH);
      assert.equal(welcome.protocolVersion, AGENT_WS_PROTOCOL_VERSION);
      assert.equal(typeof welcome.connectedAt, "string");
    } finally {
      ws.close();
    }
  });
});

test("WS /ws/agent echoes an {type:echo} frame back", async () => {
  await withListeningApp(async (url) => {
    const { ws, waitOpen, nextMessage } = openClient(url);
    await waitOpen();
    try {
      await nextMessage(); // drain welcome
      const payload = { hello: "agent", n: 42 };
      ws.send(JSON.stringify({ type: "echo", data: payload }));
      const reply = await nextMessage();
      assert.equal(reply.type, "echo");
      assert.deepEqual(reply.data, payload);
      assert.equal(typeof reply.at, "string");
    } finally {
      ws.close();
    }
  });
});

test("WS /ws/agent answers ping with pong", async () => {
  await withListeningApp(async (url) => {
    const { ws, waitOpen, nextMessage } = openClient(url);
    await waitOpen();
    try {
      await nextMessage(); // drain welcome
      ws.send(JSON.stringify({ type: "ping" }));
      const reply = await nextMessage();
      assert.equal(reply.type, "pong");
      assert.equal(typeof reply.at, "string");
    } finally {
      ws.close();
    }
  });
});

test("WS /ws/agent replies error on non-JSON frames", async () => {
  await withListeningApp(async (url) => {
    const { ws, waitOpen, nextMessage } = openClient(url);
    await waitOpen();
    try {
      await nextMessage(); // drain welcome
      ws.send("this is not json");
      const reply = await nextMessage();
      assert.equal(reply.type, "error");
      assert.equal(typeof reply.message, "string");
    } finally {
      ws.close();
    }
  });
});

test("WS /ws/agent replies error on unknown message types", async () => {
  await withListeningApp(async (url) => {
    const { ws, waitOpen, nextMessage } = openClient(url);
    await waitOpen();
    try {
      await nextMessage(); // drain welcome
      ws.send(JSON.stringify({ type: "what-is-this" }));
      const reply = await nextMessage();
      assert.equal(reply.type, "error");
      assert.equal(typeof reply.message, "string");
    } finally {
      ws.close();
    }
  });
});

test("plain HTTP GET to /ws/agent returns 404 (not a WS upgrade)", async () => {
  const app = buildApp();
  try {
    const res = await app.inject({ method: "GET", url: AGENT_WS_PATH });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});
