import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import {
  AgentAuthError,
  MemoryAgentRegistry,
  type AgentCapabilities,
  type AgentInvite,
} from "../src/agents/registry.js";
import {
  MagicLinkAuthService,
  MemoryAuthTokenStore,
  type MagicLinkMailer,
} from "../src/employees/auth.js";
import { MemoryEmployeeRegistry } from "../src/employees/employees.js";

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
  mcp: ["sap"],
  tools: ["code"],
  skills: ["git_workflow"],
  specialty: "integration",
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

async function adminInvite(overrides: Record<string, unknown> = {}): Promise<{ statusCode: number; invite: AgentInvite }> {
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "POST",
    url: "/api/agents/invite",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: {
      alias: "Hermes",
      owner_employee_id: "zhang.wei",
      api_url: "http://hermes.local:3001",
      capabilities: caps,
      ...overrides,
    },
  });
  return { statusCode: res.statusCode, invite: res.json().invite };
}

test("createInvitation issues {agent_id, api_url, token} with an invited agent", async () => {
  const result = await registry.createInvitation({
    alias: "Hermes",
    owner_employee_id: "zhang.wei",
    api_url: "http://hermes.local:3001",
    capabilities: caps,
  });
  assert.equal(result.agent.alias, "Hermes");
  assert.equal(result.agent.api_url, "http://hermes.local:3001");
  assert.equal(result.agent.status, "invited");
  assert.equal(result.agent.has_token, true);
  assert.ok(result.invite.agent_id, "invite carries an agent_id");
  assert.equal(result.agent.agent_id, result.invite.agent_id);
  assert.ok(result.invite.token.length >= 32, "invite carries a fresh auth token");

  const listed = await registry.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, "invited");
});

test("registerWithInvite records reachability + status when the agent registers auth'd", async () => {
  const { invite } = await registry.createInvitation({
    alias: "Hermes",
    owner_employee_id: "zhang.wei",
    api_url: "http://hermes.local:3001",
    capabilities: caps,
  });
  const record = await registry.registerWithInvite({
    agent_id: invite.agent_id,
    token: invite.token,
    api_url: "http://hermes.local:3002",
  });
  assert.equal(record.status, "reachable");
  assert.equal(record.api_url, "http://hermes.local:3002", "agent-confirmed reachability wins");
  assert.equal(record.has_token, true);
  const listed = await registry.list();
  assert.equal(listed[0].status, "reachable");
});

test("registerWithInvite rejects a wrong token with the same agent_id", async () => {
  const { invite } = await registry.createInvitation({
    alias: "Hermes",
    owner_employee_id: "zhang.wei",
  });
  await assert.rejects(
    registry.registerWithInvite({
      agent_id: invite.agent_id,
      token: "not-the-token",
      api_url: "http://hermes.local:3001",
    }),
    AgentAuthError,
  );
});

test("registerWithInvite rejects an unknown agent_id", async () => {
  await assert.rejects(
    registry.registerWithInvite({
      agent_id: "agent-ghost",
      token: "whatever",
      api_url: "http://hermes.local:3001",
    }),
    AgentAuthError,
  );
});

test("manual registration carries remote fields and reports registered (not yet reachable)", async () => {
  const record = await registry.create({
    alias: "Hermes",
    owner_employee_id: "zhang.wei",
    capabilities: caps,
    api_url: "http://hermes.local:3001",
  });
  assert.equal(record.api_url, "http://hermes.local:3001");
  assert.equal(record.status, "registered");
  assert.equal(record.has_token, false);
  assert.ok(record.agent_id, "manual registration assigns an agent_id");
});

test("manual registration with a token stores it auth-capable", async () => {
  const record = await registry.create({
    alias: "Hermes",
    owner_employee_id: "zhang.wei",
    capabilities: caps,
    token: "manual-token",
  });
  assert.equal(record.has_token, true);

  const viaAgentId = await registry.getByAgentId(record.agent_id);
  assert.ok(viaAgentId, "agent is lookable via its unique agent_id");

  const registered = await registry.registerWithInvite({
    agent_id: record.agent_id,
    token: "manual-token",
    api_url: "http://hermes.local:3001",
  });
  assert.equal(registered.status, "reachable", "a token-carrying agent can confirm its reachability");
});

// G4.S8.T13: the seeded in-process Athena derives `local` (always available) —
// never the legacy `unknown` that rendered as offline.
test("seeded local agents report local status", async () => {
  await registry.seed();
  const athena = await registry.getByAlias("Athena");
  assert.ok(athena);
  assert.equal(athena.status, "local");
});

test("reachable status degrades to registered after the freshness window", async () => {
  const staleWindow = new MemoryAgentRegistry([], { reachableWindowMs: -1 });
  const { invite } = await staleWindow.createInvitation({
    alias: "Hermes",
    owner_employee_id: "zhang.wei",
    api_url: "http://hermes.local:3001",
  });
  const record = await staleWindow.registerWithInvite({
    agent_id: invite.agent_id,
    token: invite.token,
    api_url: "http://hermes.local:3001",
  });
  assert.equal(record.status, "registered", "stale last_seen is no longer reachable");
  await staleWindow.close();
});

