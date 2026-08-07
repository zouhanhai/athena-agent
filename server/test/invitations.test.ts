import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createSecretCipher } from "../src/employees/crypto.js";
import { MagicLinkAuthService, MemoryAuthTokenStore } from "../src/employees/auth.js";
import {
  MemoryEmployeeRegistry,
  EmployeeConflictError,
} from "../src/employees/employees.js";
import {
  InvitationConflictError,
  InvitationInvalidError,
  InvitationService,
  MemoryInvitationStore,
  ResendInvitationMailer,
  type InvitationMailer,
} from "../src/employees/invitations.js";

interface SentInvite {
  to: string;
  inviteUrl: string;
}

function makeFakeMailer(sent: SentInvite[]): InvitationMailer {
  return {
    async sendInvitation(input) {
      sent.push({ to: input.to, inviteUrl: input.inviteUrl });
    },
  };
}

function tokenFromUrl(url: string): string {
  const match = /[?&]token=([^&]+)/.exec(url);
  assert.ok(match, `invite link should carry a token: ${url}`);
  return decodeURIComponent(match[1]);
}

const KEY = "d3d1e5d0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6";

let sent: SentInvite[];
let registry: MemoryEmployeeRegistry;
let invitations: InvitationService;
let tokens: MemoryAuthTokenStore;

async function makeInvitations() {
  sent = [];
  registry = new MemoryEmployeeRegistry(
    [{ email: "admin@caleo.com", display_name: "Admin", role: "admin" }],
    { cipher: createSecretCipher(KEY) },
  );
  tokens = new MemoryAuthTokenStore();
  invitations = new InvitationService({
    registry,
    tokens,
    store: new MemoryInvitationStore(),
    mailer: makeFakeMailer(sent),
    appBaseUrl: "https://portal.caleo.com",
  });
}

beforeEach(async () => {
  await makeInvitations();
});

test("invite emails a registration link carrying a single-use invite token", async () => {
  const result = await invitations.invite("carol@caleo.com");
  assert.deepEqual(result, { ok: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "carol@caleo.com");
  assert.match(sent[0].inviteUrl, /^https:\/\/portal\.caleo\.com\/register\?token=/);
  const token = tokenFromUrl(sent[0].inviteUrl);
  const resolution = await invitations.resolveInvitation(token);
  assert.deepEqual(resolution, { email: "carol@caleo.com" });
});

test("invite normalizes the email before sending", async () => {
  await invitations.invite("  CAROL@Caleo.COM  ");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "carol@caleo.com");
});

test("invite rejects an email that is already an employee and sends no mail", async () => {
  await assert.rejects(invitations.invite("admin@caleo.com"), InvitationConflictError);
  assert.equal(sent.length, 0);
});

test("resolveInvitation returns null for an unknown or expired token", async () => {
  assert.equal(await invitations.resolveInvitation("garbage-token"), null);
});

test("resolveInvitation does not consume the token", async () => {
  await invitations.invite("carol@caleo.com");
  const token = tokenFromUrl(sent[0].inviteUrl);
  await invitations.resolveInvitation(token);
  const resolution = await invitations.resolveInvitation(token);
  assert.deepEqual(resolution, { email: "carol@caleo.com" });
});

test("registerInvitedEmployee creates a member employee with encrypted github credential + session", async () => {
  await invitations.invite("carol@caleo.com");
  const token = tokenFromUrl(sent[0].inviteUrl);
  const { session_token, employee } = await invitations.registerInvitedEmployee(token, {
    display_name: "Carol",
    logo_url: "/logos/fox-teal.png",
    github_credential: { type: "token", value: "ghp_supersecret" },
  });
  assert.ok(session_token);
  assert.equal(employee.email, "carol@caleo.com");
  assert.equal(employee.role, "member");
  assert.equal(employee.display_name, "Carol");
  assert.equal(employee.logo_url, "/logos/fox-teal.png");

  const credential = await registry.getGithubCredential("carol@caleo.com");
  assert.deepEqual(credential, { type: "token", value: "ghp_supersecret" });

  const auth = new MagicLinkAuthService({
    registry,
    tokens,
    mailer: makeFakeMailer(sent),
    appBaseUrl: "https://portal.caleo.com",
  });
  assert.equal((await auth.getEmployeeForSession(session_token))?.email, "carol@caleo.com");
});

test("registerInvitedEmployee consumes the invite token (single-use)", async () => {
  await invitations.invite("carol@caleo.com");
  const token = tokenFromUrl(sent[0].inviteUrl);
  await invitations.registerInvitedEmployee(token, { display_name: "Carol" });
  await assert.rejects(
    invitations.registerInvitedEmployee(token, { display_name: "Again" }),
    InvitationInvalidError,
  );
});

test("registerInvitedEmployee rejects an invalid or expired token", async () => {
  await assert.rejects(
    invitations.registerInvitedEmployee("garbage", { display_name: "X" }),
    InvitationInvalidError,
  );
});

test("registerInvitedEmployee rejects when the invited email became an employee meanwhile", async () => {
  await invitations.invite("carol@caleo.com");
  const token = tokenFromUrl(sent[0].inviteUrl);
  await registry.create({ email: "carol@caleo.com", display_name: "Taken" });
  await assert.rejects(
    invitations.registerInvitedEmployee(token, { display_name: "Carol" }),
    EmployeeConflictError,
  );
});

test("ResendInvitationMailer posts to the Resend API with the invite payload", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ id: "mail_456" }), { status: 200 });
  }) as typeof fetch;

  const mailer = new ResendInvitationMailer({
    apiKey: "re_test_key",
    from: "Athena <noreply@caleo.com>",
    fetchImpl,
  });
  await mailer.sendInvitation({ to: "carol@caleo.com", inviteUrl: "https://x.dev/?token=abc" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer re_test_key");
  const body = JSON.parse(calls[0].init.body as string);
  assert.equal(body.from, "Athena <noreply@caleo.com>");
  assert.deepEqual(body.to, ["carol@caleo.com"]);
  assert.match(body.html, /https:\/\/x\.dev\/\?token=abc/);
  assert.match(body.subject, /invited to Athena/i);
});

test("ResendInvitationMailer throws when the Resend API returns an error", async () => {
  const fetchImpl = (async () => {
    return new Response(JSON.stringify({ message: "invalid api key" }), { status: 401 });
  }) as typeof fetch;
  const mailer = new ResendInvitationMailer({ apiKey: "re_bad", fetchImpl });
  await assert.rejects(
    mailer.sendInvitation({ to: "a@b.com", inviteUrl: "https://x.dev" }),
    /invalid api key/,
  );
});
