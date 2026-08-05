import type { FastifyInstance } from "fastify";
import type { AgentManager } from "../agents/manager.js";
import { streamAgentText } from "../agents/stream.js";

export interface ChatRequestBody {
  message?: unknown;
  userId?: unknown;
}

export interface ChatRouteOptions {
  manager: AgentManager;
}

function invalidField(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Personal chat endpoint:
 * - Non-streaming: POST /api/chat { message, userId } → { reply }
 * - Streaming: same, Accept: text/event-stream → SSE pushes delta chunks
 */
export function registerChatRoutes(app: FastifyInstance, options: ChatRouteOptions): void {
  app.post("/api/chat", async (request, reply) => {
    const body = (request.body ?? {}) as ChatRequestBody;

    if (invalidField(body.userId)) {
      return reply.code(400).send({ error: "userId is required" });
    }
    if (invalidField(body.message)) {
      return reply.code(400).send({ error: "message is required" });
    }

    const userId = body.userId as string;
    const message = body.message as string;
    const agent = await options.manager.getAgent(userId);

    const wantsStream =
      typeof request.headers.accept === "string" &&
      request.headers.accept.includes("text/event-stream");

    if (wantsStream) {
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      try {
        for await (const delta of streamAgentText(agent, message)) {
          raw.write(sseFrame({ delta }));
        }
        raw.write(sseFrame({ done: true }));
      } catch (err) {
        raw.write(sseFrame({ error: err instanceof Error ? err.message : String(err) }));
      } finally {
        raw.end();
      }
      return;
    }

    try {
      const replyText = await agent.prompt(message);
      return { reply: replyText };
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
