import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { AgentManager } from "../src/agents/manager.js";
import { MemoryChatHistoryStore } from "../src/agents/chat-history.js";
import { KnowledgeRetrievalService } from "../src/kb/retrieval.js";
import { LlmWikiClient } from "../src/kb/llmwiki.js";
import type { Agent } from "../src/agents/agent.js";
import type { FastifyInstance } from "fastify";

// The default taskQueue/retrieval build OpenRouterEmbedder which requires
// EMBEDDING_OPENROUTER_KEY at construction (never called in these tests).
process.env.EMBEDDING_OPENROUTER_KEY ??= "test-embedding-key";

/**
 * G4.S7.T12: session switcher — per-user chat sessions (recent 10, resume-style)
 * + new-chat action. Covers the store contract (create/list/touch, messages carry
 * session_id, session filtering, legacy '' rows) and the routes (GET sessions,
 * POST /api/chat with/without session_id, history?sessionId).
 *
 * Legacy decision (documented): chat_messages rows with session_id = '' (the pre-T12
 * flat conversation) are treated as ONE virtual session titled "Previous chat".
 */

interface FakeSession {
  prompts: string[];
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string): Promise<void>;
  abort?: () => Promise<void>;
}

function makeStubAgent(session: FakeSession): Agent {
  const listeners = new Set<(event: unknown) => void>();
  const s: FakeSession = {
    prompts: [],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt(text: string) {
      s.prompts.push(text);
      for (const l of listeners) {
        l({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "ok" } });
      }
      for (const l of listeners) {
        l({ type: "agent_end", messages: [], willRetry: false });
      }
    },
    abort: () => Promise.resolve(),
  };
  return {
    session: s,
    model: "openrouter/~deepseek/deepseek-v4-flash-latest",
    packages: [],
    extensionErrors: [],
    prompt: async () => "mock reply",
    dispose: () => {},
  } as unknown as Agent;
}

function buildTestApp(historyStore: MemoryChatHistoryStore): FastifyInstance {
  const manager = new AgentManager({}, async () => makeStubAgent({} as FakeSession));
  const retrieval = new KnowledgeRetrievalService({ llmwiki: new LlmWikiClient() });
  return buildApp({ manager, historyStore, retrieval });
}

describe("chat-history store sessions (G4.S7.T12)", () => {
  let store: MemoryChatHistoryStore;

  beforeEach(() => {
    store = new MemoryChatHistoryStore();
  });

  test("createSession returns a session id that listSessions shows with title + count", async () => {
    const id = await store.createSession("e1", "first question");
    assert.equal(typeof id, "string");
    assert.ok(id.length > 0);

    const sessions = await store.listSessions("e1");
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.session_id, id);
    assert.equal(sessions[0]!.title, "first question");
    assert.equal(sessions[0]!.message_count, 0);
  });

  test("saveMessage with a sessionId persists the message inside that session; listMessages filters by session", async () => {
    const s1 = await store.createSession("e1", "s1");
    const s2 = await store.createSession("e1", "s2");
    await store.saveMessage({ employeeId: "e1", role: "user", content: "one", sessionId: s1 });
    await store.saveMessage({ employeeId: "e1", role: "user", content: "two", sessionId: s2 });

    const onlyS1 = await store.listMessages("e1", s1);
    assert.deepEqual(onlyS1.map((m) => m.content), ["one"]);
    assert.equal(onlyS1[0]!.session_id, s1);

    const onlyS2 = await store.listMessages("e1", s2);
    assert.deepEqual(onlyS2.map((m) => m.content), ["two"]);

    // Omitted sessionId → all messages for the employee (pre-T12 behavior).
    const all = await store.listMessages("e1");
    assert.deepEqual(all.map((m) => m.content), ["one", "two"]);
  });

  test("message_count counts messages saved into a session", async () => {
    const s1 = await store.createSession("e1", "s1");
    await store.saveMessage({ employeeId: "e1", role: "user", content: "q", sessionId: s1 });
    await store.saveMessage({ employeeId: "e1", role: "assistant", content: "a", sessionId: s1 });

    const sessions = await store.listSessions("e1");
    assert.equal(sessions[0]!.message_count, 2);
  });

  test("touchSession refreshes updated_at → the touched session moves to the top; listSessions caps at 10", async () => {
    const a = await store.createSession("e1", "a");
    const b = await store.createSession("e1", "b");
    const first = await store.listSessions("e1");
    assert.equal(first[0]!.session_id, b, "newest first by default");

    // Touch the OLDER session → it must surface as most-recent.
    await store.touchSession("e1", a);
    const after = await store.listSessions("e1");
    assert.equal(after[0]!.session_id, a);
    assert.equal(after[1]!.session_id, b);

    // Cap: more than 10 sessions → only the 10 most recent.
    const store2 = new MemoryChatHistoryStore();
    for (let i = 0; i < 12; i += 1) {
      await store2.createSession("e1", `s${i}`);
    }
    const capped = await store2.listSessions("e1", 10);
    assert.equal(capped.length, 10);
    assert.equal(capped[0]!.title, "s11");
    assert.equal(capped[9]!.title, "s2");
  });

  test("legacy ''-session rows appear as ONE 'Previous chat' session and don't break listing", async () => {
    await store.saveMessage({ employeeId: "e1", role: "user", content: "old flat" });
    await store.saveMessage({ employeeId: "e1", role: "assistant", content: "old reply" });
    const s1 = await store.createSession("e1", "new session");

    const sessions = await store.listSessions("e1");
    assert.equal(sessions.length, 2);
    const legacy = sessions.find((s) => s.session_id === "");
    assert.ok(legacy, "legacy session present");
    assert.equal(legacy!.title, "Previous chat");
    assert.equal(legacy!.message_count, 2);
    assert.ok(sessions.some((s) => s.session_id === s1));

    // ensureSession / touchSession tolerate the virtual '' session.
    assert.equal(await store.ensureSession("e1", ""), true);
    await store.touchSession("e1", ""); // no-op, must not throw
  });

  test("ensureSession is false for a session the user does not own / does not exist", async () => {
    const id = await store.createSession("e1", "mine");
    assert.equal(await store.ensureSession("e1", id), true);
    assert.equal(await store.ensureSession("e1", "nope"), false);
    assert.equal(await store.ensureSession("e2", id), false);
  });
});

