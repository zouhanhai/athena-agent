import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import {
  MemoryAgentRegistry,
  AgentNotFoundError,
  AgentConflictError,
  type AgentCapabilities,
} from "../src/agents/registry.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let registry: MemoryAgentRegistry;

const declaredCapabilities: AgentCapabilities = {
  system: "opencode",
  mcp: ["athena", "github"],
  tools: ["bash", "file_edit", "web_fetch"],
  skills: ["code_review", "git_workflow"],
  specialty: "software-engineering",
  description: "Code-capable dev agent",
};

const selfDeclareBody = {
  agent_id: "opencode-ses_xyz",
  runtime: "local",
  capabilities: declaredCapabilities,
};

beforeEach(async () => {
  registry = new MemoryAgentRegistry();
  app = buildApp({ registry });
});

after(async () => {
  if (app) {
    await app.close();
  }
});

async function submitDeclaration(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/agents/self-declare",
    payload: selfDeclareBody,
  });
  assert.equal(res.statusCode, 201);
  return res.json().declaration.id;
}

test("POST /api/agents/self-declare stores a pending declaration with the agent's own capabilities", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/agents/self-declare",
    payload: selfDeclareBody,
  });
  assert.equal(res.statusCode, 201);
  const { declaration } = res.json();
  assert.ok(declaration.id, "should assign an id");
  assert.equal(declaration.agent_id, "opencode-ses_xyz");
  assert.equal(declaration.runtime, "local");
  assert.deepEqual(declaration.capabilities, declaredCapabilities);
  assert.ok(declaration.declared_at, "should record declared_at");
  assert.ok(!("alias" in declaration), "declaration must not carry an alias");
  assert.ok(!("logo_url" in declaration), "declaration must not carry a logo_url");
});

test("POST /api/agents/self-declare rejects a missing agent_id", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/agents/self-declare",
    payload: { ...selfDeclareBody, agent_id: "" },
  });
  assert.equal(res.statusCode, 400);
});

test("POST /api/agents/self-declare rejects malformed capabilities", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/agents/self-declare",
    payload: {
      agent_id: "opencode-ses_xyz",
      capabilities: { system: "opencode", mcp: "athena", tools: [], skills: [] },
    },
  });
  assert.equal(res.statusCode, 400);
});

test("GET /api/agents/declarations lists all pending declarations", async () => {
  const first = await submitDeclaration();
  await submitDeclaration();
  const res = await app.inject({ method: "GET", url: "/api/agents/declarations" });
  assert.equal(res.statusCode, 200);
  const { declarations } = res.json();
  assert.equal(declarations.length, 2);
  assert.ok(declarations.some((d: { id: string }) => d.id === first));
});

test("registerDeclaration creates an agent with employee-chosen alias/logo and consumes the declaration", async () => {
  const id = await submitDeclaration();
  const res = await app.inject({
    method: "POST",
    url: `/api/agents/register-declaration/${id}`,
    payload: {
      alias: "Hermes",
      owner_employee_id: "zhang.wei",
      logo_url: "/logos/fox-clean.png",
    },
  });
  assert.equal(res.statusCode, 201);
  const agent = res.json();
  assert.equal(agent.alias, "Hermes");
  assert.equal(agent.owner_employee_id, "zhang.wei");
  assert.equal(agent.logo_url, "/logos/fox-clean.png");
  assert.equal(agent.runtime, "local", "runtime should come from the declaration");
  assert.deepEqual(
    agent.capabilities,
    declaredCapabilities,
    "capabilities should come from the declaration (auto-filled)",
  );

  const listRes = await app.inject({ method: "GET", url: "/api/agents/declarations" });
  const { declarations } = listRes.json();
  assert.equal(declarations.length, 0, "registered declaration must be consumed");
});