test("agent identities are unique", async () => {
  await registry.createInvitation({ alias: "Hermes", owner_employee_id: "zhang.wei", agent_id: "agent-1" });
  await assert.rejects(
    registry.create({ alias: "Poseidon", owner_employee_id: "zhang.wei", capabilities: caps, agent_id: "agent-1" }),
    /already registered/,
  );
});

test("POST /api/agents/invite requires authentication (401)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/agents/invite",
    payload: { alias: "Hermes", owner_employee_id: "zhang.wei" },
  });
  assert.equal(res.statusCode, 401);
});

test("member is denied inviting agents (RBAC: 403)", async () => {
  const sessionToken = await login("member@caleo.com");
  const res = await app.inject({
    method: "POST",
    url: "/api/agents/invite",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { alias: "Hermes", owner_employee_id: "zhang.wei" },
  });
  assert.equal(res.statusCode, 403);
});

test("admin invite returns the {agent_id, api_url, token} invite", async () => {
  const { statusCode, invite } = await adminInvite();
  assert.equal(statusCode, 201);
  assert.ok(invite.agent_id);
  assert.equal(invite.api_url, "http://hermes.local:3001");
  assert.ok(invite.token.length >= 32);
  const listRes = await app.inject({ method: "GET", url: "/api/agents" });
  const { agents } = listRes.json();
  assert.equal(agents[0].status, "invited");
});

test("admin invite rejects a missing alias or owner", async () => {
  assert.equal((await adminInvite({ alias: "" })).statusCode, 400);
  assert.equal((await adminInvite({ owner_employee_id: "" })).statusCode, 400);
  assert.equal((await adminInvite({ api_url: 42 })).statusCode, 400);
});

test("POST /api/agents/register authenticates the agent and records reachability", async () => {
  const { invite } = await adminInvite();
  const res = await app.inject({
    method: "POST",
    url: "/api/agents/register",
    payload: {
      agent_id: invite.agent_id,
      token: invite.token,
      api_url: "http://hermes.local:3002",
    },
  });
  assert.equal(res.statusCode, 200);
  const record = res.json();
  assert.equal(record.status, "reachable");
  assert.equal(record.api_url, "http://hermes.local:3002");
  assert.equal(record.agent_id, invite.agent_id);
});

test("POST /api/agents/register returns 401 for a bad token", async () => {
  const { invite } = await adminInvite();
  const res = await app.inject({
    method: "POST",
    url: "/api/agents/register",
    payload: { agent_id: invite.agent_id, token: "nope", api_url: "http://hermes.local:3002" },
  });
  assert.equal(res.statusCode, 401);
});

test("POST /api/agents/register rejects missing fields", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/agents/register",
    payload: { agent_id: "x", api_url: "http://x" },
  });
  assert.equal(res.statusCode, 400);
});

test("POST /api/agents carries the remote fields (api_url / agent_id / token)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: {
      alias: "Hermes",
      owner_employee_id: "zhang.wei",
      capabilities: caps,
      api_url: "http://hermes.local:3001",
      agent_id: "agent-hermes",
      token: "manual-token",
    },
  });
  assert.equal(res.statusCode, 201);
  const agent = res.json();
  assert.equal(agent.api_url, "http://hermes.local:3001");
  assert.equal(agent.agent_id, "agent-hermes");
  assert.equal(agent.has_token, true);
  assert.equal(agent.status, "registered");
});

test("PUT /api/agents/:alias updates reachability fields", async () => {
  await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: { alias: "Hermes", owner_employee_id: "zhang.wei", capabilities: caps },
  });
  const res = await app.inject({
    method: "PUT",
    url: "/api/agents/Hermes",
    payload: { api_url: "http://hermes.local:3001", agent_id: "agent-hermes" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().api_url, "http://hermes.local:3001");
  assert.equal(res.json().agent_id, "agent-hermes");
});

test("POST /api/agents/register-declaration/:id carries api_url and keeps the agent's identity", async () => {
  const declRes = await app.inject({
    method: "POST",
    url: "/api/agents/self-declare",
    payload: { agent_id: "opencode-ses_xyz", runtime: "local", capabilities: caps },
  });
  assert.equal(declRes.statusCode, 201);
  const declarationId = declRes.json().declaration.id;
  const res = await app.inject({
    method: "POST",
    url: `/api/agents/register-declaration/${declarationId}`,
    payload: {
      alias: "Hermes",
      owner_employee_id: "zhang.wei",
      api_url: "http://hermes.local:3001",
    },
  });
  assert.equal(res.statusCode, 201);
  const agent = res.json();
  assert.equal(agent.api_url, "http://hermes.local:3001");
  assert.equal(agent.agent_id, "opencode-ses_xyz", "identity is inherited from the declaration");
  assert.equal(agent.status, "registered");
});