/**
 * KB-as-MCP over Streamable HTTP (G4.S7.T3).
 *
 * Wires the `buildKbMcpServer` tool server onto the platform's HTTP server at
 * `GET/POST/DELETE /api/kb/mcp`, so any external MCP client agent
 * (OpenCode/Claude Code/Codex/Hermes) can add ONE `mcpServers` entry:
 *
 *   "athena-kb": {
 *     "type": "http",
 *     "url": "https://athenakb.com/api/kb/mcp",
 *     "headers": { "Authorization": "Bearer <employee-or-agent-token>" }
 *   }
 *
 * Auth: every request must carry a valid Bearer token (a platform session
 * token, resolved via `AuthService.getEmployeeForSession`). When no `auth`
 * service is wired the route is open (dev/test only).
 *
 * Transport: the `@modelcontextprotocol/sdk` Streamable HTTP transport, one
 * McpServer instance per session (the SDK Protocol permits a single transport
 * per connection). Sessions live in an in-memory map keyed by the session id
 * the SDK assigns on `initialize`; DELETE + server close tear them down.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildKbMcpServer } from "../kb/mcp.js";
import type { KnowledgeRetrievalService } from "../kb/retrieval.js";
import type { AuthService } from "../employees/auth.js";

/** Public MCP endpoint. Reachable over the platform's Cloudflare Tunnel. */
export const KB_MCP_ROUTE = "/api/kb/mcp";

export interface KbMcpRouteOptions {
  retrieval?: KnowledgeRetrievalService;
  /** When omitted the MCP route requires no auth (dev/test only). */
  auth?: AuthService;
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

const SESSION_NOT_FOUND = {
  jsonrpc: "2.0",
  error: { code: -32001, message: "Session not found" },
  id: null as null,
};

function jsonrpcError(status: number, body: unknown): { statusCode: number; body: unknown; headers: Record<string, string> } {
  return { statusCode: status, body, headers: { "Content-Type": "application/json" } };
}

function sessionIdOf(request: FastifyRequest): string | undefined {
  const value = request.headers["mcp-session-id"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function authorized(request: FastifyRequest, auth?: AuthService): Promise<boolean> {
  if (!auth) return true;
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return false;
  return (await auth.getEmployeeForSession(token)) !== null;
}

/** Handle a request entirely through the SDK transport (owns reply.raw). */
async function runTransport(
  request: FastifyRequest,
  reply: { raw: import("node:http").ServerResponse; hijack(): void },
  transport: StreamableHTTPServerTransport,
  body?: unknown,
): Promise<void> {
  reply.hijack();
  try {
    await transport.handleRequest(request.raw, reply.raw, body);
  } catch (err) {
    // The transport threw before/without writing a response — never leave the
    // client hanging. A response already in flight is left untouched.
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(500, { "Content-Type": "application/json" });
      reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
    }
  }
}

export function registerKbMcpRoutes(app: FastifyInstance, options: KbMcpRouteOptions): void {
  const { retrieval, auth } = options;
  if (!retrieval) return;

  const sessions = new Map<string, McpSession>();

  app.addHook("onClose", async () => {
    for (const session of sessions.values()) {
      await session.transport.close();
      await session.server.close();
    }
    sessions.clear();
  });

  app.post(KB_MCP_ROUTE, async (request, reply) => {
    if (!(await authorized(request, auth))) {
      return reply.code(401).header("WWW-Authenticate", "Bearer").send({ error: "unauthorized" });
    }
    const existing = sessionIdOf(request);
    if (existing) {
      const session = sessions.get(existing);
      if (!session) {
        return reply.code(404).send(SESSION_NOT_FOUND);
      }
      await runTransport(request, reply, session.transport, request.body);
      return;
    }

    // New session: create the transport + a fresh tool server, and only keep it
    // alive if an initialize actually initializes a session; otherwise close it
    // right after this request (e.g. a stray non-initialize POST).
    let stored = false;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server });
        stored = true;
      },
    });
    const server = buildKbMcpServer({ retrieval });
    await server.connect(transport);
    await runTransport(request, reply, transport, request.body);
    if (!stored) {
      await transport.close();
      await server.close();
    }
  });

  app.get(KB_MCP_ROUTE, async (request, reply) => {
    if (!(await authorized(request, auth))) {
      return reply.code(401).header("WWW-Authenticate", "Bearer").send({ error: "unauthorized" });
    }
    const sessionId = sessionIdOf(request);
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      return reply.code(404).send(SESSION_NOT_FOUND);
    }
    await runTransport(request, reply, session.transport);
  });

  app.delete(KB_MCP_ROUTE, async (request, reply) => {
    if (!(await authorized(request, auth))) {
      return reply.code(401).header("WWW-Authenticate", "Bearer").send({ error: "unauthorized" });
    }
    const sessionId = sessionIdOf(request);
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      return reply.code(404).send(SESSION_NOT_FOUND);
    }
    await runTransport(request, reply, session.transport, request.body);
    sessions.delete(sessionId!);
    await session.transport.close();
    await session.server.close();
  });
}