test("registerDeclaration registers an agent without a logo when none is chosen", async () => {
  const id = await submitDeclaration();
  const res = await app.inject({
    method: "POST",
    url: `/api/agents/register-declaration/${id}`,
    payload: { alias: "Hermes", owner_employee_id: "zhang.wei" },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().logo_url, "");
});

test("registerDeclaration rejects a missing alias or owner", async () => {
  const id = await submitDeclaration();
  const noAlias = await app.inject({
    method: "POST",
    url: `/api/agents/register-declaration/${id}`,
    payload: { owner_employee_id: "zhang.wei" },
  });
  assert.equal(noAlias.statusCode, 400);
  const noOwner = await app.inject({
    method: "POST",
    url: `/api/agents/register-declaration/${id}`,
    payload: { alias: "Hermes" },
  });
  assert.equal(noOwner.statusCode, 400);
});

test("registerDeclaration returns 404 for an unknown declaration id", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/agents/register-declaration/ghost",
    payload: { alias: "Hermes", owner_employee_id: "zhang.wei" },
  });
  assert.equal(res.statusCode, 404);
});

test("registerDeclaration updates an existing agent for the same agent_id (no 409)", async () => {
  const id = await submitDeclaration();
  const first = await app.inject({
    method: "POST",
    url: `/api/agents/register-declaration/${id}`,
    payload: { alias: "Hermes", owner_employee_id: "zhang.wei" },
  });
  assert.equal(first.statusCode, 201);
  // A second declaration for the SAME agent_id confirms onto the existing
  // agent (UPDATE) instead of INSERTing a duplicate — the registered agent's
  // capabilities get (re)adopted without tripping the unique constraint.
  const second = await submitDeclaration();
  const res = await app.inject({
    method: "POST",
    url: `/api/agents/register-declaration/${second}`,
    payload: { alias: "Hermes", owner_employee_id: "zhang.wei" },
  });
  assert.equal(res.statusCode, 201, "same-agent confirmation should UPDATE, not 409");
  const listRes = await app.inject({ method: "GET", url: "/api/agents/declarations" });
  const { declarations } = listRes.json();
  assert.equal(
    declarations.length,
    0,
    "confirming consumes both declarations",
  );
});

test("registerDeclaration returns 409 when a DIFFERENT agent_id conflicts on alias", async () => {
  const id = await submitDeclaration();
  await app.inject({
    method: "POST",
    url: `/api/agents/register-declaration/${id}`,
    payload: { alias: "Hermes", owner_employee_id: "zhang.wei" },
  });
  const other = await app.inject({
    method: "POST",
    url: "/api/agents/self-declare",
    payload: { ...selfDeclareBody, agent_id: "opencode-ses_other" },
  });
  const otherId = other.json().declaration.id;
  const res = await app.inject({
    method: "POST",
    url: `/api/agents/register-declaration/${otherId}`,
    payload: { alias: "Hermes", owner_employee_id: "zhang.wei" },
  });
  assert.equal(res.statusCode, 409);
  const listRes = await app.inject({ method: "GET", url: "/api/agents/declarations" });
  const { declarations } = listRes.json();
  assert.equal(
    declarations.length,
    1,
    "a failed registration must leave the declaration pending",
  );
});

test("a declaration remains pending after self-declare without registering", async () => {
  await submitDeclaration();
  const res = await app.inject({ method: "GET", url: "/api/agents" });
  const { agents } = res.json();
  assert.equal(agents.length, 0, "self-declaration alone must not create an agent");
});

test("MemoryAgentRegistry.registerDeclaration throws when the declaration is unknown", async () => {
  await assert.rejects(
    registry.registerDeclaration("missing", {
      alias: "Hermes",
      owner_employee_id: "zhang.wei",
    }),
    AgentNotFoundError,
  );
});

test("MemoryAgentRegistry.registerDeclaration throws when the alias conflicts", async () => {
  await registry.create({
    alias: "Hermes",
    owner_employee_id: "zhang.wei",
    capabilities: declaredCapabilities,
  });
  const declaration = await registry.submitDeclaration({
    agent_id: "opencode-ses_xyz",
    capabilities: declaredCapabilities,
  });
  await assert.rejects(
    registry.registerDeclaration(declaration.id, {
      alias: "Hermes",
      owner_employee_id: "zhang.wei",
    }),
    AgentConflictError,
  );
});