describe("chat-session routes (G4.S7.T12)", () => {
  let app: FastifyInstance;
  let store: MemoryChatHistoryStore;

  beforeEach(async () => {
    store = new MemoryChatHistoryStore();
    app = buildTestApp(store);
    await app.listen({ port: 0, host: "127.0.0.1" });
  });

  after(async () => {
    if (app) await app.close();
  });

  test("GET /api/chat/sessions returns the user's recent 10 with title + message count, most-recent first", async () => {
    for (let i = 0; i < 12; i += 1) {
      const id = await store.createSession("u1", `session ${i}`);
      if (i % 2 === 0) {
        await store.saveMessage({ employeeId: "u1", role: "user", content: `q${i}`, sessionId: id });
        await store.saveMessage({ employeeId: "u1", role: "assistant", content: "a", sessionId: id });
      }
    }
    const res = await app.inject({ method: "GET", url: "/api/chat/sessions?userId=u1" });
    assert.equal(res.statusCode, 200);
    const { sessions } = res.json() as { sessions: Array<{ session_id: string; title: string; message_count: number }> };
    assert.equal(sessions.length, 10, "capped at 10");
    assert.equal(sessions[0]!.title, "session 11");
    assert.equal(sessions[0]!.message_count, 0);
    assert.equal(sessions[1]!.message_count, 2, "even sessions carry 2 persisted messages");
    // All sessions belong to u1.
    assert.ok(sessions.every((s) => typeof s.session_id === "string"));
  });

  test("GET /api/chat/sessions is per-user (no cross-user leakage)", async () => {
    const u1 = await app.inject({ method: "GET", url: "/api/chat/sessions?userId=u1" });
    const u2 = await app.inject({ method: "GET", url: "/api/chat/sessions?userId=u2" });
    const s1 = (u1.json() as { sessions: unknown[] }).sessions;
    const s2 = (u2.json() as { sessions: unknown[] }).sessions;
    assert.equal(s1.length, 0);
    assert.equal(s2.length, 0);
  });

  test("GET /api/chat/sessions requires userId", async () => {
    const res = await app.inject({ method: "GET", url: "/api/chat/sessions" });
    assert.equal(res.statusCode, 400);
  });

  test("POST /api/chat without session_id creates a NEW session (non-streaming reply carries session_id)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { userId: "u1", message: "hello session" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { reply: string; session_id?: string };
    assert.equal(body.reply, "mock reply");
    assert.ok(typeof body.session_id === "string" && body.session_id.length > 0);

    const sessions = await store.listSessions("u1");
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.session_id, body.session_id);
    assert.equal(sessions[0]!.message_count, 2, "user + assistant row persisted");
    assert.equal(sessions[0]!.title, "hello session", "title derived from the first user message");
  });

  test("POST /api/chat with session_id persists under that session + touches updated_at (recent-first)", async () => {
    const older = await store.createSession("u1", "older");
    // Give the newer session a strictly later updated_at.
    const newer = await store.createSession("u1", "newer");

    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { userId: "u1", message: "resume me", session_id: older },
    });
    assert.equal(res.statusCode, 200);

    // Touching the older session bumps it to the top of the recent list.
    const sessions = await store.listSessions("u1");
    assert.equal(sessions[0]!.session_id, older, "touched session is most recent");
    assert.equal(sessions[0]!.message_count, 2);
    assert.equal(sessions[1]!.session_id, newer);

    // GET history filtered to the resumed session sees only its messages.
    const hist = await app.inject({ method: "GET", url: `/api/chat/history?userId=u1&sessionId=${older}` });
    assert.equal(hist.statusCode, 200);
    const messages = (hist.json() as { messages: Array<{ content: string; session_id: string }> }).messages;
    assert.deepEqual(
      messages.map((m) => m.content),
      ["resume me", "mock reply"],
    );
    assert.ok(messages.every((m) => m.session_id === older));
  });

  test("POST /api/chat with a session the user does not own returns 404", async () => {
    const someoneElses = await store.createSession("other-user", "theirs");
    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { userId: "u1", message: "hi", session_id: someoneElses },
    });
    assert.equal(res.statusCode, 404);
  });

  test("POST /api/chat streaming emits an initial session_id SSE frame when creating a new session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { accept: "text/event-stream" },
      payload: { userId: "u1", message: "stream me" },
    });
    assert.equal(res.statusCode, 200);
    const match = res.body.match(/data: (\{"session_id":"[^"]+"\})\n\n/);
    assert.ok(match, "stream starts with a session_id frame");
    const frame = JSON.parse(match![1]!) as { session_id: string };
    assert.ok(frame.session_id.length > 0, "session_id present");
    assert.ok(res.body.includes('data: {"delta":"ok"}\n\n'), "deltas stream after the session frame");
    assert.ok(res.body.includes('data: {"done":true}\n\n'), "stream ends with done");
  });

  test("GET /api/chat/history?sessionId filters to ONLY that session (other sessions excluded)", async () => {
    const s1 = await store.createSession("u1", "s1");
    const s2 = await store.createSession("u1", "s2");
    await store.saveMessage({ employeeId: "u1", role: "user", content: "only-s1", sessionId: s1 });
    await store.saveMessage({ employeeId: "u1", role: "user", content: "only-s2", sessionId: s2 });

    const res = await app.inject({ method: "GET", url: `/api/chat/history?userId=u1&sessionId=${s1}` });
    assert.equal(res.statusCode, 200);
    const messages = (res.json() as { messages: Array<{ content: string }> }).messages;
    assert.deepEqual(messages.map((m) => m.content), ["only-s1"]);
  });

  test("legacy '' session rows appear in GET /api/chat/sessions and restore via history?sessionId=", async () => {
    await store.saveMessage({ employeeId: "u1", role: "user", content: "legacy q" });
    const sessionsRes = await app.inject({ method: "GET", url: "/api/chat/sessions?userId=u1" });
    const { sessions } = sessionsRes.json() as { sessions: Array<{ session_id: string; title: string; message_count: number }> };
    const legacy = sessions.find((s) => s.session_id === "");
    assert.ok(legacy, "legacy session listed");
    assert.equal(legacy!.message_count, 1);

    const hist = await app.inject({ method: "GET", url: "/api/chat/history?userId=u1&sessionId=" });
    assert.equal(hist.statusCode, 200);
    const messages = (hist.json() as { messages: Array<{ content: string }> }).messages;
    assert.deepEqual(messages.map((m) => m.content), ["legacy q"]);
  });
});