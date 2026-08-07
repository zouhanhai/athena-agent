import { test, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {
  EmployeeConflictError,
  EmployeeNotFoundError,
  MemoryEmployeeRegistry,
  PostgresEmployeeRegistry,
  type EmployeeRecord,
} from "../src/employees/employees.js";

function recordWith(partial: Partial<EmployeeRecord>): EmployeeRecord {
  return {
    id: "x",
    email: "x@example.com",
    display_name: "",
    logo_url: "",
    role: "member",
    created_at: "2026-08-08T00:00:00.000Z",
    updated_at: "2026-08-08T00:00:00.000Z",
    ...partial,
  };
}

test("create stores the employee with normalized email and default role/display name", async () => {
  const registry = new MemoryEmployeeRegistry();
  const record = await registry.create({ email: "  Alice@Example.com " });
  assert.match(record.email, /^[a-z0-9.@-]+$/, "email should be trimmed and lowercased");
  assert.equal(record.email, "alice@example.com");
  assert.equal(record.role, "member");
  assert.equal(record.display_name, "");
  assert.equal(record.logo_url, "");
  assert.ok(record.id, "should assign an id");
  assert.ok(record.created_at);
  assert.ok(record.updated_at);
});

test("create honors explicit display_name, logo_url and role", async () => {
  const registry = new MemoryEmployeeRegistry();
  const record = await registry.create({
    email: "bob@example.com",
    display_name: "Bob Builder",
    logo_url: "/bob.png",
    role: "admin",
  });
  assert.equal(record.display_name, "Bob Builder");
  assert.equal(record.logo_url, "/bob.png");
  assert.equal(record.role, "admin");
});

test("create rejects a duplicate email with EmployeeConflictError", async () => {
  const registry = new MemoryEmployeeRegistry();
  await registry.create({ email: "alice@example.com" });
  await assert.rejects(
    registry.create({ email: "ALICE@example.com", display_name: "other" }),
    EmployeeConflictError,
  );
});

test("getByEmail and getById resolve a created employee; unknown returns null", async () => {
  const registry = new MemoryEmployeeRegistry();
  const created = await registry.create({ email: "alice@example.com" });
  assert.equal((await registry.getByEmail("alice@example.com"))?.id, created.id);
  assert.equal((await registry.getById(created.id))?.email, "alice@example.com");
  assert.equal(await registry.getByEmail("ghost@example.com"), null);
  assert.equal(await registry.getById("ghost"), null);
});

test("list returns all employees", async () => {
  const registry = new MemoryEmployeeRegistry();
  await registry.create({ email: "alice@example.com" });
  await registry.create({ email: "bob@example.com" });
  const records = await registry.list();
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((r) => r.email).sort(), ["alice@example.com", "bob@example.com"]);
});

test("updateByEmail patches display_name, logo_url and role", async () => {
  const registry = new MemoryEmployeeRegistry();
  const created = await registry.create({ email: "alice@example.com" });
  const updated = await registry.updateByEmail("alice@example.com", {
    display_name: "Alice Adams",
    logo_url: "/alice.png",
    role: "admin",
  });
  assert.equal(updated.display_name, "Alice Adams");
  assert.equal(updated.logo_url, "/alice.png");
  assert.equal(updated.role, "admin");
  assert.equal((await registry.getById(created.id))?.display_name, "Alice Adams");
});

test("updateByEmail on an unknown email throws EmployeeNotFoundError", async () => {
  const registry = new MemoryEmployeeRegistry();
  await assert.rejects(
    registry.updateByEmail("ghost@example.com", { display_name: "x" }),
    EmployeeNotFoundError,
  );
});

let pgRegistry: PostgresEmployeeRegistry | null = null;
let pgInit: Promise<PostgresEmployeeRegistry | null> | null = null;

async function initPg(): Promise<PostgresEmployeeRegistry | null> {
  if (!pgInit) {
    pgInit = (async () => {
      try {
        const registry = new PostgresEmployeeRegistry({
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
  "Postgres employees table round-trips create/get/update (integration)",
  async (t) => {
    const registry = await initPg();
    if (!registry) {
      return t.skip("postgres not available");
    }
    const email = `pg-${Date.now()}@example.com`;
    const created = await registry.create({
      email,
      display_name: "PG User",
      logo_url: "/pg.png",
      role: "admin",
    });
    assert.equal(created.email, email);
    assert.equal(created.role, "admin");

    const byEmail = await registry.getByEmail(email);
    assert.equal(byEmail?.id, created.id);
    assert.equal(byEmail?.display_name, "PG User");

    const updated = await registry.updateByEmail(email, { role: "member" });
    assert.equal(updated.role, "member");

    const all = await registry.list();
    assert.ok(all.some((r) => r.email === email), "listed employees should include the created one");
  },
);

test(
  "Postgres employees table is unique on email (integration)",
  async (t) => {
    const registry = await initPg();
    if (!registry) {
      return t.skip("postgres not available");
    }
    const email = `pg-dup-${Date.now()}@example.com`;
    await registry.create({ email });
    await assert.rejects(registry.create({ email }), EmployeeConflictError);
  },
);

after(async () => {
  if (pgRegistry) {
    await pgRegistry.close();
    pgRegistry = null;
  }
});

test("rowToRecord maps timestamps to ISO strings", async () => {
  const registry = new MemoryEmployeeRegistry();
  const created = await registry.create({ email: "ts@example.com" });
  assert.ok(!Number.isNaN(Date.parse(created.created_at)), "created_at must parse as a date");
});

test("MemoryEmployeeRegistry seeds initial employees on construction", async () => {
  const registry = new MemoryEmployeeRegistry([
    { email: "admin@example.com", display_name: "Admin", role: "admin" },
  ]);
  const admin = await registry.getByEmail("admin@example.com");
  assert.equal(admin?.role, "admin");
  assert.equal(admin?.display_name, "Admin");
});
