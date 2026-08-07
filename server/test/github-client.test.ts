import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GithubAuthError,
  GithubCredentialUnsupportedError,
  GithubRestClient,
} from "../src/github/client.js";

function mockFetch(
  handler: (url: string, init: RequestInit) => Promise<{ status: number; body: unknown }>,
): typeof fetch {
  return (async (input, init) => {
    const { status, body } = await handler(String(input), init ?? {});
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

const tokenCredential = { type: "token" as const, value: "ghp_testtoken" };

test("listRepos calls the GitHub REST endpoint with the token and maps repos", async () => {
  let called = false;
  const client = new GithubRestClient({
    baseUrl: "https://api.github.test",
    fetchImpl: mockFetch(async (url, init) => {
      called = true;
      assert.match(url, /^https:\/\/api\.github\.test\/user\/repos/);
      const headers = init.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer ghp_testtoken");
      assert.equal(headers.Accept, "application/vnd.github+json");
      assert.equal(headers["X-GitHub-Api-Version"], "2022-11-28");
      assert.ok(headers["User-Agent"]);
      return {
        status: 200,
        body: [
          { name: "athena-agent", full_name: "zouhanhai/athena-agent", html_url: "https://github.com/zouhanhai/athena-agent", description: "portal", private: false, default_branch: "master" },
        ],
      };
    }),
  });
  const repos = await client.listRepos(tokenCredential);
  assert.ok(called);
  assert.equal(repos.length, 1);
  assert.deepEqual(repos[0], {
    name: "athena-agent",
    full_name: "zouhanhai/athena-agent",
    html_url: "https://github.com/zouhanhai/athena-agent",
    description: "portal",
    private: false,
    default_branch: "master",
  });
});

test("listRepos rejects an ssh credential (REST needs a token)", async () => {
  const client = new GithubRestClient({ fetchImpl: mockFetch(async () => ({ status: 200, body: [] })) });
  await assert.rejects(
    client.listRepos({ type: "ssh", value: "ssh-ed25519 AAAA key" }),
    GithubCredentialUnsupportedError,
  );
});

test("listRepos maps a 401 GitHub response to GithubAuthError", async () => {
  const client = new GithubRestClient({ fetchImpl: mockFetch(async () => ({ status: 401, body: {} })) });
  await assert.rejects(client.listRepos(tokenCredential), GithubAuthError);
});

test("listRepos maps a 403 GitHub response to GithubAuthError", async () => {
  const client = new GithubRestClient({ fetchImpl: mockFetch(async () => ({ status: 403, body: {} })) });
  await assert.rejects(client.listRepos(tokenCredential), GithubAuthError);
});

test("listRepos maps other GitHub errors to a generic Error", async () => {
  const client = new GithubRestClient({ fetchImpl: mockFetch(async () => ({ status: 500, body: {} })) });
  await assert.rejects(client.listRepos(tokenCredential), /GitHub API error 500/);
});
