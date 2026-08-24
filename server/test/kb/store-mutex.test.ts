/**
 * G4.S10.T1 — global async write mutex: serializes the graph write phase so
 * parallel uploads cannot lose merges/updates against shared entities.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { AsyncMutex, globalGraphWriteMutex } from "../../src/kb/store/mutex.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("runExclusive serializes overlapping critical sections", async () => {
  const mutex = new AsyncMutex();
  const events: string[] = [];

  const section = (name: string, yields: number) =>
    mutex.runExclusive(async () => {
      events.push(`enter:${name}`);
      for (let i = 0; i < yields; i += 1) await tick();
      events.push(`exit:${name}`);
    });

  // Both sections start concurrently and yield inside; the mutex must keep
  // their bodies strictly ordered.
  const [a, b] = [section("a", 3), section("b", 1)];
  await Promise.all([a, b]);

  assert.deepEqual(events, ["enter:a", "exit:a", "enter:b", "exit:b"]);
});

test("runExclusive preserves the callback's value and propagates rejections while releasing the lock", async () => {
  const mutex = new AsyncMutex();
  await assert.equal(await mutex.runExclusive(async () => 42), 42);

  await assert.rejects(
    () => mutex.runExclusive(async () => { throw new Error("boom"); }),
    /boom/,
  );

  // The failed section must NOT leave the mutex locked.
  let entered = false;
  await mutex.runExclusive(async () => {
    entered = true;
  });
  assert.equal(entered, true);
});

test("queued callers run FIFO after the current holder finishes", async () => {
  const mutex = new AsyncMutex();
  const order: number[] = [];
  const job = (n: number) => mutex.runExclusive(async () => {
    await tick();
    order.push(n);
  });
  await Promise.all([job(1), job(2), job(3)]);
  assert.deepEqual(order, [1, 2, 3]);
});

test("the module-level singleton is exported for the shared write phase", () => {
  assert.ok(globalGraphWriteMutex instanceof AsyncMutex);
});
