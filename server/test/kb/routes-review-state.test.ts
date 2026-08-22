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
import type { KnowledgeRetrievalService } from "../../src/kb/retrieval.js";
import { WikiReviewStateService, type WikiReviewStateView } from "../../src/kb/review-state.js";
import { WikiFrontmatterSyncer } from "../../src/kb/wiki-frontmatter.js";

const TEST_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

const PAGE_PATH = "wiki/t/lusen.md";
const PAGE = [
  "---",
  "type: document",
  "title: Lüsen",
  "review: required",
  "review_count: 2",
  "---",
  "",
  "Der   Zustieg am ?????   ist unklar.",
  "",
  "Zweite Ankerstelle hier.",
].join("\n");

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
let files: Map<string, string>;
let syncCalls: Array<{ path: string; patch: Record<string, unknown> }>;

function makeReviewState(): WikiReviewStateService {
  files = new Map<string, string>([
    ["/data/wiki/t/lusen.md", PAGE],
    [
      "/data/refinement/lusen/quality.json",
      JSON.stringify({
        action: "review_required",
        issues: [
          { id: "qi-1", message: "Placeholder left", anchor: { quote: "Der Zustieg am ????? ist unklar." }, resolved: false },
          { id: "qi-2", message: "Caption missing", anchor: { quote: "Zweite Ankerstelle hier." }, resolved: false },
        ],
      }),
    ],
  ]);
  syncCalls = [];
  const syncer = new WikiFrontmatterSyncer({
    wikiDir: "/data/wiki",
    readFile: async (p) => files.get(p) ?? "",
    writeFile: async (p, c) => void files.set(p, c),
  });
  const originalUpdate = syncer.update.bind(syncer);
  syncer.update = async (path, patch) => {
    syncCalls.push({ path, patch: patch as unknown as Record<string, unknown> });
    return originalUpdate(path, patch);
  };
  return new WikiReviewStateService({
    readPage: async () => files.get("/data/wiki/t/lusen.md")!,
    refinementRoots: ["/data/refinement"],
    readFile: async (p) => {
      const hit = files.get(p);
      if (hit === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return hit;
    },
    writeFile: async (p, c) => void files.set(p, c),
    syncer,
  });
}

async function login(email: string): Promise<string> {
  await app.inject({ method: "POST", url: "/api/auth/login", payload: { email } });
  const token = tokenFromUrl(sent[sent.length - 1]!.magicLinkUrl);
  const res = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { token } });
  assert.equal(res.statusCode, 200);
  return (res.json() as { session_token: string }).session_token;
}

beforeEach(async () => {
  sent = [];
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
    ingest: {} as KnowledgeIngestService,
    retrieval: {
      getWikiTree: async () => [],
      readWikiPageRaw: async () => files.get("/data/wiki/t/lusen.md") ?? PAGE,
    } as unknown as KnowledgeRetrievalService,
    reviewState: makeReviewState(),
  });
});

after(async () => {
  if (app) {
    await app.close();
  }
});

test("GET review-state requires an employee session (401 anonymous)", async () => {
  const res = await app.inject({ method: "GET", url: `/api/kb/wiki/review-state?path=${encodeURIComponent(PAGE_PATH)}` });
  assert.equal(res.statusCode, 401);
});

test("GET review-state returns the gate state with anchors validated against the current content", async () => {
  const sessionToken = await login("member@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: `/api/kb/wiki/review-state?path=${encodeURIComponent(PAGE_PATH)}`,
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as WikiReviewStateView;
  assert.equal(body.review, "required");
  assert.equal(body.review_count, 2);
  assert.deepEqual(body.issues.map((i) => i.anchored), [true, true]);
});

test("POST review-state requires an employee session (401 anonymous)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/kb/wiki/review-state",
    payload: { path: PAGE_PATH, issueId: "qi-1", action: "resolve" },
  });
  assert.equal(res.statusCode, 401);
});

test("POST resolve flips the issue, decrements the count, and writes the frontmatter through the syncer", async () => {
  const sessionToken = await login("member@caleo.com");
  const res = await app.inject({
    method: "POST",
    url: "/api/kb/wiki/review-state",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { path: PAGE_PATH, issueId: "qi-1", action: "resolve" },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as WikiReviewStateView;
  assert.equal(body.review_count, 1);
  assert.equal(body.review, "required");

  // quality.json persisted
  const persisted = JSON.parse(files.get("/data/refinement/lusen/quality.json")!) as {
    issues: Array<{ id: string; resolved: boolean }>;
  };
  assert.equal(persisted.issues.find((i) => i.id === "qi-1")!.resolved, true);
  // frontmatter written through the canonical syncer
  assert.deepEqual(syncCalls.at(-1)?.patch, { review: "required", review_count: 1 });
  assert.match(files.get("/data/wiki/t/lusen.md")!, /review_count: 1/);

  // resolving the second issue clears the banner state
  const res2 = await app.inject({
    method: "POST",
    url: "/api/kb/wiki/review-state",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { path: PAGE_PATH, issueId: "qi-2", action: "resolve" },
  });
  assert.equal(res2.statusCode, 200);
  const cleared = res2.json() as WikiReviewStateView;
  assert.equal(cleared.review, "clear");
  assert.equal(cleared.review_count, 0);
  assert.match(files.get("/data/wiki/t/lusen.md")!, /review: clear/);
});

test("POST reopen keeps the issue open and attaches the operator note", async () => {
  files.set(
    "/data/refinement/lusen/quality.json",
    JSON.stringify({
      action: "auto_accept",
      issues: [{ id: "qi-1", message: "a", anchor: { quote: "Der Zustieg am ????? ist unklar." }, resolved: true }],
    }),
  );
  files.set("/data/wiki/t/lusen.md", PAGE.replace("review_count: 2", "review_count: 0").replace("review: required", "review: clear"));
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "POST",
    url: "/api/kb/wiki/review-state",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { path: PAGE_PATH, issueId: "qi-1", action: "reopen", note: "still wrong after my edit" },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as WikiReviewStateView;
  assert.equal(body.review, "required");
  assert.equal(body.review_count, 1);
  assert.equal(body.issues[0]!.note, "still wrong after my edit");
});

test("POST validates the body (path/issueId/action)", async () => {
  const sessionToken = await login("admin@caleo.com");
  const authHeader = { authorization: `Bearer ${sessionToken}` };
  const bad = await app.inject({
    method: "POST",
    url: "/api/kb/wiki/review-state",
    headers: authHeader,
    payload: { path: "../etc/passwd", issueId: "qi-1", action: "resolve" },
  });
  assert.equal(bad.statusCode, 400);
  const noAction = await app.inject({
    method: "POST",
    url: "/api/kb/wiki/review-state",
    headers: authHeader,
    payload: { path: PAGE_PATH, issueId: "qi-1", action: "maybe" },
  });
  assert.equal(noAction.statusCode, 400);
  const noIssue = await app.inject({
    method: "POST",
    url: "/api/kb/wiki/review-state",
    headers: authHeader,
    payload: { path: PAGE_PATH, action: "resolve" },
  });
  assert.equal(noIssue.statusCode, 400);
});

test("POST on an unknown issue id is a 404, not a crash", async () => {
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "POST",
    url: "/api/kb/wiki/review-state",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { path: PAGE_PATH, issueId: "nope", action: "resolve" },
  });
  assert.equal(res.statusCode, 404);
});
