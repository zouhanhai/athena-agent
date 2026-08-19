import type { Server } from "node:http";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { AgentRegistry } from "../agents/registry.js";
import type { ChatTurn } from "../agents/chat-context.js";

/** Public inbound WebSocket endpoint remote agents connect INTO (G4.S7.T1). */
export const AGENT_WS_PATH = "/ws/agent";
/** Protocol version for the agent WS frame envelope. Bump on breaking frame changes. */
export const AGENT_WS_PROTOCOL_VERSION = 1;

/** Close codes used by the gateway for auth / duplicate-connection failures. */
export const AGENT_WS_CLOSE_AUTH = 4001;
export const AGENT_WS_CLOSE_SUPERSEDED = 4002;

/**
 * Self-describing reply contract shipped in the `registered` frame (G4.S7.T4).
 * Lets a remote agent learn HOW to answer pushed tasks purely from the wire
 * protocol at handshake/auth time — no human copy-paste, no protocol guessing.
 * Re-sent on EVERY connection (a fresh registered frame per handshake).
 */
export interface AgentTaskReplyContract {
  /** Every reply frame must echo the task_id from the pushed `task` frame. */
  mustEchoTaskId: true;
  /** Client→server frame types the platform understands for one task. */
  frames: AgentClientMessage["type"][];
  /** One of these two frames is mandatory to finish a task. */
  terminateWith: ["task.complete", "task.error"];
  /** If no task.start/delta/thinking within this window, the platform
   *  auto-derives task.error so a dead/never-receiving agent surfaces
   *  instead of hanging forever. */
  idleTimeoutMs: number;
  /** Reconnect semantics for in-flight tasks (documented, not re-delivered). */
  reconnect: {
    inFlightTasks: "server marks task.error; no re-delivery";
  };
  /** G4.S7.T11 additive notes: tool events may carry result `output`, and
   *  assistant `thinking` is relayed separately from the final answer. */
  toolEvents: {
    toolCompletedOutput: "optional, relays the tool result content";
  };
  thinking: {
    relayed: "separate from the final answer text";
  };
}

/** Default idle window before a task with no agent activity is auto-errored. */
export const AGENT_TASK_IDLE_TIMEOUT_MS = 60_000;

/**
 * A task the platform pushes to a connected agent through the reverse tunnel
 * (G4.S7.T4). The agent runs it against its LOCAL API server (Hermes
 * `POST /v1/chat/completions`, SSE) and streams progress/result events back.
 */
export interface AgentTask {
  /** Platform-unique id; echoed on every event the agent streams back. */
  task_id: string;
  type: "chat.completions";
  /** Optional model the agent should use (e.g. "hermes-agent"). Default: agent's own default. */
  model?: string;
  /** The conversation (OpenAI chat.completions request body) the agent should run.
   *  G4.S7.T11: assistant turns may carry `thinking` (reasoning) and tool-result
   *  messages may carry `name`/`tool_call_id` — the platform DELIVERS these as
   *  data; the remote agent runtime applies its own provider policy.
   *  The messages are `ChatTurn`s (role + content + optional thinking/toolOutput
   *  compatible fields); a tool-carrying turn expands to a `role: "tool"` row. */
  messages: Array<ChatTurn>;
}

export type AgentClientMessage =
  | { type: "ping" }
  | { type: "echo"; data?: unknown }
  /** Auth'd registration (G4.S7.T2/T4): proves possession of the invitation token. */
  | { type: "register"; agent_id: string; token: string }
  | { type: "task.start"; task_id: string }
  | { type: "tool.started"; task_id: string; tool: string; detail?: string }
  | {
      type: "tool.completed";
      task_id: string;
      tool: string;
      detail?: string;
      status?: "ok" | "error";
      error?: string;
      /** G4.S7.T11: the tool's returned content (stdout, file excerpt, API
       *  response…). OPTIONAL — old connectors that send only detail still work;
       *  the platform never fails because output is absent. */
      output?: string;
    }
  | { type: "delta"; task_id: string; text: string }
  /** Reasoning/thinking tokens — distinct from the final answer text (Q1). */
  | { type: "thinking"; task_id: string; text: string }
  | { type: "task.complete"; task_id: string }
  | { type: "task.error"; task_id: string; message: string };

export type AgentServerMessage =
  | {
      type: "welcome";
      service: "athena-agent-ws";
      path: string;
      protocolVersion: number;
      connectedAt: string;
    }
  | { type: "registered"; agent_id: string; connectedAt: string; taskReply: AgentTaskReplyContract }
  | { type: "pong"; at: string }
  | { type: "echo"; data?: unknown; at: string }
  | { type: "error"; message: string }
  | { type: "task"; task_id: string; payload: AgentTask };

