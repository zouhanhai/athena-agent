import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { MemoryAgentRegistry } from "../src/agents/registry.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let registry: MemoryAgentRegistry;

const validBody = {
  alias: "Hermes",
  owner_employee_id: "zhang.wei",
  logo_url: "/hermes.png",
  runtime: "local",
  capabilities: {
    system: "hermes",
    mcp: ["sap"],
    tools: ["code", "search"],
    description: "Integration agent",
  },
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

test("POST /api/agents registers an agent and returns the stored record", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: validBody,
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.alias, "Hermes");
  assert.equal(body.owner_employee_id, "zhang.wei");
  assert.equal(body.logo_url, "/hermes.png");
  assert.equal(body.runtime, "local");
  assert.deepEqual(body.capabilities, validBody.capabilities);
  assert.ok(body.id, "should assign an id");
  assert.ok(body.created_at, "should record created_at");
  assert.ok(body.updated_at, "should record updated_at");
});

test("POST /api/agents rejects a missing alias", async () => {
  const { alias, ...rest } = validBody;
  const res = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: { ...rest, alias: "" },
  });
  assert.equal(res.statusCode, 400);
});

test("POST /api/agents rejects a missing owner_employee_id", async () => {
  const { owner_employee_id, ...rest } = validBody;
  const res = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: { ...rest, owner_employee_id: "  " },
  });
  assert.equal(res.statusCode, 400);
});

test("POST /api/agents rejects malformed capabilities (mcp not a string array)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: { ...validBody, capabilities: { system: "hermes", mcp: "sap", tools: [] } },
  });
  assert.equal(res.statusCode, 400);
});

test("POST /api/agents rejects capabilities without tools", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: { ...validBody, capabilities: { system: "hermes", mcp: [], tools: undefined } },
  });
  assert.equal(res.statusCode, 400);
});

test("POST /api/agents conflicts (409) when the alias is already registered", async () => {
  const first = await app.inject({ method: "POST", url: "/api/agents", payload: validBody });
  assert.equal(first.statusCode, 201);
  const res = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: { ...validBody, logo_url: "/duplicate.png" },
  });
  assert.equal(res.statusCode, 409);
});

test("GET /api/agents lists all registered agents", async () => {
  await app.inject({ method: "POST", url: "/api/agents", payload: validBody });
  await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: { ...validBody, alias: "Poseidon", owner_employee_id: "li.na" },
  });
  const res = await app.inject({ method: "GET", url: "/api/agents" });
  assert.equal(res.statusCode, 200);
  const { agents } = res.json();
  assert.equal(agents.length, 2);
  assert.ok(agents.some((a: { alias: string }) => a.alias === "Hermes"));
  assert.ok(agents.some((a: { alias: string }) => a.alias === "Poseidon"));
});

test("GET /api/agents filters by ownerEmployeeId", async () => {
  await app.inject({ method: "POST", url: "/api/agents", payload: validBody });
  await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: { ...validBody, alias: "Poseidon", owner_employee_id: "li.na" },
  });
  const res = await app.inject({ method: "GET", url: "/api/agents?ownerEmployeeId=li.na" });
  const { agents } = res.json();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].alias, "Poseidon");
});

test("GET /api/agents/:alias returns a single agent", async () => {
  await app.inject({ method: "POST", url: "/api/agents", payload: validBody });
  const res = await app.inject({ method: "GET", url: "/api/agents/Hermes" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().alias, "Hermes");
});

test("GET /api/agents/:alias returns 404 for an unknown alias", async () => {
  const res = await app.inject({ method: "GET", url: "/api/agents/Ghost" });
  assert.equal(res.statusCode, 404);
});

test("PUT /api/agents/:alias updates logo_url and capabilities", async () => {
  await app.inject({ method: "POST", url: "/api/agents", payload: validBody });
  const res = await app.inject({
    method: "PUT",
    url: "/api/agents/Hermes",
    payload: {
      logo_url: "/hermes-v2.png",
      capabilities: { system: "hermes", mcp: ["sap", "github"], tools: ["code"] },
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.logo_url, "/hermes-v2.png");
  assert.deepEqual(body.capabilities.mcp, ["sap", "github"]);
  assert.ok(body.updated_at >= body.created_at, "updated_at should be refreshed");
});

test("PUT /api/agents/:alias returns 404 for an unknown alias", async () => {
  const res = await app.inject({
    method: "PUT",
    url: "/api/agents/Ghost",
    payload: { logo_url: "/x.png" },
  });
  assert.equal(res.statusCode, 404);
});

test("PUT /api/agents/:alias with no updatable fields returns 400", async () => {
  await app.inject({ method: "POST", url: "/api/agents", payload: validBody });
  const res = await app.inject({ method: "PUT", url: "/api/agents/Hermes", payload: {} });
  assert.equal(res.statusCode, 400);
});
