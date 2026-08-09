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
import type {
  EditFileInput,
  GitHubApi,
  GithubBranch,
  GithubCommit,
  GithubCommitEntry,
  GithubFileContent,
  GithubIssue,
  GithubMergeResult,
  GithubPull,
  GithubRepo,
  GithubTreeEntry,
  OpenPullInput,
} from "../src/github/client.js";
import { MemoryGithubOpStore } from "../src/github/ops.js";

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
  readonly calls: { method: string; credential: GithubCredential; args: unknown[] }[] = [];
  constructor(private readonly repos: GithubRepo[] = []) {}
  private record(method: string, credential: GithubCredential, args: unknown[]): void {
    this.calls.push({ method, credential, args });
  }
  async listRepos(credential: GithubCredential): Promise<GithubRepo[]> {
    this.record("listRepos", credential, []);
    return this.repos;
  }
  async listTree(credential: GithubCredential, owner: string, repo: string, ref?: string): Promise<GithubTreeEntry[]> {
    this.record("listTree", credential, [owner, repo, ref]);
    return TREE_SAMPLE;
  }
  async listBranches(credential: GithubCredential, owner: string, repo: string): Promise<GithubBranch[]> {
    this.record("listBranches", credential, [owner, repo]);
    return BRANCH_SAMPLE;
  }
  async getFileContent(
    credential: GithubCredential,
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<GithubFileContent> {
    this.record("getFileContent", credential, [owner, repo, path, ref]);
    return { path, sha: "cccc", size: 120, content: "const x = 1;\n" };
  }
  async listPulls(credential: GithubCredential, owner: string, repo: string): Promise<GithubPull[]> {
    this.record("listPulls", credential, [owner, repo]);
    return PULL_SAMPLE;
  }
  async listIssues(credential: GithubCredential, owner: string, repo: string, state?: string): Promise<GithubIssue[]> {
    this.record("listIssues", credential, [owner, repo, state]);
    return ISSUE_SAMPLE;
  }
  async listCommits(
    credential: GithubCredential,
    owner: string,
    repo: string,
    opts?: { ref?: string; perPage?: number },
  ): Promise<GithubCommitEntry[]> {
    this.record("listCommits", credential, [owner, repo, opts]);
    return COMMIT_SAMPLE;
  }
  async openPull(
    credential: GithubCredential,
    owner: string,
    repo: string,
    input: OpenPullInput,
  ): Promise<GithubPull> {
    this.record("openPull", credential, [owner, repo, input]);
    return PULL_SAMPLE[0];
  }
  async editFile(
    credential: GithubCredential,
    owner: string,
    repo: string,
    path: string,
    input: EditFileInput,
  ): Promise<GithubCommit> {
    this.record("editFile", credential, [owner, repo, path, input]);
    return { sha: "c000", html_url: "https://github.com/acme/box/commit/c000", message: input.message };
  }
  async mergePull(
    credential: GithubCredential,
    owner: string,
    repo: string,
    number: number,
  ): Promise<GithubMergeResult> {
    this.record("mergePull", credential, [owner, repo, number]);
    return { merged: true, message: "merged", sha: "m000" };
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

const TREE_SAMPLE: GithubTreeEntry[] = [
  { path: "README.md", type: "blob", mode: "100644", sha: "aaaa", size: 12 },
  { path: "server/src/index.ts", type: "blob", mode: "100644", sha: "cccc", size: 120 },
];

const BRANCH_SAMPLE: GithubBranch[] = [
  { name: "feature", sha: "f000000000000000000000000000000000000000", protected: false },
  { name: "master", sha: "b000000000000000000000000000000000000000", protected: true },
];

const PULL_SAMPLE: GithubPull[] = [
  {
    number: 7,
    title: "Add feature",
    state: "open",
    html_url: "https://github.com/acme/box/pull/7",
    head_ref: "feature",
    base_ref: "master",
    user_login: "alice",
    body: "Closes #1",
  },
];

const ISSUE_SAMPLE: GithubIssue[] = [
  {
    number: 2,
    title: "Bug",
    state: "open",
    html_url: "https://github.com/acme/box/issues/2",
    user_login: "bob",
    body: "Details",
    labels: ["bug"],
    assignees: ["alice"],
  },
];

const COMMIT_SAMPLE: GithubCommitEntry[] = [
  {
    sha: "c111111111111111111111111111111111111111",
    message: "Fix login bug",
    author_name: "Alice",
    author_email: "alice@acme.com",
    date: "2026-08-01T10:00:00Z",
    html_url: "https://github.com/acme/box/commit/c111",
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
  app = buildApp({ employees: registry, auth, github, ops: new MemoryGithubOpStore() });
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
  assert.equal(github.calls[0]?.credential.value, "ghp_adminnew", "the registered credential must be used");
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
  assert.equal(github.calls[0].credential.value, "ghp_alice");
  assert.equal(github.calls[1].credential.value, "ghp_bob");
});

test("GET /api/github/repos never exposes the credential itself", async () => {
  const aliceToken = await login("alice@caleo.com");
  const res = await app.inject({ method: "GET", url: "/api/github/repos", headers: bearer(aliceToken) });
  const body = res.json();
  assert.ok(!JSON.stringify(body).includes("ghp_alice"));
});

test("GET /api/github/repos/:owner/:repo/tree requires auth", async () => {
  const res = await app.inject({ method: "GET", url: "/api/github/repos/acme/box/tree?ref=master" });
  assert.equal(res.statusCode, 401);
});

test("GET /api/github/repos/:owner/:repo/tree returns 400 when the user has no credential", async () => {
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/github/repos/acme/box/tree",
    headers: bearer(sessionToken),
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /no github credential/i);
});

test("GET /api/github/repos/:owner/:repo/tree validates owner and repo", async () => {
  const aliceToken = await login("alice@caleo.com");
  const res = await app.inject({ method: "GET", url: "/api/github/repos//box/tree", headers: bearer(aliceToken) });
  assert.equal(res.statusCode, 400);
});

test("GET /api/github/repos/:owner/:repo/tree returns the tree scoped to the user's credential", async () => {
  const aliceToken = await login("alice@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/github/repos/acme/box/tree?ref=feature",
    headers: bearer(aliceToken),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().tree, TREE_SAMPLE);
  const call = github.calls.at(-1);
  assert.equal(call?.method, "listTree");
  assert.equal(call?.credential.value, "ghp_alice");
  assert.deepEqual(call?.args, ["acme", "box", "feature"]);
});

test("GET /api/github/repos/:owner/:repo/branches returns branches scoped to the user's credential", async () => {
  const aliceToken = await login("alice@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/github/repos/acme/box/branches",
    headers: bearer(aliceToken),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().branches, BRANCH_SAMPLE);
  const call = github.calls.at(-1);
  assert.equal(call?.method, "listBranches");
  assert.equal(call?.credential.value, "ghp_alice");
  assert.deepEqual(call?.args, ["acme", "box"]);
});

test("GET /api/github/repos/:owner/:repo/branches requires authentication", async () => {
  const res = await app.inject({ method: "GET", url: "/api/github/repos/acme/box/branches" });
  assert.equal(res.statusCode, 401);
});

test("GET /api/github/repos/:owner/:repo/content returns file text scoped to the user's credential", async () => {
  const aliceToken = await login("alice@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/github/repos/acme/box/content?path=server/src/index.ts&ref=feature",
    headers: bearer(aliceToken),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().content, "const x = 1;\n");
  assert.equal(res.json().path, "server/src/index.ts");
  const call = github.calls.at(-1);
  assert.equal(call?.method, "getFileContent");
  assert.equal(call?.credential.value, "ghp_alice");
  assert.deepEqual(call?.args, ["acme", "box", "server/src/index.ts", "feature"]);
});

test("GET /api/github/repos/:owner/:repo/content requires a path param", async () => {
  const aliceToken = await login("alice@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/github/repos/acme/box/content",
    headers: bearer(aliceToken),
  });
  assert.equal(res.statusCode, 400);
});

