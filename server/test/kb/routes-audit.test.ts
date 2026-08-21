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
import { KbAuditAlreadyRunningError, KbAuditService } from "../../src/kb/audit.js";
import {
  MemoryKbAuditRunsStore,
  type KbAuditRunRecord,
} from "../../src/kb/audit-runs.js";

const TEST_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

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
let runsStore: MemoryKbAuditRunsStore;
let auditCalls: string[];

function makeRecord(trigger: "scheduled" | "manual"): KbAuditRunRecord {
  return {
    id: `run-${Math.random().toString(36).slice(2)}`,
    trigger,
    startedAt: new Date().toISOString(),
    durationMs: 3,
    review: { runAt: "2026-08-21", scanned: 2, changed: 1, archive: [], results: [] },
    fileCheck: { repaired: 0, details: [] },
    orphans: { scannedDirs: 1, removed: [], kept: ["x"] },
  };
}

function stubAudit(): KbAuditService {
  return {
    run: async (trigger) => {
      auditCalls.push(trigger);
      const record = makeRecord(trigger);
      await runsStore.insert(record);
      return record;
    },
  } as unknown as KbAuditService;
}

async function login(email: string, target?: FastifyInstance): Promise<string> {
  const client = target ?? app;
  await client.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email },
  });
  const token = tokenFromUrl(sent[sent.length - 1]!.magicLinkUrl);
  const res = await client.inject({ method: "POST", url: "/api/auth/verify", payload: { token } });
  assert.equal(res.statusCode, 200);
  return (res.json() as { session_token: string }).session_token;
}

beforeEach(() => {
  auditCalls = [];
  sent = [];
  registry = new MemoryEmployeeRegistry(
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
  runsStore = new MemoryKbAuditRunsStore();
  app = buildApp({
    employees: registry,
    auth: new MagicLinkAuthService({
      registry,
      mailer,
      tokens: new MemoryAuthTokenStore(),
      appBaseUrl: "http://localhost:5173",
    }),
    audit: stubAudit(),
    auditRunsStore: runsStore,
  });
});

after(async () => {
  if (app) {
    await app.close();
  }
});

test("POST /api/kb/audit requires a session (401 without one)", async () => {
  const res = await app.inject({ method: "POST", url: "/api/kb/audit" });
  assert.equal(res.statusCode, 401);
  assert.equal(auditCalls.length, 0);
});

test("POST /api/kb/audit is admin-gated (member → 403)", async () => {
  const memberToken = await login("member@caleo.com");
  const res = await app.inject({
    method: "POST",
    url: "/api/kb/audit",
    headers: { authorization: `Bearer ${memberToken}` },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(auditCalls.length, 0);
});

test("an admin triggers the audit manually and gets the full report JSON", async () => {
  const adminToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "POST",
    url: "/api/kb/audit",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { report: Record<string, unknown> };
  assert.equal(body.report.trigger, "manual");
  assert.ok(typeof body.report.startedAt === "string");
  assert.ok("review" in body.report && "fileCheck" in body.report && "orphans" in body.report);
  // EVERY run persists an identical report row — manual included.
  const stored = await runsStore.list();
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.trigger, "manual");
});

test("a concurrent audit invocation is rejected with 409", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  let firstStarted = false;
  const busyAudit = {
    run: async (trigger: "scheduled" | "manual") => {
      if (!firstStarted) {
        firstStarted = true;
        await gate;
        const record = makeRecord(trigger);
        await runsStore.insert(record);
        return record;
      }
      throw new KbAuditAlreadyRunningError();
    },
  } as unknown as KbAuditService;

  const busyApp = buildApp({
    employees: registry,
    auth: new MagicLinkAuthService({
      registry,
      mailer: {
        async sendLoginLink(input) {
          sent.push({ to: input.to, magicLinkUrl: input.magicLinkUrl });
        },
      },
      tokens: new MemoryAuthTokenStore(),
      appBaseUrl: "http://localhost:5173",
    }),
    audit: busyAudit,
    auditRunsStore: runsStore,
  });
  try {
    const adminToken = await login("admin@caleo.com", busyApp);
    const headers = { authorization: `Bearer ${adminToken}` };
    const first = busyApp.inject({ method: "POST", url: "/api/kb/audit", headers });
    // light-my-request quirk: two same-tick injects while #1 is in flight can
    // deadlock the fake socket; a real server has no such coupling.
    await new Promise((r) => setTimeout(r, 25));
    const second = await busyApp.inject({ method: "POST", url: "/api/kb/audit", headers });
    assert.equal(second.statusCode, 409);
    release();
    const firstRes = await first;
    assert.equal(firstRes.statusCode, 200);
  } finally {
    await busyApp.close();
  }
});

test("GET /api/kb/audit/reports returns persisted scheduled AND manual runs (admin only)", async () => {
  await runsStore.insert(makeRecord("scheduled"));
  await runsStore.insert(makeRecord("manual"));

  const memberToken = await login("member@caleo.com");
  const denied = await app.inject({
    method: "GET",
    url: "/api/kb/audit/reports",
    headers: { authorization: `Bearer ${memberToken}` },
  });
  assert.equal(denied.statusCode, 403);

  const unauthed = await app.inject({ method: "GET", url: "/api/kb/audit/reports" });
  assert.equal(unauthed.statusCode, 401);

  const adminToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/kb/audit/reports",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { reports: Array<{ trigger: string }> };
  assert.equal(body.reports.length, 2);
  assert.deepEqual(
    body.reports.map((r) => r.trigger).sort(),
    ["manual", "scheduled"],
  );
});
