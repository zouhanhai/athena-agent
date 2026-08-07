import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  MemoryEmployeeRegistry,
  PostgresEmployeeRegistry,
} from "../src/employees/employees.js";
import {
  MagicLinkAuthService,
  MemoryAuthTokenStore,
  PostgresAuthTokenStore,
  ResendMailer,
  type MagicLinkMailer,
} from "../src/employees/auth.js";

function tokenFromUrl(url: string): string {
  const match = /[?&]token=([^&]+)/.exec(url);
  assert.ok(match, `magic link should carry a token: ${url}`);
  return decodeURIComponent(match[1]);
}

interface SentMail {
  to: string;
  magicLinkUrl: string;
}

function makeFakeMailer(sent: SentMail[]): MagicLinkMailer {
  return {
    async sendLoginLink(input) {
      sent.push({ to: input.to, magicLinkUrl: input.magicLinkUrl });
    },
  };
}

async function makeAuth(sent: SentMail[] = []) {
  const registry = new MemoryEmployeeRegistry([
    { email: "alice@example.com", display_name: "Alice", role: "admin" },
  ]);
  const mailer = makeFakeMailer(sent);
  const auth = new MagicLinkAuthService({
    registry,
    mailer,
    tokens: new MemoryAuthTokenStore(),
    appBaseUrl: "https://portal.example.com",
  });
  return { registry, auth, mailer };
}

test("requestLogin emails a magic link to a known employee", async () => {
  const sent: SentMail[] = [];
  const { auth } = await makeAuth(sent);
  const result = await auth.requestLogin("alice@example.com");
  assert.deepEqual(result, { ok: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "alice@example.com");
  assert.match(sent[0].magicLinkUrl, /^https:\/\/portal\.example\.com\//);
});

test("requestLogin does not leak existence for unknown emails and sends no mail", async () => {
  const sent: SentMail[] = [];
  const { auth } = await makeAuth(sent);
  const result = await auth.requestLogin("ghost@example.com");
  assert.deepEqual(result, { ok: true });
  assert.equal(sent.length, 0);
});

test("requestLogin trims and lowercases the email", async () => {
  const sent: SentMail[] = [];
  const { auth } = await makeAuth(sent);
  await auth.requestLogin("  ALICE@Example.com  ");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "alice@example.com");
});

test("verifyLogin exchanges a valid token for a session token + employee", async () => {
  const sent: SentMail[] = [];
  const { auth } = await makeAuth(sent);
  await auth.requestLogin("alice@example.com");
  const token = tokenFromUrl(sent[0].magicLinkUrl);
  const result = await auth.verifyLogin(token);
  assert.ok(result, "should resolve the login token");
  assert.ok(result!.session_token, "should mint a session token");
  assert.equal(result!.employee.email, "alice@example.com");
  assert.equal(result!.employee.role, "admin");

  const employee = await auth.getEmployeeForSession(result!.session_token);
  assert.equal(employee?.email, "alice@example.com");
});

test("verifyLogin tokens are single-use", async () => {
  const sent: SentMail[] = [];
  const { auth } = await makeAuth(sent);
  await auth.requestLogin("alice@example.com");
  const token = tokenFromUrl(sent[0].magicLinkUrl);
  assert.ok(await auth.verifyLogin(token));
  assert.equal(await auth.verifyLogin(token), null, "a consumed token must not verify twice");
});

test("verifyLogin returns null for an unknown or garbage token", async () => {
  const { auth } = await makeAuth();
  assert.equal(await auth.verifyLogin("garbage-token"), null);
});

test("getEmployeeForSession returns null for an unknown session token", async () => {
  const { auth } = await makeAuth();
  assert.equal(await auth.getEmployeeForSession("no-such-session"), null);
});

test("ResendMailer posts to the Resend API with the bearer key and payload", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ id: "mail_123" }), { status: 200 });
  }) as typeof fetch;

  const mailer = new ResendMailer({
    apiKey: "re_test_key",
    from: "Athena <noreply@caleo.com>",
    fetchImpl,
  });
  await mailer.sendLoginLink({ to: "alice@example.com", magicLinkUrl: "https://x.dev/?token=abc" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer re_test_key");
  const body = JSON.parse(calls[0].init.body as string);
  assert.equal(body.from, "Athena <noreply@caleo.com>");
  assert.deepEqual(body.to, ["alice@example.com"]);
  assert.match(body.html, /https:\/\/x\.dev\/\?token=abc/);
});

test("ResendMailer throws when the Resend API returns an error", async () => {
  const fetchImpl = (async () => {
    return new Response(JSON.stringify({ message: "invalid api key" }), { status: 401 });
  }) as typeof fetch;
  const mailer = new ResendMailer({ apiKey: "re_bad", fetchImpl });
  await assert.rejects(
    mailer.sendLoginLink({ to: "a@b.com", magicLinkUrl: "https://x.dev" }),
    /invalid api key/,
  );
});

let pgAuthService: MagicLinkAuthService | null = null;
let pgTokens: PostgresAuthTokenStore | null = null;
let pgEmployees: PostgresEmployeeRegistry | null = null;

async function initPgAuth(): Promise<MagicLinkAuthService | null> {
  if (pgAuthService) {
    return pgAuthService;
  }
  const connectionString =
    process.env.TEST_DATABASE_URL ?? "postgres://hh@/athena_test?host=/var/run/postgresql";
  try {
    pgEmployees = new PostgresEmployeeRegistry({ connectionString });
    await pgEmployees.seed();
    pgTokens = new PostgresAuthTokenStore({ connectionString });
    const email = `pg-auth-${Date.now()}@example.com`;
    await pgEmployees.create({ email, role: "admin" });
    const sent: SentMail[] = [];
    const mailer = makeFakeMailer(sent);
    pgAuthService = new MagicLinkAuthService({
      registry: pgEmployees,
      mailer,
      tokens: pgTokens,
      appBaseUrl: "http://localhost:5173",
    });
    return pgAuthService;
  } catch (err) {
    console.error("PG auth integration skipped:", err instanceof Error ? err.message : err);
    pgEmployees = null;
    pgTokens = null;
    return null;
  }
}

test(
  "Postgres auth: full magic-link login flow (integration)",
  async (t) => {
    const auth = await initPgAuth();
    if (!auth) {
      return t.skip("postgres not available");
    }
    const email = `pg-auth-${Date.now()}@example.com`;
    await pgEmployees!.create({ email, role: "member" });
    const sent: SentMail[] = [];
    const mailer = makeFakeMailer(sent);
    const local = new MagicLinkAuthService({
      registry: pgEmployees!,
      mailer,
      tokens: pgTokens!,
      appBaseUrl: "http://localhost:5173",
    });
    await local.requestLogin(email);
    assert.equal(sent.length, 1, "a magic link should be emailed");
    const token = tokenFromUrl(sent[0].magicLinkUrl);
    const verification = await local.verifyLogin(token);
    assert.ok(verification);
    assert.equal(verification!.employee.email, email);
    const employee = await local.getEmployeeForSession(verification!.session_token);
    assert.equal(employee?.email, email);
    assert.equal(await local.verifyLogin(token), null, "token must be single-use");
  },
);

after(async () => {
  if (pgAuthService) {
    await pgAuthService.close();
    pgAuthService = null;
  }
  if (pgEmployees) {
    await pgEmployees.close();
    pgEmployees = null;
  }
});
