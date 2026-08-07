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
  registry = new MemoryEmployeeRegistry([
    { email: "admin@caleo.com", display_name: "Admin", role: "admin" },
    { email: "member@caleo.com", display_name: "Member", role: "member" },
  ]);
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
