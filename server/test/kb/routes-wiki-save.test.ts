import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../src/app.js";
import type { FastifyInstance } from "fastify";
import {
  MagicLinkAuthService,
  MemoryAuthTokenStore,
  type MagicLinkMailer,
} from "../../src/employees/auth.js";
import { MemoryEmployeeRegistry } from "../../src/employees/employees.js";
import { createSecretCipher } from "../../src/employees/crypto.js";
import type { KnowledgeIngestService } from "../../src/kb/ingest.js";
import { IngestTaskQueue } from "../../src/kb/tasks.js";
import type { KnowledgeRetrievalService } from "../../src/kb/retrieval.js";

const TEST_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

const BEFORE = `---\ntype: concept\ntitle: Runbook\ntopic: ops\n---\n\n# Runbook\n\n![Diagram](images/runbook.pdf/diagram_001.png)\n\nThe image shows a bright sky.\n\nSteps here.`;
const AFTER = `---\ntype: concept\ntitle: Runbook\ntopic: ops\n---\n\n# Runbook\n\n![Diagram](images/runbook.pdf/diagram_001.png)\n\nThe image shows a dark sky.\n\nSteps here.`;

interface SentMail {
  to: string;
  magicLinkUrl: string;
}

function tokenFromUrl(url: string): string {
  const match = /[?&]token=([^&]+)/.exec(url);
  assert.ok(match, `magic link should carry a token: ${url}`);
  return decodeURIComponent(match[1]);
}

let app: FastifyInstance;
let sent: SentMail[];
let registry: MemoryEmployeeRegistry;
let savedCalls: { path: string; content: string }[];
let queue: IngestTaskQueue;

function stubRetrieval(): KnowledgeRetrievalService {
  return {
    getWikiTree: async () => [],
    readWikiPage: async (path: string) => ({ path, content: BEFORE }),
  } as unknown as KnowledgeRetrievalService;
}

function stubIngest(): KnowledgeIngestService {
  return {
    saveWikiPage: async (path: string, content: string) => {
      savedCalls.push({ path, content });
      return {
        before: BEFORE,
        after: content,
        ragBefore: "# Runbook\n\nThe image shows a bright sky.\n\nSteps here.",
        ragAfter: "# Runbook\n\nThe image shows a dark sky.\n\nSteps here.",
        type: "concept",
        topic: "ops",
      };
    },
  } as unknown as KnowledgeIngestService;
}

function makeTaskQueue(): IngestTaskQueue {
  return new IngestTaskQueue({
    parser: {
      async parse() {
        throw new Error("wiki save must not parse");
      },
    } as never,
    ingest: {} as never,
    wikiRefiner: async (input) => ({
      ref: {
        md_ref: "/storage/runbook/markdown.md",
        chunks_ref: "/storage/runbook/chunks.json",
        preview: "preview",
        char_count: 1,
        line_count: 1,
        header_count: 1,
        chunk_count: 1,
        frontmatter: { type: "concept", topic: "ops" },
        entities: [],
        relations: [],
        keywords: ["runbook"],
        quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
        summary: "Corrected runbook.",
        sections: [],
        mode: "single",
        section_paths: [],
      },
      markdown: input.markdown,
      newEntities: [],
      newRelations: [],
      rechunked: false,
    }),
  });
}

async function login(email: string): Promise<string> {
  await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email },
  });
  const token = tokenFromUrl(sent[sent.length - 1]!.magicLinkUrl);
  const res = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { token } });
  assert.equal(res.statusCode, 200);
  return (res.json() as { session_token: string }).session_token;
}

async function untilDone(taskId: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const task = queue.getTask(taskId)!;
    if (task.status === "done" || task.status === "failed") return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("task did not finish in time");
}

beforeEach(async () => {
  savedCalls = [];
  sent = [];
  registry = new MemoryEmployeeRegistry(
    [
      { email: "admin@caleo.com", display_name: "Admin", role: "admin" },
      { email: "member@caleo.com", display_name: "Member", role: "member" },
      { email: "editor@caleo.com", display_name: "Editor", role: "member", permissions: ["kb.edit"] },
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
  queue = makeTaskQueue();
  app = buildApp({
    employees: registry,
    auth,
    ingest: stubIngest(),
    retrieval: stubRetrieval(),
    taskQueue: queue,
  });
});

after(async () => {
  if (app) {
    await app.close();
  }
});

test("an admin can save a corrected wiki page: persists + submits the diff-refine task (G4.S3.T10)", async () => {
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "PUT",
    url: "/api/kb/wiki/page",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { path: "wiki/ops/runbook.md", content: AFTER },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.saved, true);
  assert.equal(body.diff.changed, true, "a correction produces a diff");
  assert.equal(body.diff.structural, false, "a localized edit is not structural");
  assert.equal(savedCalls.length, 1);
  assert.equal(savedCalls[0]!.path, "wiki/ops/runbook.md");
  assert.equal(savedCalls[0]!.content, AFTER);

  // The background task completes (diff-refine → RAG overwrite, no parsing).
  await untilDone(body.taskId);
  const task = queue.getTask(body.taskId)!;
  assert.equal(task.status, "done");
  assert.equal(task.stages.parsing.status, "done");
  assert.equal(task.stages.ingesting_llmwiki.status, "done");
  assert.equal(task.stages.refinement.status, "done");
  assert.equal(task.stages.ingesting_neo4j.status, "done");
});

test("a member granted kb.edit can save; a plain member is denied (403)", async () => {
  const editorSession = await login("editor@caleo.com");
  const ok = await app.inject({
    method: "PUT",
    url: "/api/kb/wiki/page",
    headers: { authorization: `Bearer ${editorSession}` },
    payload: { path: "wiki/ops/runbook.md", content: AFTER },
  });
  assert.equal(ok.statusCode, 200, "a member granted kb.edit may save");

  const memberSession = await login("member@caleo.com");
  const denied = await app.inject({
    method: "PUT",
    url: "/api/kb/wiki/page",
    headers: { authorization: `Bearer ${memberSession}` },
    payload: { path: "wiki/ops/runbook.md", content: AFTER },
  });
  assert.equal(denied.statusCode, 403);
  assert.match(denied.json().error, /kb.edit/);
});

test("saving without a session token returns 401", async () => {
  const res = await app.inject({
    method: "PUT",
    url: "/api/kb/wiki/page",
    payload: { path: "wiki/ops/runbook.md", content: AFTER },
  });
  assert.equal(res.statusCode, 401);
});

test("the save endpoint validates the wiki path and content", async () => {
  const sessionToken = await login("admin@caleo.com");
  const badPath = await app.inject({
    method: "PUT",
    url: "/api/kb/wiki/page",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { path: "ops/runbook.md", content: AFTER },
  });
  assert.equal(badPath.statusCode, 400, "path must be wiki/**/*.md");

  const missingContent = await app.inject({
    method: "PUT",
    url: "/api/kb/wiki/page",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { path: "wiki/ops/runbook.md", content: "" },
  });
  assert.equal(missingContent.statusCode, 400);
});

test("the saved task surfaces the diff-refine's NEW entities/relations for the operator (G4.S3.T10)", async () => {
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "PUT",
    url: "/api/kb/wiki/page",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { path: "wiki/ops/runbook.md", content: AFTER },
  });
  await untilDone(res.json().taskId);
  const task = queue.getTask(res.json().taskId)!;
  assert.equal(task.reviewRequired, undefined, "auto_accept refine is not flagged");
  assert.ok(task.wikiEdit, "the diff-refine outcome is surfaced");
  assert.equal(task.wikiEdit!.rechunked, false);
});
