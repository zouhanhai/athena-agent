import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import {
  MemoryAgentRegistry,
  type AgentCapabilities,
} from "../src/agents/registry.js";
import {
  MagicLinkAuthService,
  MemoryAuthTokenStore,
  type MagicLinkMailer,
} from "../src/employees/auth.js";
import { MemoryEmployeeRegistry, type EmployeeRecord } from "../src/employees/employees.js";

interface SentMail {
  to: string;
  magicLinkUrl: string;
}

function tokenFromUrl(url: string): string {
  const match = /[?&]token=([^&]+)/.exec(url);
  assert.ok(match, `magic link should carry a token: ${url}`);
  return decodeURIComponent(match[1]);
}

const caps: AgentCapabilities = {
  system: "hermes",
  mcp: ["sap", "github"],
  tools: ["code", "search"],
  skills: ["git_workflow", "code_review"],
  specialty: "integration",
  description: "Integration agent",
  tags: ["sap", "reporting"],
  examples: ["How is Q2 reporting structured?"],
};

let app: FastifyInstance;
let registry: MemoryAgentRegistry;
let sent: SentMail[];

beforeEach(async () => {
  sent = [];
  registry = new MemoryAgentRegistry();
  const employees = new MemoryEmployeeRegistry([
    { email: "admin@caleo.com", display_name: "Admin", role: "admin" },
    { email: "member@caleo.com", display_name: "Member", role: "member" },
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
  app = buildApp({ employees, auth, registry });
});

after(async () => {
  if (app) {
    await app.close();
  }
});

async function login(email: string): Promise<{ token: string; employee: EmployeeRecord }> {
  await app.inject({ method: "POST", url: "/api/auth/login", payload: { email } });
  const token = tokenFromUrl(sent[sent.length - 1].magicLinkUrl);
  const res = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { token } });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { session_token: string; employee: EmployeeRecord };
  return { token: body.session_token, employee: body.employee };
}

async function registerAgent(alias: string, owner: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: { alias, owner_employee_id: owner, capabilities: caps },
  });
  assert.equal(res.statusCode, 201);
  return res.json().agent_id;
}

test("GET /api/agents/:alias detail carries declared capabilities + no pending-review flag for a fresh register", async () => {
  await registerAgent("Hermes", "zhang.wei");
  const res = await app.inject({ method: "GET", url: "/api/agents/Hermes" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.capabilities, caps);
  assert.equal(body.capabilities_pending_review, false);
});

test("PUT capabilities sets the agent back to pending review", async () => {
  await registerAgent("Hermes", "zhang.wei");
  const res = await app.inject({
    method: "PUT",
    url: "/api/agents/Hermes",
    payload: {
      capabilities: { ...caps, specialty: "deployment-expert" },
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.capabilities_pending_review, true);
  assert.equal(body.capabilities.specialty, "deployment-expert");
});

test("editing only alias or logo does NOT put an agent back into pending review", async () => {
  await registerAgent("Hermes", "zhang.wei");
  const res = await app.inject({
    method: "PUT",
    url: "/api/agents/Hermes",
    payload: { alias: "Hermes-2", logo_url: "/hermes-v2.png" },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.alias, "Hermes-2");
  assert.equal(body.logo_url, "/hermes-v2.png");
  assert.equal(body.capabilities_pending_review, false);
});

test("POST /api/agents/:agentId/confirm approves the agent (owner)", async () => {
  const { token, employee } = await login("admin@caleo.com");
  const agentId = await registerAgent("Hermes", employee.id);
  await app.inject({
    method: "PUT",
    url: "/api/agents/Hermes",
    payload: { capabilities: { ...caps, tools: ["code", "deploy"] } },
  });

  const res = await app.inject({
    method: "POST",
    url: `/api/agents/${agentId}/confirm`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.agent_id, agentId);
  assert.equal(body.capabilities_pending_review, false);
});

test("confirm requires authentication (401)", async () => {
  const agentId = await registerAgent("Hermes", "zhang.wei");
  const res = await app.inject({ method: "POST", url: `/api/agents/${agentId}/confirm` });
  assert.equal(res.statusCode, 401);
});

test("a non-owner member cannot confirm an agent (403)", async () => {
  const { token } = await login("member@caleo.com");
  const agentId = await registerAgent("Hermes", "someone-else");
  const res = await app.inject({
    method: "POST",
    url: `/api/agents/${agentId}/confirm`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 403);
});

test("confirm of an unknown agent returns 404", async () => {
  const { token } = await login("admin@caleo.com");
  const res = await app.inject({
    method: "POST",
    url: "/api/agents/agent-ghost/confirm",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 404);
});

test("PUT /api/agents/:alias renames the agent and the old alias stops resolving", async () => {
  await registerAgent("Hermes", "zhang.wei");
  const res = await app.inject({
    method: "PUT",
    url: "/api/agents/Hermes",
    payload: { alias: "HermesRemote" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().alias, "HermesRemote");

  const oldAlias = await app.inject({ method: "GET", url: "/api/agents/Hermes" });
  assert.equal(oldAlias.statusCode, 404);
  const newAlias = await app.inject({ method: "GET", url: "/api/agents/HermesRemote" });
  assert.equal(newAlias.statusCode, 200);
  assert.equal(newAlias.json().alias, "HermesRemote");
});

test("PUT /api/agents/:alias rename into an existing alias conflicts (409)", async () => {
  await registerAgent("Hermes", "zhang.wei");
  await registerAgent("Poseidon", "zhang.wei");
  const res = await app.inject({
    method: "PUT",
    url: "/api/agents/Hermes",
    payload: { alias: "Poseidon" },
  });
  assert.equal(res.statusCode, 409);
});

test("PUT /api/agents/:alias updates the logo", async () => {
  await registerAgent("Hermes", "zhang.wei");
  const res = await app.inject({
    method: "PUT",
    url: "/api/agents/Hermes",
    payload: { logo_url: "/logos/fox-clean.png" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().logo_url, "/logos/fox-clean.png");
});

test("registering a pending declaration approves its capabilities (not pending review)", async () => {
  const declRes = await app.inject({
    method: "POST",
    url: "/api/agents/self-declare",
    payload: { agent_id: "opencode-self_declared", capabilities: caps },
  });
  assert.equal(declRes.statusCode, 201);
  const declarationId = declRes.json().declaration.id;
  const res = await app.inject({
    method: "POST",
    url: `/api/agents/register-declaration/${declarationId}`,
    payload: { alias: "SelfDeclared", owner_employee_id: "zhang.wei" },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().capabilities_pending_review, false);
});