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
import type { KnowledgeRetrievalService } from "../../src/kb/retrieval.js";

const TEST_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

let app: FastifyInstance;
let sent: SentMail[];

interface SentMail {
  to: string;
  magicLinkUrl: string;
}

function stubRetrieval(): KnowledgeRetrievalService {
  return {
    getWikiTree: async () => [],
    listEntities: async ({ type, q }) => {
      const all = [
        { name: "FICOMPUTE", type: "abap_unit", description: "ABAP function module" },
        { name: "ZCL_FI_DELIVERY", type: "abap_unit", description: "ABAP class" },
        { name: "I_CNSLDTN", type: "cds_view", description: "CDS view" },
        { name: "MARA", type: "table", description: "SAP table" },
      ];
      return all.filter(
        (e) =>
          (type ? e.type === type : true) &&
          (q ? e.name.toUpperCase().includes(q.toUpperCase()) : true),
      );
    },
    getEntity: async (name) => {
      if (name !== "FICOMPUTE") return null;
      return {
        name: "FICOMPUTE",
        type: "abap_unit",
        description: "ABAP function module",
        outgoing: [{ keywords: ["READS_FROM"], entity: "MARA", type: "table", wikiPaths: [] }],
        incoming: [
          {
            keywords: ["CALLS"],
            entity: "ZCL_FI_DELIVERY",
            type: "abap_unit",
            wikiPaths: ["wiki/code/dev/zcl_fi_delivery.md"],
          },
          { keywords: ["CALLS"], entity: "ZCL_MM_GOODS", type: "abap_unit", wikiPaths: [] },
        ],
      };
    },
  } as unknown as KnowledgeRetrievalService;
}

function tokenFromUrl(url: string): string {
  const match = /[?&]token=([^&]+)/.exec(url);
  assert.ok(match, `magic link should carry a token: ${url}`);
  return decodeURIComponent(match[1]!);
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
    [{ email: "member@caleo.com", display_name: "Member", role: "member" }],
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
  app = buildApp({ employees: registry, auth, retrieval: stubRetrieval(), ingest: {} as never });
});

after(async () => {
  if (app) await app.close();
});

test("G4.S8.T12: GET /api/kb/graph/entities requires an authenticated employee", async () => {
  const res = await app.inject({ method: "GET", url: "/api/kb/graph/entities" });
  assert.equal(res.statusCode, 401, "unauthenticated request is rejected");
});

test("G4.S8.T12: GET /api/kb/graph/entities lists entities with type+filters", async () => {
  const sessionToken = await login("member@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/kb/graph/entities?type=abap_unit&q=zcl_",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(res.statusCode, 200);
  const { entities } = res.json();
  assert.deepEqual(
    entities.map((e: { name: string }) => e.name),
    ["ZCL_FI_DELIVERY"],
    "filtered by type + case-insensitive substring",
  );
});

test("G4.S8.T12: GET /api/kb/graph/entities/:name returns uses + used-by with wiki links", async () => {
  const sessionToken = await login("member@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/kb/graph/entities/FICOMPUTE",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.name, "FICOMPUTE");
  assert.equal(body.outgoing.length, 1);
  assert.equal(body.incoming.length, 2, "both callers under Used by");
  assert.deepEqual(
    body.incoming.find((r: { entity: string }) => r.entity === "ZCL_FI_DELIVERY").wikiPaths,
    ["wiki/code/dev/zcl_fi_delivery.md"],
    "wiki deep-link resolved",
  );
});

test("G4.S8.T12: GET /api/kb/graph/entities/:name returns 404 for an unknown entity", async () => {
  const sessionToken = await login("member@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/kb/graph/entities/MISSING",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(res.statusCode, 404);
});