test("GET /api/github/repos/:owner/:repo/content requires authentication", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/github/repos/acme/box/content?path=README.md",
  });
  assert.equal(res.statusCode, 401);
});

test("GET /api/github/repos/:owner/:repo/pulls returns PRs scoped to the user's credential", async () => {
  const aliceToken = await login("alice@caleo.com");
  const res = await app.inject({ method: "GET", url: "/api/github/repos/acme/box/pulls", headers: bearer(aliceToken) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().pulls, PULL_SAMPLE);
  assert.equal(github.calls.at(-1)?.credential.value, "ghp_alice");
});

test("GET /api/github/repos/:owner/:repo/issues returns issues scoped to the user's credential", async () => {
  const bobToken = await login("bob@caleo.com");
  const res = await app.inject({ method: "GET", url: "/api/github/repos/acme/box/issues", headers: bearer(bobToken) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().issues, ISSUE_SAMPLE);
  const call = github.calls.at(-1);
  assert.equal(call?.method, "listIssues");
  assert.equal(call?.credential.value, "ghp_bob");
  assert.deepEqual(call?.args, ["acme", "box", "open"]);
});

test("GET /api/github/repos/:owner/:repo/issues passes the state filter through", async () => {
  const aliceToken = await login("alice@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/github/repos/acme/box/issues?state=closed",
    headers: bearer(aliceToken),
  });
  assert.equal(res.statusCode, 200);
  const call = github.calls.at(-1);
  assert.equal(call?.method, "listIssues");
  assert.deepEqual(call?.args, ["acme", "box", "closed"]);
});

test("GET /api/github/repos/:owner/:repo/issues requires authentication", async () => {
  const res = await app.inject({ method: "GET", url: "/api/github/repos/acme/box/issues" });
  assert.equal(res.statusCode, 401);
});

test("GET /api/github/repos/:owner/:repo/commits returns commits scoped to the user's credential", async () => {
  const aliceToken = await login("alice@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/github/repos/acme/box/commits?ref=feature",
    headers: bearer(aliceToken),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().commits, COMMIT_SAMPLE);
  const call = github.calls.at(-1);
  assert.equal(call?.method, "listCommits");
  assert.equal(call?.credential.value, "ghp_alice");
  assert.deepEqual(call?.args, ["acme", "box", { ref: "feature" }]);
});

test("GET /api/github/repos/:owner/:repo/commits without a ref passes no ref option", async () => {
  const aliceToken = await login("alice@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/github/repos/acme/box/commits",
    headers: bearer(aliceToken),
  });
  assert.equal(res.statusCode, 200);
  const call = github.calls.at(-1);
  assert.equal(call?.method, "listCommits");
  assert.deepEqual(call?.args, ["acme", "box", { ref: undefined }]);
});

