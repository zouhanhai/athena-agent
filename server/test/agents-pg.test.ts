import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  PostgresAgentRegistry,
  type AgentCapabilities,
} from "../src/agents/registry.js";

const capabilities: AgentCapabilities = {
  system: "hermes",
  mcp: ["sap"],
  tools: ["code"],
  skills: ["git_workflow"],
  specialty: "integration",
};

let pgRegistry: PostgresAgentRegistry | null = null;
let pgInit: Promise<PostgresAgentRegistry | null> | null = null;

async function initPg(): Promise<PostgresAgentRegistry | null> {
  if (!pgInit) {
    pgInit = (async () => {
      try {
        const registry = new PostgresAgentRegistry({
          connectionString:
            process.env.TEST_DATABASE_URL ?? "postgres://hh@/athena_test?host=/var/run/postgresql",
        });
        await registry.seed();
        pgRegistry = registry;
        return registry;
      } catch (err) {
        console.error("PG integration skipped:", err instanceof Error ? err.message : err);
        return null;
      }
    })();
  }
  return pgInit;
}

test(
  "PostgresAgentRegistry.list filters by ownerEmployeeId (integration)",
  async (t) => {
    const registry = await initPg();
    if (!registry) {
      return t.skip("postgres not available");
    }
    const owner = `emp-${Date.now()}`;
    const alias = `pg-agent-${Date.now()}`;
    await registry.create({ alias, owner_employee_id: owner, capabilities });

    const owned = await registry.list({ ownerEmployeeId: owner });
    assert.equal(owned.length, 1);
    assert.equal(owned[0].alias, alias);
    assert.equal(owned[0].owner_employee_id, owner);

    const other = await registry.list({ ownerEmployeeId: `other-${Date.now()}` });
    assert.deepEqual(
      other.filter((a) => a.owner_employee_id === owner),
      [],
      "agents of another employee must not leak into this filter",
    );
  },
);

after(async () => {
  if (pgRegistry) {
    await pgRegistry.close();
    pgRegistry = null;
  }
});
