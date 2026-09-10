/**
 * G4.S10.T7 — HTTP surface of the header review gate: GET outline (cards + T6
 * match info + draft), PUT draft (payload contract), POST approve/skip
 * (release into refinement), POST assist (Athena suggestions through the
 * refinement judge path, 48K-char cap, never auto-applied), settings GET/PUT.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/app.js";
import { IngestTaskQueue } from "../../src/kb/tasks.js";
import { FileHeaderReviewSettingsStore } from "../../src/kb/header-review-settings.js";
import {
  HEADER_REVIEW_ASSIST_MAX_CHARS,
  type HeaderEditOp,
  type HeaderReviewSettingsStore,
} from "../../src/kb/header-review.js";
import { MemoryAuthTokenStore, MagicLinkAuthService, type MagicLinkMailer } from "../../src/employees/auth.js";
import { MemoryEmployeeRegistry } from "../../src/employees/employees.js";
import { createSecretCipher } from "../../src/employees/crypto.js";
import type { FastifyInstance } from "fastify";

const TEST_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

/** Document with enough headings to engage the gate (minHeaders default 8). */
const DOC = [
  "# Intro",
  "",
  "body",
  "## Purpose",
  "",
  "purpose body",
  "## Prerequisites",
  "",
  "pre body",
  "## Related Information",
  "",
  "related body",
  "# Setup",
  "",
  "## Step 1",
  "",
  "step 1 body",
  "## Step 2",
  "",
  "step 2 body",
].join("\n");

const SETTINGS_STORE_DEFAULTS = {
  enabled: true,
  minHeaders: 4,
  templateWords: ["Purpose", "Prerequisites", "Related Information"],
};

function memorySettings(): HeaderReviewSettingsStore {
  let current = { ...SETTINGS_STORE_DEFAULTS, templateWords: [...SETTINGS_STORE_DEFAULTS.templateWords] };
  return {
    async get() {
      return { ...current, templateWords: [...current.templateWords] };
    },
    async update(patch) {
      current = {
        enabled: patch.enabled ?? current.enabled,
        minHeaders: patch.minHeaders ?? current.minHeaders,
        templateWords: patch.templateWords ?? current.templateWords,
      };
      return { ...current, templateWords: [...current.templateWords] };
    },
    async setTemplateWords(words) {
      return this.update({ templateWords: words });
    },
  };
}

let app: FastifyInstance;
let queue: IngestTaskQueue;
let settings: HeaderReviewSettingsStore;
let sent: { to: string; magicLinkUrl: string }[];
let assistCalls: { userContent: string; schema: unknown }[] = [];
let assistResponse: string;
let tmpDir: string;

function makeTaskQueue(store: HeaderReviewSettingsStore): IngestTaskQueue {
  const refinedInputs: string[] = [];
  const parser = {
    async parse() {
      return { markdown: DOC, outputPath: "/shared/input/doc.md", stem: "doc" };
    },
  };
  const refiner = async (markdown: string) => {
    refinedInputs.push(markdown);
    return {
      ref: {
        md_ref: "/storage/doc/markdown.md",
        chunks_ref: "/storage/doc/chunks.json",
        preview: "preview",
        char_count: 1,
        line_count: 1,
        header_count: 7,
        chunk_count: 1,
        frontmatter: { type: "concept", topic: "sommerseminar" },
        entities: [],
        relations: [],
        keywords: [],
        quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
        mode: "single",
        sections: [],
      },
      markdown: "# Refined",
      ragMarkdown: "# Refined",
    };
  };
  const ingest = {
    async prepareForIngest(input: { title: string; content: string }) {
      return {
        classification: { category: "concept", pagePath: "wiki/concepts/doc.md", topic: "sommerseminar" },
        frontmatterContent: `---\ntype: concept\ntitle: ${input.title}\ntopic: sommerseminar\n---\n\n${input.content}`,
      };
    },
    async ingestLlmWiki() {
      return { ok: true };
    },
  };
  return new IngestTaskQueue({
    parser: parser as never,
    ingest: ingest as never,
    refiner: refiner as never,
    headerReview: { settings: store, draftDir: tmpDir },
  });
}

async function login(email: string): Promise<string> {
  await app.inject({ method: "POST", url: "/api/auth/login", payload: { email } });
  const match = /[?&]token=([^&]+)/.exec(sent[sent.length - 1]!.magicLinkUrl);
  assert.ok(match);
  const res = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { token: decodeURIComponent(match[1]!) } });
  assert.equal(res.statusCode, 200);
  return (res.json() as { session_token: string }).session_token;
}

async function untilStatus(taskId: string, status: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const task = queue.getTask(taskId)!;
    if (task.status === status || task.status === "failed") return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`task did not reach ${status}`);
}