test("GET /api/github/repos/:owner/:repo/commits validates owner and repo", async () => {
  const aliceToken = await login("alice@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/github/repos//box/commits",
    headers: bearer(aliceToken),
  });
  assert.equal(res.statusCode, 400);
});

test("GET /api/github/repos/:owner/:repo/commits requires authentication", async () => {
  const res = await app.inject({ method: "GET", url: "/api/github/repos/acme/box/commits" });
  assert.equal(res.statusCode, 401);
});

async function requestOpenPull(token: string, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/api/github/ops",
    headers: bearer(token),
    payload: { op: "open_pull", owner: "acme", repo: "box", title: "Add feature", head: "feature", base: "master", ...extra },
  });
}

test("POST /api/github/ops creates a pending op without touching GitHub", async () => {
  const aliceToken = await login("alice@caleo.com");
  const before = github.calls.length;
  const res = await app.inject({
    method: "POST",
    url: "/api/github/ops",
    headers: bearer(aliceToken),
    payload: { op: "open_pull", owner: "acme", repo: "box", title: "Add feature", head: "feature", base: "master" },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.ok(body.op_id);
  assert.equal(body.status, "pending");
  assert.equal(body.kind, "open_pull");
  assert.match(body.summary, /Add feature/);
  assert.equal(github.calls.length, before, "no GitHub mutation happens at op creation");
});

test("POST /api/github/ops requires auth", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/github/ops",
    payload: { op: "open_pull", owner: "acme", repo: "box", title: "t", head: "h", base: "b" },
  });
  assert.equal(res.statusCode, 401);
});

test("POST /api/github/ops rejects an unknown op kind", async () => {
  const aliceToken = await login("alice@caleo.com");
  const res = await app.inject({
    method: "POST",
    url: "/api/github/ops",
    headers: bearer(aliceToken),
    payload: { op: "delete_repo", owner: "acme", repo: "box" },
  });
  assert.equal(res.statusCode, 400);
});

test("POST /api/github/ops validates required params per kind", async () => {
  const aliceToken = await login("alice@caleo.com");
  const missingHead = await requestOpenPull(aliceToken, { head: undefined });
  assert.equal(missingHead.statusCode, 400);
  const badMerge = await app.inject({
    method: "POST",
    url: "/api/github/ops",
    headers: bearer(aliceToken),
    payload: { op: "merge_pull", owner: "acme", repo: "box", number: "seven" },
  });
  assert.equal(badMerge.statusCode, 400);
});

