import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GithubOpExpiredError,
  MemoryGithubOpStore,
  type PendingGithubOp,
} from "../src/github/ops.js";

test("MemoryGithubOpStore.create stores an op with id and timestamps", async () => {
  const store = new MemoryGithubOpStore();
  const op = await store.create({
    employee_email: "alice@caleo.com",
    kind: "open_pull",
    input: { owner: "acme", repo: "box", title: "Add feature", head: "feature", base: "master" },
    summary: "Open PR feature → master in acme/box",
  });
  assert.ok(op.id.length > 0);
  assert.equal(op.employee_email, "alice@caleo.com");
  assert.equal(op.kind, "open_pull");
  assert.equal(op.summary, "Open PR feature → master in acme/box");
  assert.ok(!Number.isNaN(Date.parse(op.created_at)));
  assert.ok(Date.parse(op.expires_at) > Date.parse(op.created_at));
});

test("MemoryGithubOpStore.get returns the stored op", async () => {
  const store = new MemoryGithubOpStore();
  const created = await store.create({
    employee_email: "alice@caleo.com",
    kind: "edit_file",
    input: { owner: "acme", repo: "box", path: "README.md", message: "Update" },
    summary: "Edit README.md in acme/box",
  });
  const op = await store.get(created.id);
  assert.ok(op);
  assert.equal(op.id, created.id);
  assert.deepEqual(op.input, { owner: "acme", repo: "box", path: "README.md", message: "Update" });
});

test("MemoryGithubOpStore.get returns null for an unknown id", async () => {
  const store = new MemoryGithubOpStore();
  assert.equal(await store.get("does-not-exist"), null);
});

test("MemoryGithubOpStore.get throws GithubOpExpiredError and deletes an expired op", async () => {
  const store = new MemoryGithubOpStore({ ttlMs: -1000 });
  const created = await store.create({
    employee_email: "alice@caleo.com",
    kind: "merge_pull",
    input: { owner: "acme", repo: "box", number: 7 },
    summary: "Merge PR 7 in acme/box",
  });
  await assert.rejects(store.get(created.id), GithubOpExpiredError);
  assert.equal(await store.get(created.id), null, "expired op is deleted");
});

test("MemoryGithubOpStore.delete removes the op", async () => {
  const store = new MemoryGithubOpStore();
  const created = await store.create({
    employee_email: "alice@caleo.com",
    kind: "open_pull",
    input: { owner: "acme", repo: "box", title: "t", head: "h", base: "b" },
    summary: "Open PR h → b in acme/box",
  });
  await store.delete(created.id);
  assert.equal(await store.get(created.id), null);
});

test("op ids are unique across creates", async () => {
  const store = new MemoryGithubOpStore();
  const base = {
    employee_email: "alice@caleo.com",
    input: { owner: "acme", repo: "box", title: "t", head: "h", base: "b" },
    summary: "Open PR",
  };
  const a = await store.create({ ...base, kind: "open_pull" as const });
  const b = await store.create({ ...base, kind: "open_pull" as const });
  assert.notEqual(a.id, b.id);
  assert.ok((await store.get(a.id))?.id);
});

export type { PendingGithubOp };
