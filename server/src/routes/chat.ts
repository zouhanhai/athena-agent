import type { FastifyInstance } from "fastify";
import type { AgentManager } from "../agents/manager.js";
import { streamAgentChat } from "../agents/stream.js";
import { buildPageInjection, injectPageContext } from "../agents/page-context.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { AgentWsGateway } from "../ws/agent.js";
import { pushRemoteChatTask } from "../agents/remote-chat.js";
import type { ChatHistoryStore } from "../agents/chat-history.js";
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
  /**
   * G4.S7.T12: the chat session to persist/resume. When present the messages
   * are stored under that session (404 if it does not belong to the user);
   * when absent the server creates a NEW session automatically.
   */
  session_id?: unknown;
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
  /**
   * G4.S7.T11-followup: per-user chat history persistence. Absent store → the
   * chat remains in-memory only (no F5 persistence) and GET /api/chat/history
   * returns an empty list. Injected so tests/legacy setups don't require one.
   */
  historyStore?: ChatHistoryStore;
}

function invalidField(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

/** G4.S7.T12: derive a session title from its first user message (flattened to
 *  one line, truncated) — "New chat" when the message is empty. */
function deriveSessionTitle(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine ? oneLine.slice(0, 60) : "New chat";
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

  // G4.S7.T11-followup: per-user chat history restore (F5 persistence).
  // GET /api/chat/history?userId=<id>&limit=N[&sessionId=<sid>] → persisted
  // messages newest-first window (the store returns oldest-first for rendering
  // order). G4.S7.T12: with `sessionId` the window is scoped to that session.
  app.get("/api/chat/history", async (request, reply) => {
    const query = (request.query ?? {}) as {
      userId?: unknown;
      limit?: unknown;
      sessionId?: unknown;
    };
    if (invalidField(query.userId)) {
      return reply.code(400).send({ error: "userId is required" });
    }
    const userId = query.userId as string;
    const sessionId = typeof query.sessionId === "string" ? query.sessionId : undefined;
    const limitRaw =
      typeof query.limit === "string" && /^\d+$/.test(query.limit)
        ? Number(query.limit)
        : 200;
    if (!options.historyStore) {
      return { messages: [] };
    }
    try {
      const messages = await options.historyStore.listMessages(
        userId,
        sessionId,
        limitRaw,
      );
      return { messages };
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // G4.S7.T12: session switcher — a user's recent chat sessions (max 10, most
  // recent first), each with title + timestamps + message count. Cheap list (no
  // full messages); restoring messages happens via GET /api/chat/history.
  app.get("/api/chat/sessions", async (request, reply) => {
    const query = (request.query ?? {}) as { userId?: unknown; limit?: unknown };
    if (invalidField(query.userId)) {
      return reply.code(400).send({ error: "userId is required" });
    }
    if (!options.historyStore) {
      return { sessions: [] };
    }
    const userId = query.userId as string;
    const limitRaw =
      typeof query.limit === "string" && /^\d+$/.test(query.limit)
        ? Number(query.limit)
        : 10;
    try {
      const sessions = await options.historyStore.listSessions(userId, limitRaw);
      return { sessions };
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // G4.S7.T13: rename a session (the user's own label so history is easier to
  // find). PATCH /api/chat/sessions/:sessionId { userId, title } → 200 {ok} |
  // 404 (not the user's session) | 400 (bad input) | 500.
  app.patch("/api/chat/sessions/:sessionId", async (request, reply) => {
    const params = request.params as { sessionId?: unknown };
    const body = (request.body ?? {}) as {
      userId?: unknown;
      title?: unknown;
    };
    if (invalidField(params.sessionId)) {
      return reply.code(400).send({ error: "sessionId is required" });
    }
    if (invalidField(body.userId)) {
      return reply.code(400).send({ error: "userId is required" });
    }
    const sessionId =
      params.sessionId === "legacy" ? "" : (params.sessionId as string).trim();
    const titleRaw = typeof body.title === "string" ? body.title : "";
    const title = titleRaw.trim();
    if (!title) {
      return reply.code(400).send({ error: "title is required" });
    }
    if (!options.historyStore) {
      return reply.code(404).send({ error: "history store is not configured" });
    }
    try {
      // G4.S7.T13-fix: '' (the virtual legacy "Previous chat" session) is
      // renamed via the per-employee legacy-title override, not a session row.
      if (sessionId === "") {
        const hasLegacy = await options.historyStore.ensureSession(
          body.userId as string,
          "",
        );
        if (!hasLegacy) {
          return reply.code(404).send({ error: "session not found or not yours" });
        }
        await options.historyStore.setLegacyTitle(body.userId as string, title);
        return { ok: true, session_id: "", title: title.slice(0, 120) };
      }
      const renamed = await options.historyStore.renameSession(
        body.userId as string,
        sessionId,
        title,
      );
      if (!renamed) {
        return reply.code(404).send({ error: "session not found or not yours" });
      }
      return { ok: true, session_id: sessionId, title: title.slice(0, 120) };
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // G4.S7.T15: delete one session (and its messages) — the user's own history.
  // DELETE /api/chat/sessions/:sessionId?userId=<id> → 200 {ok} | 404 | 400.
  app.delete("/api/chat/sessions/:sessionId", async (request, reply) => {
    const params = request.params as { sessionId?: unknown };
    const query = (request.query ?? {}) as { userId?: unknown };
    if (invalidField(params.sessionId)) {
      return reply.code(400).send({ error: "sessionId is required" });
    }
    if (invalidField(query.userId)) {
      return reply.code(400).send({ error: "userId is required" });
    }
    const sessionId =
      params.sessionId === "legacy" ? "" : (params.sessionId as string).trim();
    if (!options.historyStore) {
      return reply.code(404).send({ error: "history store is not configured" });
    }
    try {
      // The virtual legacy session ('' => "legacy" wire id) has no real row;
      // deleting it removes the override + its messages, if any.
      if (sessionId === "") {
        await options.historyStore.setLegacyTitle(query.userId as string, "");
        const deleted = await options.historyStore.deleteSession(
          query.userId as string,
          "",
        );
        void deleted; // always ok: legacy delete is idempotent
        return { ok: true, session_id: "" };
      }
      const deleted = await options.historyStore.deleteSession(
        query.userId as string,
        sessionId,
      );
      if (!deleted) {
        return reply.code(404).send({ error: "session not found or not yours" });
      }
      return { ok: true, session_id: sessionId };
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

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
    // G4.S7.T12: the session this message belongs to. '' is treated as absent
    // (a new session is created) when no store is available.
    const requestedSession =
      typeof body.session_id === "string" ? body.session_id.trim() : "";
    const clarifyAnswer = parseClarifyAnswer(body.clarify);
    const history = parseHistory(body.history);

    const wantsStream =
      typeof request.headers.accept === "string" &&
      request.headers.accept.includes("text/event-stream");

    // G4.S7.T12: resolve the session — create a new one when none was given
    // (resume-style picker starts a fresh conversation by default), or verify
    // ownership of a requested one (404 for another user's session). Legacy
    // '' is allowed (the flat pre-T12 conversation is a valid virtual session).
    const session =
      options.historyStore && !agentId
        ? await resolveChatSession(options.historyStore, userId, requestedSession, message, reply)
        : requestedSession;
    if (session === null) {
      // resolveChatSession already sent the 404.
      return reply;
    }

    if (agentId) {
      return await handleRemoteChat(reply, {
        employeeId: userId,
        agentId,
        message,
        page,
        history,
        sessionId: session,
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
      // G4.S7.T11-followup: accumulate the streamed answer for persistence.
      const chunks: string[] = [];
      try {
        // G4.S7.T12: emit the resolved session_id up front so the client learns
        // the session a newly-created conversation belongs to.
        raw.write(sseFrame({ session_id: session }));
        for await (const event of streamAgentChat(agent, finalPrompt)) {
          if (event.type === "clarify") {
            chunks.push(event.clarification.question);
            raw.write(sseFrame({
              clarify: {
                question: event.clarification.question,
                options: event.clarification.options,
                query: event.clarification.query,
              },
            }));
          } else {
            chunks.push(event.text);
            raw.write(sseFrame({ delta: event.text }));
          }
        }
        raw.write(sseFrame({ done: true }));
        await persistTurn(options.historyStore, {
          employeeId: userId,
          page,
          userText: message,
          assistantText: chunks.join(""),
          speakerId: "athena",
          speakerName: "Athena",
          sessionId: session,
          clarifyAnswer: Boolean(clarifyAnswer),
        });
      } catch (err) {
        raw.write(sseFrame({ error: err instanceof Error ? err.message : String(err) }));
      } finally {
        raw.end();
      }
      return;
    }

    try {
      console.log(`[chat-debug] prompt start user=${userId} len=${finalPrompt.length}`);
      const t0 = Date.now();
      const replyText = await agent.prompt(finalPrompt);
      console.log(`[chat-debug] prompt done ms=${Date.now() - t0} replyLen=${(replyText || "").length}`);

      await persistTurn(options.historyStore, {
        employeeId: userId,
        page,
        userText: message,
        assistantText: replyText,
        speakerId: "athena",
        speakerName: "Athena",
        sessionId: session,
        clarifyAnswer: Boolean(clarifyAnswer),
      });
      // G4.S7.T12: echo the session_id so the client can attach subsequent
      // messages to the newly-created session.
      return { reply: replyText, session_id: session };
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/**
 * G4.S7.T12: resolve the chat session for a POST /api/chat.
 * - No `sessionId` given → create a NEW session (returns its id).
 * - `sessionId` given and owned by the user → return it as-is.
 * - `sessionId` given but not the user's → send 404 and return null.
 * The legacy '' session is resolved as the virtual flat conversation.
 */
async function resolveChatSession(
  store: ChatHistoryStore,
  userId: string,
  sessionId: string,
  firstMessage: string,
  reply: import("fastify").FastifyReply,
): Promise<string | null> {
  if (!sessionId) {
    const created = await store.createSession(userId, deriveSessionTitle(firstMessage));
    // G4.S7.T14: keep at most 10 sessions per user — the oldest are pruned
    // (with their messages) when a new session pushes the count past 10.
    if (typeof store.pruneSessions === "function") {
      try {
        await store.pruneSessions(userId, 10);
      } catch (err) {
        // Pruning is best-effort; a prune failure must never break the chat.
        console.warn("[chat] session prune failed (ignored):", err);
      }
    }
    return created;
  }
  const owns = await store.ensureSession(userId, sessionId);
  if (!owns) {
    reply.code(404).send({ error: "session not found" });
    return null;
  }
  return sessionId;
}

/** G4.S7.T11-followup: persist one user→assistant turn (best-effort; never fails the request). */
async function persistTurn(
  store: ChatHistoryStore | undefined,
  turn: {
    employeeId: string;
    page: string;
    userText: string;
    assistantText: string;
    speakerId?: string;
    speakerName?: string;
    sessionId?: string;
    clarifyAnswer?: boolean;
  },
): Promise<void> {
  if (!store) return;
  try {
    // The clarify follow-up re-runs the query with the user's chosen option as
    // the final prompt; the user bubble was already shown before the follow-up,
    // so only the assistant's answer (the option-confirmed reply) is persisted.
    await store.saveMessage({
      employeeId: turn.employeeId,
      role: "user",
      content: turn.userText,
      page: turn.page,
      speakerId: turn.employeeId,
      speakerName: "",
      sessionId: turn.sessionId,
    });
    await store.saveMessage({
      employeeId: turn.employeeId,
      role: "assistant",
      content: turn.assistantText,
      page: turn.page,
      speakerId: turn.speakerId ?? "",
      speakerName: turn.speakerName ?? "",
      sessionId: turn.sessionId,
    });
    // G4.S7.T12: a message landing in a session refreshes its last-activity
    // timestamp so the picker surfaces recently-active sessions first.
    if (turn.sessionId) {
      await store.touchSession(turn.employeeId, turn.sessionId);
    }
  } catch (err) {
    // Persistence is best-effort: a DB hiccup must never break the chat.
    console.warn("[chat-history] persist failed (ignored):", err);
  }
}

interface RemoteChatContext {
  /** G4.S7.T11-followup: the employee owning the conversation (for persistence). */
  employeeId: string;
  agentId: string;
  message: string;
  page: string;
  /** G4.S7.T10: validated accumulated history (empty when the client sent none). */
  history: ChatTurn[];
  /** G4.S7.T12: the session the remote turn persists under ('' when unset). */
  sessionId: string;
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
  // G4.S7.T11-followup: remember the target agent's alias for the persisted turn.
  let remoteAlias = agentId;
  if (registry) {
    try {
      const rec = await registry.getByAgentId(agentId);
      if (rec?.alias) remoteAlias = rec.alias;
    } catch {}
  }

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
      // G4.S7.T11-followup: persist the remote turn (best-effort).
      await persistTurn(options.historyStore, {
        employeeId: ctx.employeeId,
        page,
        userText: message,
        assistantText: answer,
        speakerId: agentId,
        speakerName: remoteAlias,
        sessionId: ctx.sessionId,
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
  // G4.S7.T11-followup: accumulate streamed deltas for persistence on success.
  const deltaChunks: string[] = [];
  const done = (): void => {
    if (timer) clearTimeout(timer);
    raw.write(sseFrame({ done: true }));
    raw.end();
  };
  const succeed = (): void => {
    done();
    void persistTurn(options.historyStore, {
      employeeId: ctx.employeeId,
      page,
      userText: message,
      assistantText: deltaChunks.join(""),
      speakerId: agentId,
      speakerName: remoteAlias,
      sessionId: ctx.sessionId,
    });
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
      onDelta: (text) => {
        deltaChunks.push(text);
        raw.write(sseFrame({ delta: text }));
      },
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
      onDone: () => succeed(),
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