test("GET /api/github/ops/:id returns the pending op to its owner", async () => {
  const aliceToken = await login("alice@caleo.com");
  const created = await requestOpenPull(aliceToken);
  const opId = created.json().op_id;
  const res = await app.inject({ method: "GET", url: `/api/github/ops/${opId}`, headers: bearer(aliceToken) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().op_id, opId);
  assert.equal(res.json().kind, "open_pull");
  assert.equal(res.json().status, "pending");
});

test("GET /api/github/ops/:id is scoped to the owning employee", async () => {
  const aliceToken = await login("alice@caleo.com");
  const bobToken = await login("bob@caleo.com");
  const opId = (await requestOpenPull(aliceToken)).json().op_id;
  const bobRes = await app.inject({ method: "GET", url: `/api/github/ops/${opId}`, headers: bearer(bobToken) });
  assert.equal(bobRes.statusCode, 403);
});

test("GET /api/github/ops/:id returns 404 for an unknown op", async () => {
  const aliceToken = await login("alice@caleo.com");
  const res = await app.inject({ method: "GET", url: "/api/github/ops/nope", headers: bearer(aliceToken) });
  assert.equal(res.statusCode, 404);
});

test("confirm flow executes open_pull with the user's credential and returns the result", async () => {
  const aliceToken = await login("alice@caleo.com");
  const opId = (await requestOpenPull(aliceToken)).json().op_id;
  const res = await app.inject({
    method: "POST",
    url: `/api/github/ops/${opId}/confirm`,
    headers: bearer(aliceToken),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, "executed");
  assert.equal(res.json().result.number, 7);
  const call = github.calls.at(-1);
  assert.equal(call?.method, "openPull");
  assert.equal(call?.credential.value, "ghp_alice");
  assert.deepEqual(call?.args, ["acme", "box", { title: "Add feature", head: "feature", base: "master" }]);
});

test("confirmed ops are consumed: a second confirm returns 404", async () => {
  const aliceToken = await login("alice@caleo.com");
  const opId = (await requestOpenPull(aliceToken)).json().op_id;
  await app.inject({ method: "POST", url: `/api/github/ops/${opId}/confirm`, headers: bearer(aliceToken) });
  const res = await app.inject({ method: "POST", url: `/api/github/ops/${opId}/confirm`, headers: bearer(aliceToken) });
  assert.equal(res.statusCode, 404);
});

test("confirm requires the owning employee", async () => {
  const aliceToken = await login("alice@caleo.com");
  const bobToken = await login("bob@caleo.com");
  const opId = (await requestOpenPull(aliceToken)).json().op_id;
  const res = await app.inject({ method: "POST", url: `/api/github/ops/${opId}/confirm`, headers: bearer(bobToken) });
  assert.equal(res.statusCode, 403);
  assert.equal(github.calls.length, 0, "no GitHub call for a non-owner confirm");
});

test("confirm of an unknown op returns 404", async () => {
  const aliceToken = await login("alice@caleo.com");
  const res = await app.inject({ method: "POST", url: "/api/github/ops/nope/confirm", headers: bearer(aliceToken) });
  assert.equal(res.statusCode, 404);
});

test("confirm edit_file executes PUT contents via the user's credential", async () => {
  const aliceToken = await login("alice@caleo.com");
  const created = await app.inject({
    method: "POST",
    url: "/api/github/ops",
    headers: bearer(aliceToken),
    payload: {
      op: "edit_file",
      owner: "acme",
      repo: "box",
      path: "README.md",
      message: "Update README",
      content: Buffer.from("hello").toString("base64"),
      branch: "master",
      sha: "oldsha",
    },
  });
  const opId = created.json().op_id;
  const res = await app.inject({ method: "POST", url: `/api/github/ops/${opId}/confirm`, headers: bearer(aliceToken) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().result.sha, "c000");
  const call = github.calls.at(-1);
  assert.equal(call?.method, "editFile");
  assert.deepEqual(call?.args, [
    "acme",
    "box",
    "README.md",
    {
      message: "Update README",
      content: Buffer.from("hello").toString("base64"),
      branch: "master",
      sha: "oldsha",
    },
  ]);
});

test("confirm merge_pull executes the merge via the user's credential", async () => {
  const bobToken = await login("bob@caleo.com");
  const created = await app.inject({
    method: "POST",
    url: "/api/github/ops",
    headers: bearer(bobToken),
    payload: { op: "merge_pull", owner: "acme", repo: "box", number: 7 },
  });
  const opId = created.json().op_id;
  const res = await app.inject({ method: "POST", url: `/api/github/ops/${opId}/confirm`, headers: bearer(bobToken) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().result.merged, true);
  assert.equal(github.calls.at(-1)?.method, "mergePull");
  assert.equal(github.calls.at(-1)?.credential.value, "ghp_bob");
});

test("DELETE /api/github/ops/:id cancels a pending op without executing it", async () => {
  const aliceToken = await login("alice@caleo.com");
  const opId = (await requestOpenPull(aliceToken)).json().op_id;
  const res = await app.inject({ method: "DELETE", url: `/api/github/ops/${opId}`, headers: bearer(aliceToken) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { cancelled: true });
  assert.equal(github.calls.length, 0, "cancel never calls GitHub");
  const confirmRes = await app.inject({
    method: "POST",
    url: `/api/github/ops/${opId}/confirm`,
    headers: bearer(aliceToken),
  });
  assert.equal(confirmRes.statusCode, 404);
});

test("DELETE /api/github/ops/:id is scoped to the owner", async () => {
  const aliceToken = await login("alice@caleo.com");
  const bobToken = await login("bob@caleo.com");
  const opId = (await requestOpenPull(aliceToken)).json().op_id;
  const res = await app.inject({ method: "DELETE", url: `/api/github/ops/${opId}`, headers: bearer(bobToken) });
  assert.equal(res.statusCode, 403);
});
