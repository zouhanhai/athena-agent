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
import {
  InvitationService,
  MemoryInvitationStore,
  type InvitationMailer,
} from "../src/employees/invitations.js";
import { createSecretCipher } from "../src/employees/crypto.js";

interface SentMail {
  to: string;
  magicLinkUrl: string;
}

interface SentInvite {
  to: string;
  inviteUrl: string;
}

function tokenFromUrl(url: string): string {
  const match = /[?&]token=([^&]+)/.exec(url);
  assert.ok(match, `url should carry a token: ${url}`);
  return decodeURIComponent(match[1]);
}

const KEY = "d3d1e5d0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6";

let app: FastifyInstance;
let loginMails: SentMail[];
let inviteMails: SentInvite[];
let registry: MemoryEmployeeRegistry;

beforeEach(async () => {
  loginMails = [];
  inviteMails = [];
  registry = new MemoryEmployeeRegistry(
    [
      { email: "admin@caleo.com", display_name: "Admin", role: "admin" },
      { email: "member@caleo.com", display_name: "Member", role: "member" },
    ],
    { cipher: createSecretCipher(KEY) },
  );
  const tokens = new MemoryAuthTokenStore();
  const loginMailer: MagicLinkMailer = {
    async sendLoginLink(input) {
      loginMails.push({ to: input.to, magicLinkUrl: input.magicLinkUrl });
    },
  };
  const auth = new MagicLinkAuthService({
    registry,
    mailer: loginMailer,
    tokens,
    appBaseUrl: "http://localhost:5173",
  });
  const inviteMailer: InvitationMailer = {
    async sendInvitation(input) {
      inviteMails.push({ to: input.to, inviteUrl: input.inviteUrl });
    },
  };
  const invitations = new InvitationService({
    registry,
    tokens,
    store: new MemoryInvitationStore(),
    mailer: inviteMailer,
    appBaseUrl: "http://localhost:5173",
  });
  app = buildApp({ employees: registry, auth, invitations });
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
  const token = tokenFromUrl(loginMails[loginMails.length - 1].magicLinkUrl);
  const res = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { token } });
  assert.equal(res.statusCode, 200);
  return (res.json() as { session_token: string }).session_token;
}

test("admin can invite an employee (RBAC: employees.invite)", async () => {
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "POST",
    url: "/api/invitations",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { email: "carol@caleo.com" },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.match(body.inviteUrl, /^http:\/\/localhost:5173\/register\?token=/);
  assert.equal(body.expiresInMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(inviteMails.length, 1);
  assert.equal(inviteMails[0].to, "carol@caleo.com");
  assert.equal(inviteMails[0].inviteUrl, body.inviteUrl);
});

test("member is denied inviting employees (RBAC: 403)", async () => {
  const sessionToken = await login("member@caleo.com");
  const res = await app.inject({
    method: "POST",
    url: "/api/invitations",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { email: "carol@caleo.com" },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(inviteMails.length, 0);
});

test("POST /api/invitations requires authentication (401)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/invitations",
    payload: { email: "carol@caleo.com" },
  });
  assert.equal(res.statusCode, 401);
});

test("POST /api/invitations rejects an invalid email", async () => {
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "POST",
    url: "/api/invitations",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { email: "not-an-email" },
  });
  assert.equal(res.statusCode, 400);
});

test("POST /api/invitations returns 409 when the email is already an employee", async () => {
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "POST",
    url: "/api/invitations",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { email: "member@caleo.com" },
  });
  assert.equal(res.statusCode, 409);
});

test("GET /api/invitations/resolve returns the invited email for a valid token (public)", async () => {
  const sessionToken = await login("admin@caleo.com");
  await app.inject({
    method: "POST",
    url: "/api/invitations",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { email: "carol@caleo.com" },
  });
  const token = tokenFromUrl(inviteMails[0].inviteUrl);
  const res = await app.inject({ method: "GET", url: `/api/invitations/resolve?token=${token}` });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { email: "carol@caleo.com" });
});

test("GET /api/invitations/resolve returns 401 for an invalid token", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/invitations/resolve?token=garbage",
  });
  assert.equal(res.statusCode, 401);
});

test("POST /api/invitations/register completes the invited employee registration", async () => {
  const sessionToken = await login("admin@caleo.com");
  await app.inject({
    method: "POST",
    url: "/api/invitations",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { email: "carol@caleo.com" },
  });
  const token = tokenFromUrl(inviteMails[0].inviteUrl);
  const res = await app.inject({
    method: "POST",
    url: "/api/invitations/register",
    payload: {
      token,
      display_name: "Carol",
      logo_url: "/logos/fox-clean.png",
      github_credential: { type: "token", value: "ghp_secret" },
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.ok(body.session_token);
  assert.equal(body.employee.email, "carol@caleo.com");
  assert.equal(body.employee.role, "member");
  assert.equal(body.employee.display_name, "Carol");

  const credential = await registry.getGithubCredential("carol@caleo.com");
  assert.deepEqual(credential, { type: "token", value: "ghp_secret" });

  const me = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: { authorization: `Bearer ${body.session_token}` },
  });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().email, "carol@caleo.com");
});

test("POST /api/invitations/register returns 401 for an invalid token", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/invitations/register",
    payload: { token: "garbage", display_name: "Carol" },
  });
  assert.equal(res.statusCode, 401);
});

test("POST /api/invitations/register returns 409 when the email became an employee meanwhile", async () => {
  const sessionToken = await login("admin@caleo.com");
  await app.inject({
    method: "POST",
    url: "/api/invitations",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { email: "carol@caleo.com" },
  });
  const token = tokenFromUrl(inviteMails[0].inviteUrl);
  await registry.create({ email: "carol@caleo.com", display_name: "Taken" });
  const res = await app.inject({
    method: "POST",
    url: "/api/invitations/register",
    payload: { token, display_name: "Carol" },
  });
  assert.equal(res.statusCode, 409);
});

test("POST /api/invitations/register validates the github credential", async () => {
  const sessionToken = await login("admin@caleo.com");
  await app.inject({
    method: "POST",
    url: "/api/invitations",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: { email: "carol@caleo.com" },
  });
  const token = tokenFromUrl(inviteMails[0].inviteUrl);
  const res = await app.inject({
    method: "POST",
    url: "/api/invitations/register",
    payload: { token, display_name: "Carol", github_credential: { type: "token", value: "" } },
  });
  assert.equal(res.statusCode, 400);
});
