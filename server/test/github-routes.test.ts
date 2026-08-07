import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import {
  MagicLinkAuthService,
  MemoryAuthTokenStore,
  type MagicLinkMailer,
} from "../src/employees/auth.js";
import { createSecretCipher } from "../src/employees/crypto.js";
import { MemoryEmployeeRegistry, type GithubCredential } from "../src/employees/employees.js";
import type { GitHubApi, GithubRepo } from "../src/github/client.js";

const TEST_CIPHER = createSecretCipher("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");

interface SentMail {
  to: string;
  magicLinkUrl: string;
}

function tokenFromUrl(url: string): string {
  const match = /[?&]token=([^&]+)/.exec(url);
  assert.ok(match, `magic link should carry a token: ${url}`);
  return decodeURIComponent(match[1]);
}

class FakeGitHubApi implements GitHubApi {
  readonly calls: GithubCredential[] = [];
  constructor(private readonly repos: GithubRepo[] = []) {}
  async listRepos(credential: GithubCredential): Promise<GithubRepo[]> {
    this.calls.push(credential);
    return this.repos;
  }
}

let app: FastifyInstance;
let sent: SentMail[];
let registry: MemoryEmployeeRegistry;
let github: FakeGitHubApi;

const REPO_SAMPLE: GithubRepo[] = [
  {
    name: "athena-agent",
    full_name: "zouhanhai/athena-agent",
    html_url: "https://github.com/zouhanhai/athena-agent",
    description: "portal",
    private: false,
    default_branch: "master",
  },
];

beforeEach(async () => {
  sent = [];
  registry = new MemoryEmployeeRegistry(
    [
      { email: "alice@caleo.com", display_name: "Alice", role: "member", github_credential: { type: "token", value: "ghp_alice" } },
      { email: "bob@caleo.com", display_name: "Bob", role: "member", github_credential: { type: "token", value: "ghp_bob" } },
      { email: "admin@caleo.com", display_name: "Admin", role: "admin" },
    ],
    { cipher: TEST_CIPHER },
  );
  github = new FakeGitHubApi(REPO_SAMPLE);
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
  app = buildApp({ employees: registry, auth, github });
});

after(async () => {
  if (app) {
    await app.close();
  }
});

async function login(email: string): Promise<string> {
  await app.inject({ method: "POST", url: "/api/auth/login", payload: { email } });
  const token = tokenFromUrl(sent[sent.length - 1].magicLinkUrl);
  const res = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { token } });
  assert.equal(res.statusCode, 200);
  return (res.json() as { session_token: string }).session_token;
}

function bearer(sessionToken: string): Record<string, string> {
  return { authorization: `Bearer ${sessionToken}` };
}

test("POST /api/me/github-credential registers a credential for the signed-in user", async () => {
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "POST",
    url: "/api/me/github-credential",
    headers: bearer(sessionToken),
    payload: { type: "token", value: "ghp_adminnew" },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { has_credential: true, type: "token" });

  await app.inject({ method: "GET", url: "/api/github/repos", headers: bearer(sessionToken) });
  assert.equal(github.calls[0]?.value, "ghp_adminnew", "the registered credential must be used");
});

test("POST /api/me/github-credential requires authentication", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/me/github-credential",
    payload: { type: "token", value: "ghp_x" },
  });
  assert.equal(res.statusCode, 401);
});

test("POST /api/me/github-credential rejects an unknown type", async () => {
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "POST",
    url: "/api/me/github-credential",
    headers: bearer(sessionToken),
    payload: { type: "github_app", value: "ghp_x" },
  });
  assert.equal(res.statusCode, 400);
});

test("POST /api/me/github-credential rejects an empty value", async () => {
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "POST",
    url: "/api/me/github-credential",
    headers: bearer(sessionToken),
    payload: { type: "token", value: "   " },
  });
  assert.equal(res.statusCode, 400);
});

test("GET /api/github/repos requires authentication", async () => {
  const res = await app.inject({ method: "GET", url: "/api/github/repos" });
  assert.equal(res.statusCode, 401);
});

test("GET /api/github/repos returns 400 when the user has no credential", async () => {
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({ method: "GET", url: "/api/github/repos", headers: bearer(sessionToken) });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /no github credential/i);
});

test("GET /api/github/repos is scoped to the signed-in user's credential", async () => {
  const aliceToken = await login("alice@caleo.com");
  const bobToken = await login("bob@caleo.com");

  const aliceRes = await app.inject({ method: "GET", url: "/api/github/repos", headers: bearer(aliceToken) });
  assert.equal(aliceRes.statusCode, 200);
  assert.deepEqual(aliceRes.json().repos, REPO_SAMPLE);

  const bobRes = await app.inject({ method: "GET", url: "/api/github/repos", headers: bearer(bobToken) });
  assert.equal(bobRes.statusCode, 200);

  assert.equal(github.calls.length, 2);
  assert.equal(github.calls[0].value, "ghp_alice");
  assert.equal(github.calls[1].value, "ghp_bob");
});

test("GET /api/github/repos never exposes the credential itself", async () => {
  const aliceToken = await login("alice@caleo.com");
  const res = await app.inject({ method: "GET", url: "/api/github/repos", headers: bearer(aliceToken) });
  const body = res.json();
  assert.ok(!JSON.stringify(body).includes("ghp_alice"));
});