/**
 * Per-task relay the platform attaches when it pushes a task through the
 * tunnel. Each callback is invoked once per matching agent event.
 */
export interface TaskRelay {
  onToolStarted?(tool: string, detail?: string): void;
  /** `output` (G4.S7.T11) is the tool result content, when the agent sent it. */
  onToolCompleted?(tool: string, detail?: string, error?: string, output?: string): void;
  onDelta?(text: string): void;
  /** Reasoning/thinking tokens (agent's internal chain-of-thought, if emitted). */
  onThinking?(text: string): void;
  onComplete?(): void;
  onError?(message: string): void;
}

/** Events broadcast to watchers (used by routes/tests to observe reachability). */
export type AgentHubEvent =
  | { type: "agent.connected"; agentId: string; connectedAt: string }
  | { type: "agent.disconnected"; agentId: string }
  | { type: "agent.registered"; agentId: string; connectedAt: string };

interface RegisteredChannel {
  agentId: string;
  socket: WebSocket;
  connectedAt: string;
  tasks: Map<string, { relay: TaskRelay; sentAt: string; idleTimer?: NodeJS.Timeout }>;
}

function pathname(url?: string): string {
  try {
    return new URL(url ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

function now(): string {
  return new Date().toISOString();
}

function frameToString(raw: RawData): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  // ws with binaryType "arraybuffer" may hand over a Buffer[] for fragmented frames.
  return Buffer.concat(raw as Buffer[]).toString("utf8");
}

function sendFrame(socket: WebSocket, message: AgentServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

/** Parse a json client frame, or return a tagged parse error. */
function parseClientFrame(raw: RawData): { ok: true; message: AgentClientMessage } | { ok: false } {
  try {
    const parsed = JSON.parse(frameToString(raw)) as AgentClientMessage;
    return { ok: true, message: parsed };
  } catch {
    return { ok: false };
  }
}

/**
 * Reverse-WebSocket gateway (G4.S7.T1/T4): remote agents connect INTO the
 * platform through `AGENT_WS_PATH`. On connect they REGISTER auth'd
 * `{agent_id, token}` (validated against the registry's invitation hash); a
 * successful registration records the agent as reachable and keeps the tunnel
 * live (Map<agentId, socket>). The platform pushes tasks THROUGH the tunnel
 * (`sendTask`) and the agent streams back tool.started/tool.completed + result
 * deltas. Disconnects clean up the tunnel; a reconnecting agent is superseded
 * into the same slot after re-authentication. Works behind NAT/CGNAT because
 * the agent is the outbound connector.
 */
export class AgentWsGateway {
  readonly path = AGENT_WS_PATH;
  private readonly wss: WebSocketServer;
  /** Live tunnels keyed by agent identity (the reverse tunnel the platform drives). */
  private readonly channelsByAgent = new Map<string, RegisteredChannel>();
  private readonly sockets = new Set<WebSocket>();
  private readonly events = new EventEmitter();
  private readonly registry: AgentRegistry | undefined;
  /** Window before an unresponsive task is auto-errored (see taskReply.idleTimeoutMs). */
  readonly idleTimeoutMs: number;

  constructor(
    server: Server,
    options: { registry?: AgentRegistry; idleTimeoutMs?: number } = {},
  ) {
    this.registry = options.registry;
    this.idleTimeoutMs = options.idleTimeoutMs ?? AGENT_TASK_IDLE_TIMEOUT_MS;
    this.wss = new WebSocketServer({ noServer: true });

    this.wss.on("connection", (socket) => this.accept(socket));
    server.on("upgrade", (request, socket, head) => {
      if (pathname(request.url) !== AGENT_WS_PATH) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit("connection", ws);
      });
    });
  }

  private accept(socket: WebSocket): void {
    this.sockets.add(socket);
    sendFrame(socket, {
      type: "welcome",
      service: "athena-agent-ws",
      path: AGENT_WS_PATH,
      protocolVersion: AGENT_WS_PROTOCOL_VERSION,
      connectedAt: now(),
    });

    socket.on("message", (raw) => {
      const parsed = parseClientFrame(raw);
      if (!parsed.ok) {
        sendFrame(socket, { type: "error", message: "invalid json" });
        return;
      }
      // TEMP DEBUG (T11 chat display bug): log every inbound agent frame verbatim.
      try {
        const dbg = JSON.parse(frameToString(raw));
        if (dbg && typeof dbg === "object" && (dbg.type === "delta" || dbg.type === "thinking" || dbg.type === "task.complete" || dbg.type === "tool.started" || dbg.type === "tool.completed")) {
          console.warn("[ws-debug] inbound frame:", JSON.stringify(dbg).slice(0, 300));
        }
      } catch {}
      void this.handleMessage(socket, parsed.message);
    });
    socket.on("close", () => this.handleClose(socket));
    socket.on("error", () => this.handleClose(socket));
  }

  private async handleMessage(socket: WebSocket, msg: AgentClientMessage): Promise<void> {
    switch (msg.type) {
      case "ping":
        sendFrame(socket, { type: "pong", at: now() });
        return;
      case "echo":
        sendFrame(socket, { type: "echo", data: msg.data, at: now() });
        return;
      case "register": {
        await this.register(socket, msg.agent_id, msg.token);
        return;
      }
      default:
        this.routeTaskEvent(socket, msg);
    }
  }

  /**
   * Auth'd registration: validates the invitation token, records the agent as
   * reachable, and installs the tunnel. A stale/duplicate tunnel for the same
   * agent is superseded by the newest connection (reconnect-safe).
   */
  private async register(socket: WebSocket, agentId: string, token: string): Promise<void> {
    if (!agentId || !token) {
      sendFrame(socket, { type: "error", message: "agent_id and token are required" });
      socket.close(AGENT_WS_CLOSE_AUTH);
      return;
    }
    const agent = this.registry ? await this.registry.verifyCredentials(agentId, token) : null;
    if (!agent) {
      sendFrame(socket, { type: "error", message: "invalid agent_id or token" });
      socket.close(AGENT_WS_CLOSE_AUTH);
      return;
    }

    const existing = this.channelsByAgent.get(agentId);
    if (existing && existing.socket !== socket) {
      // Reconnect / duplicate: retire the previous tunnel first (its in-flight
      // tasks fail fast) so only the newest socket is driven.
      this.teardownChannel(existing, "superseded by a new connection");
      if (existing.socket.readyState === WebSocket.OPEN) {
        existing.socket.close(AGENT_WS_CLOSE_SUPERSEDED);
      }
    }

    const channel: RegisteredChannel = {
      agentId,
      socket,
      connectedAt: now(),
      tasks: new Map(),
    };
    this.channelsByAgent.set(agentId, channel);
    // Persist reachability FIRST, before the registered frame, so a received
    // "registered" frame implies the platform has already recorded the tunnel.
    if (this.registry) {
      await this.registry.markReachable(agentId).catch(() => {});
    }
    sendFrame(socket, {
      type: "registered",
      agent_id: agentId,
      connectedAt: channel.connectedAt,
      // Self-describing reply contract: the agent learns how to answer tasks
      // from the wire protocol itself (re-sent on every handshake).
      taskReply: {
        mustEchoTaskId: true,
        frames: [
          "task.start",
          "delta",
          "thinking",
          "tool.started",
          "tool.completed",
          "task.complete",
          "task.error",
        ],
        terminateWith: ["task.complete", "task.error"],
        idleTimeoutMs: this.idleTimeoutMs,
        reconnect: {
          inFlightTasks: "server marks task.error; no re-delivery",
        },
        toolEvents: {
          toolCompletedOutput: "optional, relays the tool result content",
        },
        thinking: {
          relayed: "separate from the final answer text",
        },
      },
    });
    this.events.emit("agent.connected", {
      type: "agent.connected",
      agentId,
      connectedAt: channel.connectedAt,
    } satisfies AgentHubEvent);
  }

  /** Route an event frame with a task_id to the matching in-flight relay, if any. */
  private routeTaskEvent(socket: WebSocket, msg: AgentClientMessage): void {
    const channel = [...this.channelsByAgent.values()].find((c) => c.socket === socket);
    if (!channel) {
      this.replySocketError(socket, msg);
      return;
    }
    if (!("task_id" in msg)) {
      this.replySocketError(socket, msg);
      return;
    }
    const entry = channel.tasks.get(msg.task_id);
    if (!entry) {
      // Late/unknown task event — no relay attached; ignore quietly.
      return;
    }
    switch (msg.type) {
      case "task.start":
        this.armIdleTimer(channel, msg.task_id, entry);
        break;
      case "tool.started":
        this.armIdleTimer(channel, msg.task_id, entry);
        entry.relay.onToolStarted?.(msg.tool, msg.detail);
        break;
      case "tool.completed":
        this.armIdleTimer(channel, msg.task_id, entry);
        entry.relay.onToolCompleted?.(
          msg.tool,
          msg.detail,
          msg.status === "error" ? msg.error : undefined,
          msg.output,
        );
        break;
      case "delta":
        this.armIdleTimer(channel, msg.task_id, entry);
        entry.relay.onDelta?.(msg.text);
        break;
      case "thinking":
        this.armIdleTimer(channel, msg.task_id, entry);
        entry.relay.onThinking?.(msg.text);
        break;
      case "task.complete":
        this.clearIdleTimer(entry);
        channel.tasks.delete(msg.task_id);
        entry.relay.onComplete?.();
        break;
      case "task.error":
        this.clearIdleTimer(entry);
        channel.tasks.delete(msg.task_id);
        entry.relay.onError?.(msg.message);
        break;
      default:
        this.replySocketError(socket, msg);
    }
  }

  /** Reset the per-task idle timer so any agent activity keeps the task alive. */
  private armIdleTimer(
    channel: RegisteredChannel,
    taskId: string,
    entry: RegisteredChannel["tasks"] extends Map<string, infer V> ? V : never,
  ): void {
    this.clearIdleTimer(entry);
    entry.idleTimer = setTimeout(() => {
      // No activity within the window → the agent is dead / never processed
      // the task. Convert the silent hang into a visible task.error.
      if (channel.tasks.has(taskId)) {
        channel.tasks.delete(taskId);
      }
      try {
        entry.relay.onError?.(
          `task idle timeout: no agent activity for ${this.idleTimeoutMs}ms`,
        );
      } finally {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = undefined;
      }
    }, this.idleTimeoutMs);
  }

  private clearIdleTimer(entry: RegisteredChannel["tasks"] extends Map<string, infer V> ? V : never): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
  }

  private replySocketError(socket: WebSocket, msg: AgentClientMessage): void {
    sendFrame(socket, { type: "error", message: `unknown message type: ${(msg as { type?: string }).type ?? "?"}` });
  }

  private handleClose(socket: WebSocket): void {
    this.sockets.delete(socket);
    for (const channel of this.channelsByAgent.values()) {
      if (channel.socket === socket) {
        this.teardownChannel(channel, "agent connection closed");
        break;
      }
    }
  }

  private teardownChannel(channel: RegisteredChannel, reason: string): void {
    if (this.channelsByAgent.get(channel.agentId) === channel) {
      this.channelsByAgent.delete(channel.agentId);
    }
    channel.socket.removeAllListeners("message");
    for (const { relay, idleTimer } of channel.tasks.values()) {
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      relay.onError?.(reason);
    }
    channel.tasks.clear();
    this.events.emit("agent.disconnected", {
      type: "agent.disconnected",
      agentId: channel.agentId,
    } satisfies AgentHubEvent);
  }

  /**
   * Push a task through the live tunnel. Returns the assigned task_id on
   * success, or null when the agent is not currently connected (reach it only
   * after it connects outbound — reverse tunnel, G4.S7.T4).
   */
  sendTask(agentId: string, task: Omit<AgentTask, "task_id">, relay: TaskRelay = {}): string | null {
    const channel = this.channelsByAgent.get(agentId);
    if (!channel || channel.socket.readyState !== WebSocket.OPEN) {
      return null;
    }
    const taskId = randomUUID();
    const payload: AgentTask = { ...task, task_id: taskId };
    const entry: RegisteredChannel["tasks"] extends Map<string, infer V> ? V : never = {
      relay,
      sentAt: now(),
    };
    channel.tasks.set(taskId, entry);
    // Start the idle window immediately: if the agent never acks (no
    // task.start/delta/thinking), the task auto-errors instead of hanging.
    this.armIdleTimer(channel, taskId, entry);
    const sent = sendFrameWithResult(channel.socket, { type: "task", task_id: taskId, payload });
    if (!sent) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
      channel.tasks.delete(taskId);
      relay.onError?.("failed to write task frame");
      return null;
    }
    return taskId;
  }

  /** Whether the agent currently holds a live tunnel. */
  isConnected(agentId: string): boolean {
    const channel = this.channelsByAgent.get(agentId);
    return !!channel && channel.socket.readyState === WebSocket.OPEN;
  }

  /** Agent identities with a live tunnel right now. */
  connectedAgentIds(): string[] {
    return [...this.channelsByAgent.keys()].filter((id) => this.isConnected(id));
  }

  /** Subscribe to gateway lifecycle events (agent.connected / agent.disconnected). */
  onEvent(listener: (event: AgentHubEvent) => void): () => void {
    this.events.on("agent.connected", listener);
    this.events.on("agent.disconnected", listener);
    return () => {
      this.events.off("agent.connected", listener);
      this.events.off("agent.disconnected", listener);
    };
  }

  get connectionCount(): number {
    return this.sockets.size;
  }

  close(): void {
    for (const channel of [...this.channelsByAgent.values()]) {
      this.teardownChannel(channel, "server shutting down");
      if (channel.socket.readyState === WebSocket.OPEN) {
        channel.socket.close(1000);
      }
    }
    this.wss.close();
  }
}

function sendFrameWithResult(socket: WebSocket, message: AgentServerMessage): boolean {
  if (socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}