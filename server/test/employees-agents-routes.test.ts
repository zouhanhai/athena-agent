import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import {
  MagicLinkAuthService,
  MemoryAuthTokenStore,
  type MagicLinkMailer,
} from "../src/employees/auth.js";
import { MemoryEmployeeRegistry } from "../src/employees/employees.js";
import { MemoryAgentRegistry } from "../src/agents/registry.js";

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
let adminId: string;
let memberId: string;
let ghostId: string;

const capabilities = {
  system: "hermes",
  mcp: ["sap"],
  tools: ["code"],
  skills: ["git_workflow"],
  specialty: "integration",
};

beforeEach(async () => {
  sent = [];
  const employees = new MemoryEmployeeRegistry([
    { email: "admin@caleo.com", display_name: "Admin", role: "admin" },
    { email: "member@caleo.com", display_name: "Member", role: "member" },
    { email: "ghost@caleo.com", display_name: "Ghost", role: "member" },
  ]);
  const admin = await employees.getByEmail("admin@caleo.com");
  const member = await employees.getByEmail("member@caleo.com");
  const ghost = await employees.getByEmail("ghost@caleo.com");
  assert.ok(admin && member && ghost, "seed employees should exist");
  adminId = admin.id;
  memberId = member.id;
  ghostId = ghost.id;

  const agents = new MemoryAgentRegistry([
    { alias: "Hermes", owner_employee_id: adminId, capabilities },
    { alias: "Poseidon", owner_employee_id: memberId, capabilities },
  ]);

  const mailer: MagicLinkMailer = {
    async sendLoginLink(input) {
      sent.push({ to: input.to, magicLinkUrl: input.magicLinkUrl });
    },
  };
  const auth = new MagicLinkAuthService({
    registry: employees,
    mailer,
    tokens: new MemoryAuthTokenStore(),
    appBaseUrl: "http://localhost:5173",
  });
  app = buildApp({ employees, auth, registry: agents });
});

after(async () => {
  if (app) {
    await app.close();
  }
});

async function login(email: string): Promise<string> {
  await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email },
  });
  const token = tokenFromUrl(sent[sent.length - 1].magicLinkUrl);
  const res = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { token } });
  assert.equal(res.statusCode, 200);
  return (res.json() as { session_token: string }).session_token;
}

test("GET /api/employees/:id/agents returns the agents owned by that employee", async () => {
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: `/api/employees/${adminId}/agents`,
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(res.statusCode, 200);
  const { agents } = res.json();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].alias, "Hermes");
  assert.equal(agents[0].owner_employee_id, adminId);
});

test("GET /api/employees/:id/agents returns only that employee's agents", async () => {
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: `/api/employees/${memberId}/agents`,
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(res.statusCode, 200);
  const { agents } = res.json();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].alias, "Poseidon");
});

test("GET /api/employees/:id/agents returns an empty list for an employee with no agents", async () => {
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: `/api/employees/${ghostId}/agents`,
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((res.json() as { agents: unknown[] }).agents, []);
});

test("GET /api/employees/:id/agents returns 404 for an unknown employee id", async () => {
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: `/api/employees/ghost-employee/agents`,
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(res.statusCode, 404);
});

test("GET /api/employees/:id/agents requires authentication (401)", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/employees/${adminId}/agents`,
  });
  assert.equal(res.statusCode, 401);
});

test("GET /api/employees/:id/agents is allowed for members (RBAC: agent.list)", async () => {
  const sessionToken = await login("member@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: `/api/employees/${adminId}/agents`,
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(res.statusCode, 200);
});
