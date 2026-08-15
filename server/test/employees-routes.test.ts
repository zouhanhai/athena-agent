import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import {
  MagicLinkAuthService,
  MemoryAuthTokenStore,
  type MagicLinkMailer,
} from "../src/employees/auth.js";
import { MemoryEmployeeRegistry } from "../src/employees/employees.js";
import { createSecretCipher } from "../src/employees/crypto.js";
import { hashPassword } from "../src/employees/password.js";

const TEST_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

interface SentMail {
  to: string;
  magicLinkUrl: string;
}

function tokenFromUrl(url: string): string {
  const match = /[?&]token=([^&]+)/.exec(url);
  assert.ok(match, `magic link should carry a token: ${url}`);
  return decodeURIComponent(match[1]);
}

let app: FastifyInstance;
let sent: SentMail[];
let registry: MemoryEmployeeRegistry;

beforeEach(async () => {
  sent = [];
  registry = new MemoryEmployeeRegistry(
    [
      { email: "admin@caleo.com", display_name: "Admin", role: "admin" },
      { email: "member@caleo.com", display_name: "Member", role: "member" },
    ],
    { cipher: createSecretCipher(TEST_KEY) },
  );
  const mailer: MagicLinkMailer = {
    async sendLoginLink(input) {
      sent.push({ to: input.to, magicLinkUrl: input.magicLinkUrl });
    },
  };
  const auth = new MagicLinkAuthService({
    registry,
    mailer,
    tokens: new MemoryAuthTokenStore(),
    appBaseUrl: "http://localhost:5173",
  });
  app = buildApp({ employees: registry, auth });
});

after(async () => {
  if (app) {
    await app.close();
  }
});

async function login(email: string): Promise<string> {
  await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email },
  });
  const token = tokenFromUrl(sent[sent.length - 1].magicLinkUrl);
  const res = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { token } });
  assert.equal(res.statusCode, 200);
  return (res.json() as { session_token: string }).session_token;
}

test("POST /api/auth/login sends a magic link and returns ok", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "admin@caleo.com" },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "admin@caleo.com");
  assert.match(sent[0].magicLinkUrl, /^http:\/\/localhost:5173\/auth\/verify\?token=/);
});

test("POST /api/auth/login returns ok even for an unregistered email (no leak)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "ghost@caleo.com" },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
  assert.equal(sent.length, 0);
});

test("POST /api/auth/login rejects a missing email", async () => {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: {} });
  assert.equal(res.statusCode, 400);
});

test("POST /api/auth/verify exchanges a token for a session + employee", async () => {
  await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@caleo.com" } });
  const token = tokenFromUrl(sent[0].magicLinkUrl);
  const res = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { token } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.session_token);
  assert.equal(body.employee.email, "admin@caleo.com");
  assert.equal(body.employee.role, "admin");
});

test("POST /api/auth/verify returns 401 for an invalid token", async () => {
  const res = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { token: "bad" } });
  assert.equal(res.statusCode, 401);
});

test("POST /api/auth/login with email+password signs in when a password is set", async () => {
  await registry.setPassword("admin@caleo.com", await hashPassword("s3cret!pw"));
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "admin@caleo.com", password: "s3cret!pw" },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.session_token, "should return a session token");
  assert.equal(body.employee.email, "admin@caleo.com");
  assert.equal(sent.length, 0, "a successful password login must not email a magic link");
});

test("POST /api/auth/login with a wrong password is rejected", async () => {
  await registry.setPassword("admin@caleo.com", await hashPassword("s3cret!pw"));
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "admin@caleo.com", password: "wrong-password" },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(sent.length, 0, "a wrong password must not fall back to a magic link");
});

test("POST /api/auth/login with email+password falls back to a magic link when no password is set", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "admin@caleo.com", password: "anything" },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
  assert.equal(sent.length, 1, "fall back to emailing a magic link");
  assert.equal(sent[0].to, "admin@caleo.com");
});

test("POST /api/auth/login with email+password on an unknown email returns ok (no leak)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "ghost@caleo.com", password: "whatever" },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
  assert.equal(sent.length, 0, "no mail for an unknown email");
});