beforeEach(async () => {
  sent = [];
  assistCalls = [];
  assistResponse = JSON.stringify({
    suggestions: [
      { kind: "demote-to-bold", targetIds: ["1"], reason: "template field Purpose" },
      { kind: "set-level", targetIds: ["5"], level: 3, reason: "misleveled" },
    ],
  });
  tmpDir = await mkdtemp(join(tmpdir(), "hr-routes-"));
  settings = memorySettings();
  queue = makeTaskQueue(settings);
  const registry = new MemoryEmployeeRegistry(
    [
      { email: "admin@caleo.com", display_name: "Admin", role: "admin" },
      { email: "member@caleo.com", display_name: "Member", role: "member" },
    ],
    { cipher: createSecretCipher(TEST_KEY) },
  );
  const mailer: MagicLinkMailer = {
    async sendLoginLink(input) {
      sent.push({ to: input.to, magicLinkUrl: input.magicLinkUrl });
    },
  };
  const auth = new MagicLinkAuthService({
    registry,
    mailer,
    tokens: new MemoryAuthTokenStore(),
    appBaseUrl: "http://localhost:5173",
  });
  app = buildApp({
    employees: registry,
    auth,
    ingest: { prepareForIngest: queue.ingest.prepareForIngest, ingestLlmWiki: queue.ingest.ingestLlmWiki } as never,
    taskQueue: queue,
    headerReview: {
      settings,
      assistLlm: async (params) => {
        assistCalls.push({ userContent: params.userContent, schema: params.schema });
        return {
          message: { role: "assistant", content: [{ type: "text", text: assistResponse }] },
        };
      },
    },
  });
});

after(async () => {
  if (app) await app.close();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

async function pauseUpload(): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/kb/ingest-url", payload: { url: "https://example.com/doc.pdf" } });
  assert.equal(res.statusCode, 202);
  const { taskId } = res.json() as { taskId: string };
  await untilStatus(taskId, "header_review");
  return taskId;
}

test("GET header-review outline while paused: cards + T6 match info + empty draft", async () => {
  const taskId = await pauseUpload();
  const res = await app.inject({ method: "GET", url: `/api/kb/task/${taskId}/header-review` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.taskId, taskId);
  assert.equal(body.state, "pending");
  assert.equal(body.headingCount, 7);
  assert.equal(body.cards.length, 7);
  assert.equal(body.cards[0]!.text, "Intro");
  assert.equal(body.cards[0]!.level, 1);
  const purpose = body.cards.find((c: { text: string }) => c.text === "Purpose");
  assert.equal(purpose.level, 2);
  assert.equal(body.draft, null);
});

test("GET header-review outline is 404 for unknown / 409 for non-paused tasks", async () => {
  const res404 = await app.inject({ method: "GET", url: "/api/kb/task/nope/header-review" });
  assert.equal(res404.statusCode, 404);
  // a task that bypassed the gate (tiny doc vs the minHeaders threshold) is not paused
  await settings.update({ minHeaders: 100 });
  const res = await app.inject({ method: "POST", url: "/api/kb/ingest-url", payload: { url: "https://x.example/tiny.pdf" } });
  assert.equal(res.statusCode, 202);
  const { taskId } = res.json() as { taskId: string };
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && queue.getTask(taskId)?.status !== "done") {
    await new Promise((r) => setTimeout(r, 5));
  }
  const res409 = await app.inject({ method: "GET", url: `/api/kb/task/${taskId}/header-review` });
  assert.equal(res409.statusCode, 409);
});

test("PUT draft validates the payload contract (400 on bad ops) and persists ops", async () => {
  const taskId = await pauseUpload();
  const bad = await app.inject({
    method: "PUT",
    url: `/api/kb/task/${taskId}/header-review/draft`,
    payload: { ops: [{ type: "move", index: 9999, parentId: null, position: 0 }] },
  });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /no heading with index/);
  const ok = await app.inject({
    method: "PUT",
    url: `/api/kb/task/${taskId}/header-review/draft`,
    payload: { ops: [{ type: "bold", index: 1 }, { type: "level", index: 3, level: 3 }] as HeaderEditOp[] },
  });
  assert.equal(ok.statusCode, 200);
  const body = ok.json();
  assert.equal(body.changes, 2);
  assert.equal(body.ops.length, 2);
  assert.equal(body.cards.find((c: { index: number }) => c.index === 1)!.bold, true);
  // the draft is served back by GET
  const view = await app.inject({ method: "GET", url: `/api/kb/task/${taskId}/header-review` });
  assert.equal(view.json().draft.ops.length, 2);
});

