import type { Server } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";

/** Public inbound WebSocket endpoint remote agents connect INTO (G4.S7.T1). */
export const AGENT_WS_PATH = "/ws/agent";
/** Protocol version for the agent WS frame envelope. Bump on breaking frame changes. */
export const AGENT_WS_PROTOCOL_VERSION = 1;

/** Frames a remote agent sends to the platform. T4 extends with registration. */
export type AgentClientMessage =
  | { type: "ping" }
  | { type: "echo"; data?: unknown };

/** Frames the platform sends back to a connected agent. */
export type AgentServerMessage =
  | {
      type: "welcome";
      service: "athena-agent-ws";
      path: string;
      protocolVersion: number;
      connectedAt: string;
    }
  | { type: "pong"; at: string }
  | { type: "echo"; data?: unknown; at: string }
  | { type: "error"; message: string };

export interface AgentWsGatewayOptions {
  /** Lifecycle sink for diagnostics/tests. */
  onConnection?: (info: { remoteAddress?: string; socketCount: number }) => void;
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

/**
 * Reverse-WebSocket gateway (G4.S7.T1): remote agents connect INTO the platform
 * through `AGENT_WS_PATH`. This milestone establishes the endpoint with a
 * handshake + echo/ping frames for reachability verification; registration and
 * bidirectional streaming land in T2/T4.
 */
export class AgentWsGateway {
  readonly path = AGENT_WS_PATH;
  private readonly wss: WebSocketServer;
  private readonly sockets = new Set<WebSocket>();

  constructor(server: Server) {
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (socket, request) => {
      this.sockets.add(socket);
      this.reply(socket, {
        type: "welcome",
        service: "athena-agent-ws",
        path: AGENT_WS_PATH,
        protocolVersion: AGENT_WS_PROTOCOL_VERSION,
        connectedAt: now(),
      });
      socket.on("message", (raw) => {
        let msg: AgentClientMessage;
        try {
          msg = JSON.parse(frameToString(raw)) as AgentClientMessage;
        } catch {
          this.reply(socket, { type: "error", message: "invalid json" });
          return;
        }
        this.handle(socket, msg);
      });
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", () => this.sockets.delete(socket));
    });

    server.on("upgrade", (request, socket, head) => {
      if (pathname(request.url) !== AGENT_WS_PATH) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit("connection", ws, request);
      });
    });
  }

  get connectionCount(): number {
    return this.sockets.size;
  }

  private handle(socket: WebSocket, msg: AgentClientMessage): void {
    switch (msg.type) {
      case "ping":
        this.reply(socket, { type: "pong", at: now() });
        break;
      case "echo":
        this.reply(socket, { type: "echo", data: msg.data, at: now() });
        break;
      default:
        this.reply(socket, { type: "error", message: "unknown message type" });
    }
  }

  private reply(socket: WebSocket, message: AgentServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  close(): void {
    for (const socket of this.sockets) socket.close(1000);
    this.wss.close();
  }
}
