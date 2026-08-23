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
import {
  KbCommunityRecomputeAlreadyRunningError,
  type KbCommunityMaintenanceService,
  type KbCommunityQuality,
  type KbCommunityRecomputeReport,
} from "../../src/kb/community-maintenance.js";
import {
  MemoryKbAuditRunsStore,
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
let recomputeCalls: number;

function makeReport(): KbCommunityRecomputeReport {
  return {
    communities: 3,
    entitiesPerCommunity: [
      { id: "c_caleo", size: 4 },
      { id: "c_bcs", size: 2 },
      { id: "c_misc", size: 1 },
    ],
    largestCommunity: { id: "c_caleo", size: 4 },
    changedSinceLast: 5,
    entitiesWithoutCommunity: 1,
    summariesPresent: 2,
    summariesTotal: 3,
    strategy: "full",
    summariesRefreshed: 1,
    summariesUnchanged: 2,
    errors: [],
  };
}

function makeQuality(): KbCommunityQuality {
  return {
    communities: 3,
    entitiesPerCommunity: [
      { id: "c_caleo", size: 4 },
      { id: "c_bcs", size: 2 },
      { id: "c_misc", size: 1 },
    ],
    largestCommunity: { id: "c_caleo", size: 4 },
    entitiesWithoutCommunity: 1,
    summariesPresent: 2,
    summariesTotal: 3,
  };
}

function stubMaintenance(
  overrides: Partial<Pick<KbCommunityMaintenanceService, "recompute" | "quality">> = {},
): KbCommunityMaintenanceService {
  return {
    recompute: async () => {
      recomputeCalls += 1;
      return makeReport();
    },
    quality: async () => makeQuality(),
    ...overrides,
  } as unknown as KbCommunityMaintenanceService;
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
  recomputeCalls = 0;
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
    auditRunsStore: runsStore,
    communityMaintenance: stubMaintenance(),
  });
});

after(async () => {
  if (app) {
    await app.close();
  }
});

test("POST /api/kb/admin/communities/recompute requires a session (401 without one)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/kb/admin/communities/recompute",
  });
  assert.equal(res.statusCode, 401);
  assert.equal(recomputeCalls, 0);
});

test("POST /api/kb/admin/communities/recompute is admin-gated (member → 403)", async () => {
  const memberToken = await login("member@caleo.com");
  const res = await app.inject({
    method: "POST",
    url: "/api/kb/admin/communities/recompute",
    headers: { authorization: `Bearer ${memberToken}` },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(recomputeCalls, 0);
});

test("an admin recomputes communities and gets the full report JSON", async () => {
  const adminToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "POST",
    url: "/api/kb/admin/communities/recompute",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { report: Record<string, unknown> };
  assert.equal(body.report.communities, 3);
  assert.ok(Array.isArray(body.report.entitiesPerCommunity));
  assert.deepEqual(body.report.largestCommunity, { id: "c_caleo", size: 4 });
  assert.equal(body.report.changedSinceLast, 5);
  assert.equal(recomputeCalls, 1);
});

test("the manual recompute lands in the shared audit-report history with trigger=manual", async () => {
  const adminToken = await login("admin@caleo.com");
  await app.inject({
    method: "POST",
    url: "/api/kb/admin/communities/recompute",
    headers: { authorization: `Bearer ${adminToken}` },
  });

  const stored = await runsStore.list();
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.trigger, "manual");
  assert.ok(stored[0]!.communities, "recompute row carries the communities block");
  assert.equal(stored[0]!.communities!.communities, 3);

  // The SAME history endpoint serves both manual recomputes and weekly audits.
  const listRes = await app.inject({
    method: "GET",
    url: "/api/kb/audit/reports",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(listRes.statusCode, 200);
  const listed = listRes.json() as { reports: Array<{ trigger: string }> };
  assert.deepEqual(listed.reports.map((r) => r.trigger), ["manual"]);
});

test("a concurrent recompute is rejected with 409 and persists nothing", async () => {
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
    auditRunsStore: runsStore,
    communityMaintenance: stubMaintenance({
      recompute: async () => {
        throw new KbCommunityRecomputeAlreadyRunningError();
      },
    }),
  });
  try {
    const adminToken = await login("admin@caleo.com", busyApp);
    const res = await busyApp.inject({
      method: "POST",
      url: "/api/kb/admin/communities/recompute",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.statusCode, 409);
    assert.equal((await runsStore.list()).length, 0);
  } finally {
    await busyApp.close();
  }
});

test("a failing recompute surfaces a 500 without persisting a report row", async () => {
  const failingApp = buildApp({
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
    auditRunsStore: runsStore,
    communityMaintenance: stubMaintenance({
      recompute: async () => {
        throw new Error("graph unavailable");
      },
    }),
  });
  try {
    const adminToken = await login("admin@caleo.com", failingApp);
    const res = await failingApp.inject({
      method: "POST",
      url: "/api/kb/admin/communities/recompute",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.statusCode, 500);
    assert.match(String((res.json() as { error: string }).error), /graph unavailable/);
    assert.equal((await runsStore.list()).length, 0);
  } finally {
    await failingApp.close();
  }
});
