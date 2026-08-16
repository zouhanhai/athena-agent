/* eslint-disable */
/**
 * G4.S7.T4 — Remote agent template (reverse WebSocket).
 *
 * A local agent (Hermes / any OpenAI-compatible agent API) connects OUTBOUND
 * INTO the athena platform's WS endpoint, authenticates with its invitation
 * token, and executes tasks the platform pushes back through the tunnel:
 *
 *   platform → {type:"task", task_id, payload:{type:"chat.completions", messages}}
 *   agent →    runs POST <API_URL>/v1/chat/completions (SSE) against its LOCAL
 *              API server, relays reasoning (thinking) + answer (delta) tokens
 *              back until task.complete.
 *
 * Works behind NAT/CGNAT with no public IP / no admin: the agent is the
 * outbound connector; the platform reaches it only through the live tunnel.
 *
 * Usage (from the remote agent machine):
 *   export ATHENA_PLATFORM_WS=wss://athenakb.com/ws/agent   # or ws://localhost:3000/ws/agent
 *   export ATHENA_AGENT_ID=<invitation agent_id>
 *   export ATHENA_AGENT_TOKEN=<invitation token>
 *   export ATHENA_API_URL=http://127.0.0.1:8642             # the agent's OWN api server
 *   export ATHENA_API_KEY=<API_SERVER_KEY, if any>
 *   npx tsx server/scripts/agent-client.ts
 */
import { WebSocket } from "ws";

interface ChatCompletionsTask {
  task_id: string;
  type: string;
  messages?: Array<{ role: string; content: string }>;
}

const PLATFORM_WS = process.env.ATHENA_PLATFORM_WS ?? "ws://localhost:3000/ws/agent";
const AGENT_ID = process.env.ATHENA_AGENT_ID ?? "";
const AGENT_TOKEN = process.env.ATHENA_AGENT_TOKEN ?? "";
const API_URL = (process.env.ATHENA_API_URL ?? "http://127.0.0.1:8642").replace(/\/$/, "");
const API_KEY = process.env.ATHENA_API_KEY ?? "";
const PING_INTERVAL_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;

function send(socket: WebSocket, message: Record<string, unknown>): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function envError(): string | null {
  if (!AGENT_ID) return "ATHENA_AGENT_ID is required";
  if (!AGENT_TOKEN) return "ATHENA_AGENT_TOKEN is required";
  return null;
}

/** Strip fully-consumed SSE `data:` lines from the buffer (returns the remainder). */
function relaySseChunks(
  buffer: string,
  socket: WebSocket,
  taskId: string,
): string {
  let rest = buffer;
  let idx: number;
  while ((idx = rest.indexOf("\n\n")) !== -1) {
    const event = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    const dataLine = event
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("data:"));
    if (!dataLine) continue;
    const data = dataLine.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
      };
      const delta = parsed.choices?.[0]?.delta;
      if (delta?.reasoning_content) {
        send(socket, { type: "thinking", task_id: taskId, text: delta.reasoning_content });
      }
      if (delta?.content) {
        send(socket, { type: "delta", task_id: taskId, text: delta.content });
      }
    } catch {
      // Ignore non-JSON lines (e.g. ping/keep-alive comments).
    }
  }
  return rest;
}

/**
 * Run one chat.completions task against the agent's LOCAL API server and relay
 * the SSE back through the tunnel: reasoning_content → thinking, content →
 * delta, then task.complete (or task.error on failure).
 */
async function runChatCompletions(
  socket: WebSocket,
  taskId: string,
  payload: { messages?: Array<{ role: string; content: string }> },
): Promise<void> {
  try {
    const response = await fetch(`${API_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: "hermes-agent",
        messages: payload.messages ?? [],
        stream: true,
      }),
    });
    if (!response.ok || !response.body) {
      send(socket, { type: "task.error", task_id: taskId, message: `local API returned ${response.status}` });
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = relaySseChunks(buffer, socket, taskId);
    }
    send(socket, { type: "task.complete", task_id: taskId });
  } catch (err) {
    send(socket, { type: "task.error", task_id: taskId, message: err instanceof Error ? err.message : String(err) });
  }
}

let pingTimer: NodeJS.Timeout | null = null;
let stopped = false;

function stop(): void {
  if (stopped) return;
  stopped = true;
  if (pingTimer) clearInterval(pingTimer);
  process.exit();
}

function connect(): void {
  if (stopped) return;
  const ws = new WebSocket(PLATFORM_WS);

  ws.on("open", () => {
    console.log(`[agent] connected to ${PLATFORM_WS}`);
    send(ws, { type: "register", agent_id: AGENT_ID, token: AGENT_TOKEN });
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => send(ws, { type: "ping" }), PING_INTERVAL_MS);
    pingTimer.unref?.();
  });

  ws.on("message", (raw) => {
    let msg: { type?: string; payload?: ChatCompletionsTask };
    try {
      msg = JSON.parse(raw.toString()) as { type?: string; payload?: ChatCompletionsTask };
    } catch {
      return;
    }
    switch (msg.type) {
      case "welcome":
      case "registered":
      case "pong":
      case "echo":
        break;
      case "error":
        console.error(`[agent] platform error: ${raw.toString()}`);
        ws.close(1000);
        break;
      case "task": {
        const task = msg.payload;
        if (task && task.type === "chat.completions") {
          console.log(`[agent] task ${task.task_id}: running ${API_URL}/v1/chat/completions`);
          void runChatCompletions(ws, task.task_id, task);
        } else {
          send(ws, { type: "task.error", task_id: task?.task_id, message: "unsupported task type" });
        }
        break;
      }
      default:
        send(ws, { type: "error", message: "unknown message type" });
    }
  });

  ws.on("close", () => {
    console.log("[agent] disconnected — reconnecting");
    if (stopped) return;
    setTimeout(connect, RECONNECT_BASE_MS);
    pingTimer?.unref?.();
  });

  ws.on("error", (err) => {
    console.error(`[agent] ws error: ${err.message}`);
  });
}

function main(): void {
  const missing = envError();
  if (missing) {
    console.error(`[agent] ${missing}`);
    process.exit(2);
  }
  console.log(`[agent] template starting (agent_id=${AGENT_ID}, api=${API_URL})`);
  connect();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main();