import type { FastifyInstance } from "fastify";
import type { AgentManager } from "../agents/manager.js";
import { streamAgentText } from "../agents/stream.js";
import { injectPageContext } from "../agents/page-context.js";

export interface ChatRequestBody {
  message?: unknown;
  userId?: unknown;
  /** Current page route path — drives page-aware capability injection. Optional. */
  page?: unknown;
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
    const page = typeof body.page === "string" ? body.page : "";
    const agent = await options.manager.getAgent(userId);
    // Page-aware context injection: prepend the current page's relevant agent
    // capabilities so the agent answers with context-appropriate tooling. The
    // conversation context (shared session) is never altered — only the prompt.
    const prompt = injectPageContext(page, message);

    // Knowledge-first guidance (G4.S3): prefer answering from the athena KB via
    // `search_knowledge` before reaching for web tools. Only fall back to web
    // search/extract when search_knowledge explicitly reports the KB does not
    // answer — and don't narrate intermediate web-access failures (e.g. a 403)
    // in the reply; answer from what the KB/web actually returned.
    const knowledgeGuidance =
      "Knowledge-first: `search_knowledge` is an AVAILABLE local tool in this " +
      "session (not an MCP server — it needs NO initialization) that answers from " +
      "the athena knowledge base: Neo4j entities/chunks, the llm_wiki, stored Q&A " +
      "pairs (qa_pairs), and semantic-term expansion. For ANY question about CALEO " +
      "(company, documents, processes, wiki, entities, stored Q&A, past events like " +
      "the Sommerseminar), CALL `search_knowledge` first and answer from its result. " +
      "Do NOT claim you lack Neo4j/search_knowledge access — you have it. Do NOT use " +
      "web tools to check or re-derive an answer the KB already provides. Only fall " +
      "back to web search/extract when search_knowledge explicitly says the KB does " +
      "not answer. Do not mention intermediate tool failures (like a URL returning " +
      "403) in your reply.";
    const finalPrompt = `${knowledgeGuidance}\n\n${prompt}`;

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
        for await (const delta of streamAgentText(agent, finalPrompt)) {
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
      const replyText = await agent.prompt(finalPrompt);
      return { reply: replyText };
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
