import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildApp } from "../src/app.js";
import { DEFAULT_ATHENA, MemoryAgentRegistry } from "../src/agents/registry.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance | undefined;

after(async () => {
  if (app) {
    await app.close();
  }
});

const knowledgeAssistantCaps = {
  system: "athena",
  mcp: ["lightrag", "llm_wiki"],
  tools: ["file_upload", "knowledge_graph_qa"],
  skills: ["knowledge_graph_qa", "wiki_search", "document_ingest"],
  specialty: "knowledge",
};

test("DEFAULT_ATHENA declares the local Athena knowledge assistant with owl logo", () => {
  assert.equal(DEFAULT_ATHENA.alias, "Athena");
  assert.equal(DEFAULT_ATHENA.owner_employee_id, "system");
  assert.equal(DEFAULT_ATHENA.logo_url, "/athena-logo-ai.png");
  assert.equal(DEFAULT_ATHENA.runtime, "server");
  assert.deepEqual(DEFAULT_ATHENA.capabilities, knowledgeAssistantCaps);
});

test("MemoryAgentRegistry.seed() inserts the default Athena agent idempotently", async () => {
  const registry = new MemoryAgentRegistry();
  await registry.seed();
  const athena = await registry.getByAlias("Athena");
  assert.ok(athena, "Athena should be seeded");
  assert.equal(athena.alias, "Athena");
  assert.equal(athena.owner_employee_id, "system");
  assert.equal(athena.logo_url, "/athena-logo-ai.png");
  assert.deepEqual(athena.capabilities, knowledgeAssistantCaps);

  await registry.seed();
  const agents = await registry.list();
  assert.equal(agents.filter((a) => a.alias === "Athena").length, 1, "seed should be idempotent");
  await registry.close();
});

test("default Athena agent is queryable via GET /api/agents/Athena after server start", async () => {
  app = buildApp();
  const res = await app.inject({ method: "GET", url: "/api/agents/Athena" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.alias, "Athena");
  assert.equal(body.owner_employee_id, "system");
  assert.equal(body.logo_url, "/athena-logo-ai.png");
  assert.equal(body.runtime, "server");
  assert.deepEqual(body.capabilities, knowledgeAssistantCaps);
});

test("owl logo asset exists at web/public/athena-logo-ai.png", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const logoPath = path.join(repoRoot, "web", "public", "athena-logo-ai.png");
  assert.ok(existsSync(logoPath), `owl logo asset missing at ${logoPath}`);
});
