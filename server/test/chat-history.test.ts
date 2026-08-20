import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import {
  MemoryChatHistoryStore,
  type ChatHistoryStore,
} from "../src/agents/chat-history.js";
import type { FastifyInstance } from "fastify";

/**
 * G4.S7.T11-followup: per-user chat history persistence (F5 restore).
 * Covers the store contract (save/list/idempotency) and the
 * GET /api/chat/history route (per-employee isolation, ordering, limit).
 */

describe("chat-history store (memory)", () => {
  let store: ChatHistoryStore;

  beforeEach(() => {
    store = new MemoryChatHistoryStore();
  });

  test("saves and lists messages oldest-first for one employee", async () => {
    await store.saveMessage({ employeeId: "e1", role: "user", content: "hi" });
    await store.saveMessage({ employeeId: "e1", role: "assistant", content: "hello", speakerId: "athena", speakerName: "Athena" });
    await store.saveMessage({ employeeId: "e1", role: "user", content: "again" });

    const list = await store.listMessages("e1");
    assert.equal(list.length, 3);
    assert.deepEqual(
      list.map((m) => m.content),
      ["hi", "hello", "again"],
    );
    assert.equal(list[1].speaker_name, "Athena");
  });

  test("isolates history per employee", async () => {
    await store.saveMessage({ employeeId: "e1", role: "user", content: "mine" });
    await store.saveMessage({ employeeId: "e2", role: "user", content: "theirs" });

    const e1 = await store.listMessages("e1");
    const e2 = await store.listMessages("e2");
    assert.equal(e1.length, 1);
    assert.equal(e1[0].content, "mine");
    assert.equal(e2.length, 1);
    assert.equal(e2[0].content, "theirs");
  });

  test("save is idempotent per message_id", async () => {
    await store.saveMessage({ employeeId: "e1", role: "user", content: "once", messageId: "m1" });
    await store.saveMessage({ employeeId: "e1", role: "user", content: "twice", messageId: "m1" });
    const list = await store.listMessages("e1");
    assert.equal(list.length, 1);
    assert.equal(list[0].content, "once");
  });

  test("limit keeps only the most recent N (oldest-first among them)", async () => {
    for (let i = 0; i < 5; i++) {
      await store.saveMessage({ employeeId: "e1", role: "user", content: `msg${i}` });
    }
    const list = await store.listMessages("e1", undefined, 3);
    assert.deepEqual(
      list.map((m) => m.content),
      ["msg2", "msg3", "msg4"],
    );
  });
});

describe("GET /api/chat/history", () => {
  let app: FastifyInstance;
  const memoryStore = new MemoryChatHistoryStore();

  beforeEach(async () => {
    app = buildApp({ historyStore: memoryStore });
    await app.listen({ port: 0, host: "127.0.0.1" });
  });

  after(async () => {
    await app.close();
  });

  test("returns persisted messages for the userId (oldest-first)", async () => {
    await memoryStore.saveMessage({ employeeId: "u1", role: "user", content: "first" });
    await memoryStore.saveMessage({ employeeId: "u1", role: "assistant", content: "reply", speakerName: "Athena" });

    const res = await app.inject({
      method: "GET",
      url: "/api/chat/history?userId=u1",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(
      body.messages.map((m: { content: string }) => m.content),
      ["first", "reply"],
    );
  });

  test("400 when userId missing", async () => {
    const res = await app.inject({ method: "GET", url: "/api/chat/history" });
    assert.equal(res.statusCode, 400);
  });

  test("empty list when the store has no history for the user", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/chat/history?userId=nobody",
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().messages, []);
  });
});