test("POST /api/auth/login without a password still sends a magic link (backward compatible)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "member@caleo.com" },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "member@caleo.com");
});

test("GET /api/me returns the employee behind a session token", async () => {
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().email, "admin@caleo.com");
});

test("GET /api/me returns 401 without a session token", async () => {
  const res = await app.inject({ method: "GET", url: "/api/me" });
  assert.equal(res.statusCode, 401);
});

test("GET /api/me reports github_has_credential false when none is stored", async () => {
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.github_has_credential, false);
  assert.equal(body.github_credential_type, undefined);
  assert.equal(body.github_credential_masked, undefined);
});

test("GET /api/me reports github_has_credential + a partial mask, never the full token", async () => {
  const sessionToken = await login("member@caleo.com");
  const secret = "ghp_membermustneverleak";
  await app.inject({
    method: "PUT",
    url: "/api/me",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { github_credential: { type: "token", value: secret } },
  });
  const res = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.github_has_credential, true);
  assert.equal(body.github_credential_type, "token");
  assert.equal(body.github_credential_masked, "ghp_****leak");
  assert.ok(!JSON.stringify(body).includes(secret), "must never leak the full token");
});

test("PUT /api/me response carries the github mask so the UI stays correct after saving", async () => {
  const sessionToken = await login("member@caleo.com");
  const res = await app.inject({
    method: "PUT",
    url: "/api/me",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { github_credential: { type: "token", value: "ghp_newcredvalue" } },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.github_has_credential, true);
  assert.equal(body.github_credential_masked, "ghp_****alue");
  assert.ok(!JSON.stringify(body).includes("ghp_newcredvalue"), "must never leak the full token");
});

test("admin can list employees (RBAC: employees.list)", async () => {
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/employees",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(res.statusCode, 200);
  const { employees } = res.json();
  assert.equal(employees.length, 2);
});

test("member is denied listing employees (RBAC: 403)", async () => {
  const sessionToken = await login("member@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/employees",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(res.statusCode, 403);
});

test("employees endpoints require authentication (401 without token)", async () => {
  const res = await app.inject({ method: "GET", url: "/api/employees" });
  assert.equal(res.statusCode, 401);
});

test("admin can create an employee (RBAC: employees.create)", async () => {
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "POST",
    url: "/api/employees",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { email: "carol@caleo.com", display_name: "Carol", role: "member" },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().email, "carol@caleo.com");
  assert.equal(res.json().role, "member");
});

test("member is denied creating employees (RBAC: 403)", async () => {
  const sessionToken = await login("member@caleo.com");
  const res = await app.inject({
    method: "POST",
    url: "/api/employees",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { email: "carol@caleo.com" },
  });
  assert.equal(res.statusCode, 403);
});

test("POST /api/employees rejects an invalid email", async () => {
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "POST",
    url: "/api/employees",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { email: "" },
  });
  assert.equal(res.statusCode, 400);
});

test("POST /api/employees rejects an unknown role", async () => {
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "POST",
    url: "/api/employees",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { email: "carol@caleo.com", role: "superuser" },
  });
  assert.equal(res.statusCode, 400);
});

test("GET /api/employees/:email returns a single employee for admins", async () => {
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/employees/member@caleo.com",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().email, "member@caleo.com");
});

test("GET /api/employees/:email returns 404 for an unknown employee", async () => {
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/employees/ghost@caleo.com",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(res.statusCode, 404);
});

test("PUT /api/employees/:email updates role for admins", async () => {
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "PUT",
    url: "/api/employees/member@caleo.com",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { role: "admin", display_name: "Promoted" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().role, "admin");
  assert.equal(res.json().display_name, "Promoted");
});

