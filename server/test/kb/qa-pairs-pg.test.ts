import { test, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PostgresQaPairStore } from "../../src/kb/qa-pairs.js";

const connectionString =
  process.env.TEST_DATABASE_URL ?? "postgres://hh@/athena_test?host=/var/run/postgresql";

let pool: pg.Pool | null = null;
let store: PostgresQaPairStore | null = null;
let initPromise: Promise<PostgresQaPairStore | null> | null = null;

async function initPg(): Promise<PostgresQaPairStore | null> {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        pool = new pg.Pool({ connectionString });
        store = new PostgresQaPairStore({ pool });
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

test("Postgres Q&A store: insert + dedup update + merge + list", async (t) => {
  const service = await initPg();
  if (!service) {
    return t.skip("postgres not available");
  }
  const stamp = Date.now();
  const question = `What is C-Day? ${stamp}`;

  const first = await service.upsert({
    question,
    answer: "the CALEO Day",
    sources: [{ path: "wiki/events/c-day.md" }],
    feedback: "up",
  });
  assert.equal((await service.findByQuestion(question))?.id, first.id);

  // exact-text upsert updates in place
  const second = await service.upsert({
    question,
    answer: "the CALEO Day (revised)",
    feedback: "down",
  });
  assert.equal(second.id, first.id);
  assert.equal((await service.list()).find((p) => p.id === first.id)?.feedback, "down");

  // semantic merge appends answer + unions sources (against the upserted row,
  // whose sources were replaced by the exact-text upsert above)
  const merged = await service.merge(first.id, {
    question,
    answer: "also celebrated annually",
    sources: [{ path: "wiki/events/calendar.md" }],
    feedback: "up",
  });
  assert.equal(merged.id, first.id);
  assert.equal(merged.answer, "the CALEO Day (revised)\n\nalso celebrated annually");
  assert.equal(merged.sources.length, 1);

  // setFeedback
  const rated = await service.setFeedback(first.id, "up");
  assert.equal(rated?.feedback, "up");

  const pairs = await service.list();
  assert.ok(pairs.some((p) => p.id === first.id));
});

after(async () => {
  store = null;
  if (pool) {
    await pool.end();
    pool = null;
  }
});
