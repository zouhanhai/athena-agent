import { test } from "node:test";
import assert from "node:assert/strict";
import { createSecretCipher } from "../src/employees/crypto.js";

const KEY_A = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const KEY_B = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

test("encrypt never returns the plaintext", () => {
  const cipher = createSecretCipher(KEY_A);
  const payload = cipher.encrypt("ghp_supersecrettoken");
  assert.notEqual(payload, "ghp_supersecrettoken");
  assert.ok(!payload.includes("supersecret"), "ciphertext should not contain the secret");
});

test("decrypt round-trips the plaintext", () => {
  const cipher = createSecretCipher(KEY_A);
  const secret = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n";
  assert.equal(cipher.decrypt(cipher.encrypt(secret)), secret);
});

test("encrypting the same plaintext twice yields different ciphertext (random IV)", () => {
  const cipher = createSecretCipher(KEY_A);
  assert.notEqual(cipher.encrypt("ghp_token"), cipher.encrypt("ghp_token"));
});

test("decrypt with the wrong key throws", () => {
  const payload = createSecretCipher(KEY_A).encrypt("ghp_token");
  assert.throws(() => createSecretCipher(KEY_B).decrypt(payload));
});

test("createSecretCipher rejects a key that is not 32 bytes", () => {
  assert.throws(() => createSecretCipher("tooshort"), /32 bytes/);
});

test("decrypt rejects a malformed payload", () => {
  const cipher = createSecretCipher(KEY_A);
  assert.throws(() => cipher.decrypt("not-valid-payload"));
  assert.throws(() => cipher.decrypt("v2:aaa:bbb:ccc"));
});