test("POST approve applies the draft, records the report and releases into refinement", async () => {
  const taskId = await pauseUpload();
  const original = queue.getTask(taskId)!.markdown;
  await app.inject({
    method: "PUT",
    url: `/api/kb/task/${taskId}/header-review/draft`,
    payload: { ops: [{ type: "bold", index: 2 }] }, // Prerequisites → bold
  });
  const res = await app.inject({
    method: "POST",
    url: `/api/kb/task/${taskId}/header-review/approve`,
    payload: { who: "hartmut" },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.edits.ops, 1);
  assert.equal(body.edits.bold, 1);
  await untilStatus(taskId, "done");
  const task = queue.getTask(taskId)!;
  assert.equal(task.headerReview?.state, "approved");
  assert.equal(task.headerReview?.who, "hartmut");
  assert.equal(task.headerReview?.edits?.ops, 1);
  assert.ok(task.headerReview?.durationMs !== undefined, "report carries the duration");
  assert.match(task.markdown!, /\*\*Prerequisites\*\*/);
  assert.ok(task.markdown !== original, "markdown rewritten");
  // approve again → 409 (only pending tasks can be resolved)
  const again = await app.inject({ method: "POST", url: `/api/kb/task/${taskId}/header-review/approve`, payload: {} });
  assert.equal(again.statusCode, 409);
});

test("POST skip releases the task unchanged (old behavior)", async () => {
  const taskId = await pauseUpload();
  const original = queue.getTask(taskId)!.markdown;
  const res = await app.inject({ method: "POST", url: `/api/kb/task/${taskId}/header-review/skip`, payload: {} });
  assert.equal(res.statusCode, 200);
  await untilStatus(taskId, "done");
  const task = queue.getTask(taskId)!;
  assert.equal(task.headerReview?.state, "skipped");
  assert.equal(task.markdown, original, "skip does not touch the markdown");
  assert.equal(task.headerReview?.edits, undefined);
});

test("assist requires an employee session and enforces the 48K-char cap", async () => {
  const taskId = await pauseUpload();
  const anon = await app.inject({
    method: "POST",
    url: `/api/kb/task/${taskId}/header-review/assist`,
    payload: { rows: [{ index: 0, text: "Intro", level: 1 }] },
  });
  assert.equal(anon.statusCode, 401);
  const token = await login("admin@caleo.com");
  const huge = await app.inject({
    method: "POST",
    url: `/api/kb/task/${taskId}/header-review/assist`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      rows: Array.from({ length: 3000 }, (_, i) => ({ index: i, text: "x".repeat(30), level: 2 })),
    },
  });
  assert.equal(huge.statusCode, 413);
  assert.match(huge.json().error, /LLM cap/);
});

test("assist returns suggestion chips through the refinement judge path (never applied)", async () => {
  const taskId = await pauseUpload();
  const token = await login("admin@caleo.com");
  const res = await app.inject({
    method: "POST",
    url: `/api/kb/task/${taskId}/header-review/assist`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      rows: [
        { index: 0, text: "Intro", level: 1 },
        { index: 1, text: "Purpose", level: 2 },
        { index: 5, text: "Step 1", level: 2 },
      ],
      samples: [{ headingId: "1", text: "purpose body" }],
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.suggestions.length, 2);
  assert.equal(body.suggestions[0]!.kind, "demote-to-bold");
  assert.equal(body.suggestions[0]!.targetIds[0], "1");
  assert.equal(body.suggestions[1]!.kind, "set-level");
  assert.ok(assistCalls.length >= 1, "the refinement judge caller was used");
  assert.ok(assistCalls[0]!.userContent.length <= HEADER_REVIEW_ASSIST_MAX_CHARS);
  // the outline is untouched — suggestions were NEVER auto-applied
  const view = await app.inject({ method: "GET", url: `/api/kb/task/${taskId}/header-review` });
  assert.equal(view.json().draft, null);
  assert.equal(view.json().cards.find((c: { index: number }) => c.index === 1)!.bold, false);
});

test("settings GET serves the project config; PUT is admin-gated", async () => {
  const res = await app.inject({ method: "GET", url: "/api/kb/header-review/settings" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.enabled, true);
  assert.ok(body.templateWords.includes("Purpose"));
  const token = await login("member@caleo.com");
  const forbidden = await app.inject({
    method: "PUT",
    url: "/api/kb/header-review/settings",
    headers: { authorization: `Bearer ${token}` },
    payload: { enabled: false },
  });
  assert.equal(forbidden.statusCode, 403);
  const adminToken = await login("admin@caleo.com");
  const ok = await app.inject({
    method: "PUT",
    url: "/api/kb/header-review/settings",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { enabled: false, minHeaders: 64, templateWords: ["Purpose", "Custom Field"] },
  });
  assert.equal(ok.statusCode, 200);
  const updated = ok.json();
  assert.equal(updated.enabled, false);
  assert.equal(updated.minHeaders, 64);
  assert.deepEqual(updated.templateWords, ["Purpose", "Custom Field"]);
  const served = await app.inject({ method: "GET", url: "/api/kb/header-review/settings" });
  assert.deepEqual(served.json().templateWords, ["Purpose", "Custom Field"]);
});

test("the file-backed settings store persists across instances", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hr-settings-"));
  try {
    const store = new FileHeaderReviewSettingsStore({ path: join(dir, "settings.json") });
    const first = await store.get();
    assert.equal(first.enabled, false, "default off");
    assert.ok(first.templateWords.length > 0, "default SAP template words");
    await store.update({ enabled: true, minHeaders: 24, templateWords: ["Purpose", "Prerequisites"] });
    const reopened = new FileHeaderReviewSettingsStore({ path: join(dir, "settings.json") });
    const persisted = await reopened.get();
    assert.equal(persisted.enabled, true);
    assert.equal(persisted.minHeaders, 24);
    assert.deepEqual(persisted.templateWords, ["Purpose", "Prerequisites"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});