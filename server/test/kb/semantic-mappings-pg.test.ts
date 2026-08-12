import { test, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PostgresSemanticMappingStore } from "../../src/kb/semantic-mappings.js";

const connectionString =
  process.env.TEST_DATABASE_URL ?? "postgres://hh@/athena_test?host=/var/run/postgresql";

let pool: pg.Pool | null = null;
let store: PostgresSemanticMappingStore | null = null;
let initPromise: Promise<PostgresSemanticMappingStore | null> | null = null;

async function initPg(): Promise<PostgresSemanticMappingStore | null> {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        pool = new pg.Pool({ connectionString });
        store = new PostgresSemanticMappingStore({ pool });
        await store.seed();
        return store;
      } catch (err) {
        console.error("PG integration skipped:", err instanceof Error ? err.message : err);
        return null;
      }
    })();
  }
  return initPromise;
}

test("Postgres semantic mappings: insert + one-to-many array + update + list + remove", async (t) => {
  const service = await initPg();
  if (!service) {
    return t.skip("postgres not available");
  }
  const term = `EDay-${Date.now()}`;

  // one-to-many: comma/slash-separated input stored as a TEXT[] array
  const multi = await service.upsert({ term, canonical: "Expert Day / Principle Day" });
  assert.deepEqual(multi.canonicals, ["Expert Day", "Principle Day"]);
  assert.deepEqual((await service.findByTerm(term))?.canonicals, ["Expert Day", "Principle Day"]);

  // upsert on the same term replaces the canonical array (no duplicate row)
  const updated = await service.upsert({ term, canonicals: ["Expert Day", "Company Day"] });
  assert.deepEqual(updated.canonicals, ["Expert Day", "Company Day"]);
  assert.equal((await service.list()).filter((m) => m.term === term).length, 1);

  // single canonical is backward-compatible (plain array of one)
  const single = await service.upsert({ term: `C-Day-${Date.now()}`, canonical: "CALEO Day" });
  assert.deepEqual(single.canonicals, ["CALEO Day"]);

  assert.equal(await service.remove(multi.id), true);
  assert.equal(await service.remove(multi.id), false);
});

after(async () => {
  if (pool) {
    await pool.end();
  }
});