test("PUT /api/employees/:email grants and revokes kb.edit for admins (G4.S3.T10)", async () => {
  const sessionToken = await login("admin@caleo.com");
  const granted = await app.inject({
    method: "PUT",
    url: "/api/employees/member@caleo.com",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { permissions: ["kb.edit"] },
  });
  assert.equal(granted.statusCode, 200);
  assert.deepEqual(granted.json().permissions, ["kb.edit"]);

  // The grant shows up via GET /api/employees/:email and the member's own /api/me.
  const listed = await app.inject({
    method: "GET",
    url: "/api/employees/member@caleo.com",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.deepEqual(listed.json().permissions, ["kb.edit"]);

  const memberSession = await login("member@caleo.com");
  const me = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: { authorization: `Bearer ${memberSession}` },
  });
  assert.deepEqual(me.json().permissions, ["kb.edit"], "the member's own profile carries the grant");

  const revoked = await app.inject({
    method: "PUT",
    url: "/api/employees/member@caleo.com",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { permissions: [] },
  });
  assert.deepEqual(revoked.json().permissions, []);
});

test("PUT /api/employees/:email rejects an unknown permission (G4.S3.T10)", async () => {
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "PUT",
    url: "/api/employees/member@caleo.com",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { permissions: ["kb.edit", "nonsense"] },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /unknown permission/i);
});

test("a member cannot grant permissions via PUT /api/employees/:email (RBAC: 403)", async () => {
  const sessionToken = await login("member@caleo.com");
  const res = await app.inject({
    method: "PUT",
    url: "/api/employees/member@caleo.com",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { permissions: ["kb.edit"] },
  });
  assert.equal(res.statusCode, 403);
});

test("PUT /api/me updates display_name and logo_url for self", async () => {
  const sessionToken = await login("member@caleo.com");
  const res = await app.inject({
    method: "PUT",
    url: "/api/me",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { display_name: "Member Updated", logo_url: "/logos/fox-clean.png" },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.email, "member@caleo.com");
  assert.equal(body.display_name, "Member Updated");
  assert.equal(body.logo_url, "/logos/fox-clean.png");
  assert.equal(body.role, "member");
});

test("PUT /api/me stores a github_credential encrypted and never returns the secret", async () => {
  const sessionToken = await login("member@caleo.com");
  const secret = "ghp_membermustneverleak";
  const res = await app.inject({
    method: "PUT",
    url: "/api/me",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { github_credential: { type: "token", value: secret } },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(!("github_credential" in body), "response must not expose the credential");
  assert.ok(!JSON.stringify(body).includes(secret), "response must not contain the plaintext secret");

  const stored = await registry.getGithubCredential("member@caleo.com");
  assert.deepEqual(stored, { type: "token", value: secret });
});

test("PUT /api/me overwrites a previously registered github_credential", async () => {
  const sessionToken = await login("member@caleo.com");
  await app.inject({
    method: "PUT",
    url: "/api/me",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { github_credential: { type: "ssh", value: "ssh-ed25519 firstkey" } },
  });
  const res = await app.inject({
    method: "PUT",
    url: "/api/me",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { github_credential: { type: "token", value: "ghp_newer" } },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(await registry.getGithubCredential("member@caleo.com"), {
    type: "token",
    value: "ghp_newer",
  });
});

test("PUT /api/me requires authentication", async () => {
  const res = await app.inject({
    method: "PUT",
    url: "/api/me",
    payload: { display_name: "Anon" },
  });
  assert.equal(res.statusCode, 401);
});

test("PUT /api/me rejects an invalid github_credential", async () => {
  const sessionToken = await login("member@caleo.com");
  const badType = await app.inject({
    method: "PUT",
    url: "/api/me",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { github_credential: { type: "password", value: "x" } },
  });
  assert.equal(badType.statusCode, 400);

  const missingValue = await app.inject({
    method: "PUT",
    url: "/api/me",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { github_credential: { type: "token", value: "  " } },
  });
  assert.equal(missingValue.statusCode, 400);
});

test("PUT /api/me cannot change the role", async () => {
  const sessionToken = await login("member@caleo.com");
  const res = await app.inject({
    method: "PUT",
    url: "/api/me",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { display_name: "Still Member", role: "admin" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().role, "member");
});
