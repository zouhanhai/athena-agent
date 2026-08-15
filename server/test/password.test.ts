import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BCRYPT_ROUNDS,
  hashPassword,
  MIN_PASSWORD_LENGTH,
  verifyPassword,
} from "../src/employees/password.js";

test("hashPassword produces a bcrypt hash, never plaintext", async () => {
  const hash = await hashPassword("s3cret!pw");
  assert.match(hash, /^\$2[aby]\$\d\d\$/, "bcrypt hashes start with $2a/$2b/$2y$cost$");
  assert.ok(!hash.includes("s3cret!pw"), "the plaintext must not appear in the hash");
});

test("verifyPassword accepts the correct password and rejects a wrong one", async () => {
  const hash = await hashPassword("correct horse battery");
  assert.equal(await verifyPassword("correct horse battery", hash), true);
  assert.equal(await verifyPassword("wrong password", hash), false);
});

test("a hash round-trips across a fresh verify (independent of the hashing call)", async () => {
  const first = await hashPassword("the-same-password");
  const second = await hashPassword("the-same-password");
  assert.notEqual(first, second, "bcrypt salts each hash");
  assert.equal(await verifyPassword("the-same-password", first), true);
  assert.equal(await verifyPassword("the-same-password", second), true);
});

test("constants are sane for a public sign-in form", () => {
  assert.ok(MIN_PASSWORD_LENGTH >= 8, "passwords should have a minimum length");
  assert.ok(BCRYPT_ROUNDS >= 10, "bcrypt cost should be >= 10");
});
