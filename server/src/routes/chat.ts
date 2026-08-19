import type { FastifyInstance } from "fastify";
import type { AgentManager } from "../agents/manager.js";
import { streamAgentChat } from "../agents/stream.js";
import { buildPageInjection, injectPageContext } from "../agents/page-context.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { AgentWsGateway } from "../ws/agent.js";
import { pushRemoteChatTask } from "../agents/remote-chat.js";
import {
  DEFAULT_CONTEXT_THRESHOLD_TOKENS,
  DEFAULT_RECENT_MAX_TURNS,
  MAX_HISTORY_TURNS,
  type ChatTurn,
  type Summarizer,
} from "../agents/chat-context.js";

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
  /**
   * G4.S7.T4: route the message to a SELECTED registered remote agent over its
   * reverse WS tunnel. When present, the platform pushes a chat task to the
   * agent instead of running the local Athena session.
   */
  agent_id?: unknown;
  /**
   * G4.S7.T10: the accumulated conversation (user/assistant turns) the chat
   * panel sends so a remote agent keeps multi-turn context. Array of
   * `{ role, content }`; validated + filtered + capped server-side.
   */
  history?: unknown;
}

export interface ChatRouteOptions {
  manager: AgentManager;
  /** G4.S7.T4: reverse-WS gateway — used when a chat targets a remote agent. */
  hub?: AgentWsGateway;
  /** G4.S7.T4: agent registry — identity/resolution for remote chat routing. */
  registry?: AgentRegistry;
  /**
   * G4.S7.T10: LLM seam that distills old turns when remote history exceeds the
   * token threshold. When absent the server falls back to truncation (with an
   * omission note) — it is injected so unit tests never hit the network.
   */
  summarizer?: Summarizer;
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

/**
 * G4.S7.T10: validate the `history` body field. Accepts any role with a
 * non-empty string content, filters everything else, and defensively caps the
 * turn count (MAX_HISTORY_TURNS). Never throws — malformed input yields [].
 *
 * G4.S7.T11: assistant turns may also carry `thinking` (reasoning) and `toolOutput`
 * (+ `toolName`/`toolCallId`) — all OPTIONAL and only kept when non-empty strings.
 * Pre-T11 clients (plain `{role, content}`) are still fully accepted.
 */
function parseHistory(value: unknown): ChatTurn[] {
  if (!Array.isArray(value)) return [];
  const turns: ChatTurn[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const v = item as Record<string, unknown>;
    if (typeof v.role !== "string" || typeof v.content !== "string") continue;
    const content = v.content.trim();
    if (!content) continue;

    const turn: ChatTurn = { role: v.role, content };

    let thinking = "";
    if (typeof v.thinking === "string") thinking = v.thinking.trim();
    let toolOutput = "";
    if (typeof v.toolOutput === "string") toolOutput = v.toolOutput.trim();

    if (turn.role === "assistant") {
      if (thinking) turn.thinking = thinking;
      if (toolOutput) {
        turn.toolOutput = toolOutput;
        if (typeof v.toolName === "string" && v.toolName.trim()) turn.toolName = v.toolName.trim();
        if (typeof v.toolCallId === "string" && v.toolCallId.trim()) turn.toolCallId = v.toolCallId.trim();
      }
    } else if (turn.role === "user" && (v.toolOutput !== undefined || v.toolName !== undefined)) {
      // A user turn carrying tool metadata is unusual; keep output only if present.
      if (toolOutput) turn.toolOutput = toolOutput;
    }

    turns.push(turn);
    if (turns.length >= MAX_HISTORY_TURNS) break;
  }
  return turns;
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
 * - G4.S7.T4 remote routing: with `{ agent_id }` the message is pushed to the
 *   selected registered agent over its reverse WS tunnel; the agent streams
 *   tool.started / tool.completed (`{ tool: ... }` frames) + result deltas back.
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
    const agentId = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
    const clarifyAnswer = parseClarifyAnswer(body.clarify);
    const history = parseHistory(body.history);

    const wantsStream =
      typeof request.headers.accept === "string" &&
      request.headers.accept.includes("text/event-stream");

    if (agentId) {
      return await handleRemoteChat(reply, {
        agentId,
        message,
        page,
        history,
        wantsStream,
        options,
      });
    }

    const agent = await options.manager.getAgent(userId);

    // G4.S3.T13: a clarification answer re-runs the original query with the
    // user's chosen context instead of sending the answer as a fresh message.
    const finalPrompt =
      clarifyAnswer
        ? `${KNOWLEDGE_GUIDANCE}\n\n${buildClarifyReRunPrompt(clarifyAnswer, page)}`
        : `${KNOWLEDGE_GUIDANCE}\n\n${injectPageContext(page, message)}`;

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

interface RemoteChatContext {
  agentId: string;
  message: string;
  page: string;
  /** G4.S7.T10: validated accumulated history (empty when the client sent none). */
  history: ChatTurn[];
  wantsStream: boolean;
  options: ChatRouteOptions;
}

/** Stream (or collect) a chat over a remote agent's reverse WS tunnel (G4.S7.T4). */
async function handleRemoteChat(
  reply: { hijack: () => void; raw: unknown; code: (code: number) => { send: (payload: unknown) => unknown } },
  ctx: RemoteChatContext,
): Promise<unknown> {
  const { agentId, message, page, history, wantsStream, options } = ctx;
  const { hub, registry } = options;
  const context = {
    thresholdTokens: DEFAULT_CONTEXT_THRESHOLD_TOKENS,
    recentMaxTurns: DEFAULT_RECENT_MAX_TURNS,
    summarizer: options.summarizer,
  };
  const offlineError = `agent is offline — it must connect INTO the platform via the reverse WS tunnel first`;
  const notConfigured = "remote chat routing is not configured on this server";

  if (!wantsStream) {
    if (!hub || !registry) {
      return reply.code(400).send({ error: notConfigured });
    }
    try {
      const answer = await new Promise<string>((resolve, reject) => {
        const collected: string[] = [];
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error("agent did not complete the task in time"));
          }
        }, 60 * 1000);
        timer.unref?.();
        void pushRemoteChatTask(hub, registry, agentId, message, page, history, context, {
          onDelta: (text) => collected.push(text),
          onDone: () => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve(collected.join(""));
            }
          },
          onError: (err) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(new Error(err));
            }
          },
        })
          .then((result) => {
            if (result.taskId === null && !settled) {
              settled = true;
              clearTimeout(timer);
              reject(new Error(offlineError));
            }
          })
          .catch((err) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(err);
            }
          });
      });
      return { reply: answer };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  reply.hijack();
  const raw = reply.raw as import("node:http").ServerResponse;
  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Guard against a silently-disconnected agent: bail the stream after the
  // timeout so the browser does not hang forever waiting for a run to finish.
  const TIMEOUT_MS = 5 * 60 * 1000;
  let timer: NodeJS.Timeout | undefined;
  const done = (): void => {
    if (timer) clearTimeout(timer);
    raw.write(sseFrame({ done: true }));
    raw.end();
  };
  const fail = (err: string): void => {
    if (timer) clearTimeout(timer);
    raw.write(sseFrame({ error: err }));
    done();
  };
  timer = setTimeout(() => fail("agent did not complete the task in time"), TIMEOUT_MS);
  timer.unref?.();

  try {
    if (!hub || !registry) {
      fail(notConfigured);
      return undefined;
    }
    const result = await pushRemoteChatTask(hub, registry, agentId, message, page, history, context, {
      onDelta: (text) => raw.write(sseFrame({ delta: text })),
      onThinking: (text) => raw.write(sseFrame({ thinking: text })),
      onToolStarted: (tool, detail) =>
        raw.write(sseFrame({ tool: { state: "started", name: tool, detail } })),
      onToolCompleted: (tool, detail, error, output) =>
        raw.write(
          sseFrame({
            tool: {
              state: error ? "failed" : "completed",
              name: tool,
              detail,
              error,
              // G4.S7.T11: relay the tool result content when the agent sent it.
              ...(output !== undefined ? { output } : {}),
            },
          }),
        ),
      onDone: () => done(),
      onError: (err) => fail(err),
    });
    if (result.taskId === null) {
      fail(offlineError);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  return undefined;
}
