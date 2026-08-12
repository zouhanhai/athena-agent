import type { FastifyInstance } from "fastify";
import type { AgentManager } from "../agents/manager.js";
import { streamAgentChat } from "../agents/stream.js";
import { buildPageInjection, injectPageContext } from "../agents/page-context.js";

export interface ChatRequestBody {
  message?: unknown;
  userId?: unknown;
  /** Current page route path — drives page-aware capability injection. Optional. */
  page?: unknown;
  /**
   * G4.S3.T13: the user's answer to a clarification follow-up. `{ query, answer }`
   * — the original question and the chosen option. When present, the route
   * composes a re-run prompt so the agent re-searches the KB with that context.
   */
  clarify?: unknown;
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

interface ClarifyAnswer {
  query: string;
  answer: string;
}

/** Parse the `clarify` body field into `{ query, answer }`, or undefined. */
function parseClarifyAnswer(value: unknown): ClarifyAnswer | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.query !== "string" || typeof v.answer !== "string") return undefined;
  const query = v.query.trim();
  const answer = v.answer.trim();
  if (!query || !answer) return undefined;
  return { query, answer };
}

/** G4.S3.T13: knowledge-first guidance (also explains the clarification follow-up). */
const KNOWLEDGE_GUIDANCE =
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
  "403) in your reply.\n" +
  "If search_knowledge returns a CLARIFICATION_REQUESTED, do NOT answer yet: the " +
  "chat UI will show the options to the user, and once the user picks one the " +
  "query is re-run with that context.";

/** G4.S3.T13: compose the re-run prompt when the user answered a clarification. */
function buildClarifyReRunPrompt(answer: ClarifyAnswer, page: string | undefined): string {
  const reRun = [
    `The user originally asked: "${answer.query}".`,
    `The user answered the clarifying question with: "${answer.answer}".`,
    "Re-run `search_knowledge` for the original question, using the user's chosen " +
      `context "${answer.answer}". Answer from the knowledge base; do NOT ask for ` +
      "clarification again.",
  ].join("\n\n");
  const injection = buildPageInjection(page);
  return injection ? `${injection}\n\n${reRun}` : reRun;
}

/**
 * Personal chat endpoint:
 * - Non-streaming: POST /api/chat { message, userId } → { reply }
 * - Streaming: same, Accept: text/event-stream → SSE pushes delta chunks and,
 *   on a legitimate clarify (G4.S3.T13), a `{ clarify: { question, options } }`
 *   frame so the front-end chat renders a real user follow-up.
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
    const clarifyAnswer = parseClarifyAnswer(body.clarify);
    const agent = await options.manager.getAgent(userId);

    // G4.S3.T13: a clarification answer re-runs the original query with the
    // user's chosen context instead of sending the answer as a fresh message.
    const finalPrompt =
      clarifyAnswer
        ? `${KNOWLEDGE_GUIDANCE}\n\n${buildClarifyReRunPrompt(clarifyAnswer, page)}`
        : `${KNOWLEDGE_GUIDANCE}\n\n${injectPageContext(page, message)}`;

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
        for await (const event of streamAgentChat(agent, finalPrompt)) {
          if (event.type === "clarify") {
            raw.write(sseFrame({
              clarify: {
                question: event.clarification.question,
                options: event.clarification.options,
                query: event.clarification.query,
              },
            }));
          } else {
            raw.write(sseFrame({ delta: event.text }));
          }
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
