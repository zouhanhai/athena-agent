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
import { createSecretCipher } from "../src/employees/crypto.js";

const TEST_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const TEST_CIPHER = createSecretCipher(TEST_KEY);

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
          cipher: TEST_CIPHER,
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

test(
  "Postgres stores the github credential encrypted at rest — never plaintext (integration)",
  async (t) => {
    const registry = await initPg();
    if (!registry) {
      return t.skip("postgres not available");
    }
    const email = `pg-cred-${Date.now()}@example.com`;
    const secret = "ghp_plaintextmustneverappear";
    await registry.create({ email, github_credential: { type: "token", value: secret } });
    await registry.registerGithubCredential(email, { type: "token", value: secret });

    const pool = new pg.Pool({
      connectionString:
        process.env.TEST_DATABASE_URL ?? "postgres://hh@/athena_test?host=/var/run/postgresql",
    });
    const stored = await pool.query<{ github_credential_enc: string }>(
      `SELECT github_credential_enc FROM employees WHERE email = $1`,
      [email],
    );
    await pool.end();
    const enc = stored.rows[0]?.github_credential_enc;
    assert.ok(enc, "credential should be persisted in the github_credential_enc column");
    assert.ok(!enc.includes(secret), "the raw secret must never be stored as plaintext");

    const decrypted = TEST_CIPHER.decrypt(enc);
    assert.equal(decrypted, secret);

    assert.deepEqual(await registry.getGithubCredential(email), { type: "token", value: secret });
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

test("create stores a github credential that decrypts back to the original value", async () => {
  const registry = new MemoryEmployeeRegistry([], { cipher: TEST_CIPHER });
  const created = await registry.create({
    email: "alice@example.com",
    github_credential: { type: "token", value: "ghp_alicesecret" },
  });
  const credential = await registry.getGithubCredential(created.email);
  assert.deepEqual(credential, { type: "token", value: "ghp_alicesecret" });
});

test("getGithubCredential returns null when no credential is registered", async () => {
  const registry = new MemoryEmployeeRegistry([], { cipher: TEST_CIPHER });
  const created = await registry.create({ email: "alice@example.com" });
  assert.equal(await registry.getGithubCredential(created.email), null);
});

test("registerGithubCredential registers and updates the employee's credential", async () => {
  const registry = new MemoryEmployeeRegistry([], { cipher: TEST_CIPHER });
  await registry.create({ email: "alice@example.com" });

  const first = await registry.registerGithubCredential("alice@example.com", {
    type: "ssh",
    value: "ssh-ed25519 AAAA first",
  });
  assert.deepEqual(first, { has_credential: true, type: "ssh" });

  const second = await registry.registerGithubCredential("alice@example.com", {
    type: "token",
    value: "ghp_newtoken",
  });
  assert.deepEqual(second, { has_credential: true, type: "token" });

  assert.deepEqual(await registry.getGithubCredential("alice@example.com"), {
    type: "token",
    value: "ghp_newtoken",
  });
});

test("registerGithubCredential on an unknown email throws EmployeeNotFoundError", async () => {
  const registry = new MemoryEmployeeRegistry([], { cipher: TEST_CIPHER });
  await assert.rejects(
    registry.registerGithubCredential("ghost@example.com", { type: "token", value: "x" }),
    EmployeeNotFoundError,
  );
});
