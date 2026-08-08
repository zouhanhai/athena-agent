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

const TREE_BODY = {
  tree: [
    { path: "README.md", type: "blob", mode: "100644", sha: "aaaa", size: 12 },
    { path: "server/src", type: "tree", mode: "040000", sha: "bbbb", size: 0 },
    { path: "server/src/index.ts", type: "blob", mode: "100644", sha: "cccc", size: 120 },
  ],
};

test("listTree resolves the default branch then returns the recursive tree", async () => {
  const calls: string[] = [];
  const client = new GithubRestClient({
    baseUrl: "https://api.github.test",
    fetchImpl: mockFetch(async (url) => {
      calls.push(url);
      if (url.endsWith("/repos/acme/box")) {
        return { status: 200, body: { default_branch: "master" } };
      }
      if (url.includes("/git/ref/heads/master")) {
        return { status: 200, body: { object: { sha: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4" } } };
      }
      if (url.includes("/git/trees/a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4")) {
        return { status: 200, body: TREE_BODY };
      }
      return { status: 404, body: {} };
    }),
  });
  const tree = await client.listTree(tokenCredential, "acme", "box");
  assert.deepEqual(tree, [
    { path: "README.md", type: "blob", mode: "100644", sha: "aaaa", size: 12 },
    { path: "server/src", type: "tree", mode: "040000", sha: "bbbb", size: null },
    { path: "server/src/index.ts", type: "blob", mode: "100644", sha: "cccc", size: 120 },
  ]);
  assert.ok(calls.some((u) => u === "https://api.github.test/repos/acme/box"), "calls include default-branch repo lookup");
});

test("listTree with an explicit ref resolves heads and skips the default-branch lookup", async () => {
  const urls: string[] = [];
  const client = new GithubRestClient({
    baseUrl: "https://api.github.test",
    fetchImpl: mockFetch(async (url) => {
      urls.push(url);
      if (url.includes("/git/ref/heads/feature")) {
        return { status: 200, body: { object: { sha: "f000000000000000000000000000000000000000" } } };
      }
      if (url.includes("/git/trees/f000000000000000000000000000000000000000")) {
        return { status: 200, body: TREE_BODY };
      }
      return { status: 404, body: {} };
    }),
  });
  const tree = await client.listTree(tokenCredential, "acme", "box", "feature");
  assert.equal(tree.length, 3);
  assert.ok(urls.every((u) => !u.endsWith("/repos/acme/box")), "no default-branch lookup when ref given");
  assert.ok(urls.some((u) => u.includes("/git/ref/heads/feature")));
});

test("listTree falls back to a tag ref when the branch ref is missing", async () => {
  const client = new GithubRestClient({
    baseUrl: "https://api.github.test",
    fetchImpl: mockFetch(async (url) => {
      if (url.includes("/git/ref/heads/v1.0")) {
        return { status: 404, body: {} };
      }
      if (url.includes("/git/ref/tags/v1.0")) {
        return { status: 200, body: { object: { sha: "feeddadbeef00000000000000000000000000000" } } };
      }
      if (url.includes("/git/trees/feeddadbeef00000000000000000000000000000")) {
        return { status: 200, body: TREE_BODY };
      }
      return { status: 404, body: {} };
    }),
  });
  const tree = await client.listTree(tokenCredential, "acme", "box", "v1.0");
  assert.equal(tree.length, 3);
});

test("listTree rejects an ssh credential", async () => {
  const client = new GithubRestClient({ fetchImpl: mockFetch(async () => ({ status: 200, body: TREE_BODY })) });
  await assert.rejects(
    client.listTree({ type: "ssh", value: "ssh-ed25519 key" }, "acme", "box"),
    GithubCredentialUnsupportedError,
  );
});

const PR_BODY = {
  number: 7,
  title: "Add feature",
  state: "open",
  html_url: "https://github.com/acme/box/pull/7",
  head: { ref: "feature", sha: "f000" },
  base: { ref: "master", sha: "b000" },
  user: { login: "alice" },
  body: "Closes #1",
};

test("listPulls maps open PRs for the repo", async () => {
  let calledUrl = "";
  const client = new GithubRestClient({
    baseUrl: "https://api.github.test",
    fetchImpl: mockFetch(async (url) => {
      calledUrl = String(url);
      return { status: 200, body: [PR_BODY] };
    }),
  });
  const pulls = await client.listPulls(tokenCredential, "acme", "box");
  assert.match(calledUrl, /\/repos\/acme\/box\/pulls\?state=open/);
  assert.deepEqual(pulls, [
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
  ]);
});

const ISSUE_BODY = {
  number: 2,
  title: "Bug",
  state: "open",
  html_url: "https://github.com/acme/box/issues/2",
  user: { login: "bob" },
  body: "Details",
  labels: [{ name: "bug" }, { name: "p1" }],
  assignees: [{ login: "alice" }, { login: "carol" }],
};

test("listIssues maps open issues for the repo", async () => {
  let calledUrl = "";
  const client = new GithubRestClient({
    baseUrl: "https://api.github.test",
    fetchImpl: mockFetch(async (url) => {
      calledUrl = String(url);
      return { status: 200, body: [ISSUE_BODY] };
    }),
  });
  const issues = await client.listIssues(tokenCredential, "acme", "box");
  assert.match(calledUrl, /\/repos\/acme\/box\/issues\?state=open/);
  assert.deepEqual(issues, [
    {
      number: 2,
      title: "Bug",
      state: "open",
      html_url: "https://github.com/acme/box/issues/2",
      user_login: "bob",
      body: "Details",
      labels: ["bug", "p1"],
      assignees: ["alice", "carol"],
    },
  ]);
});

test("listIssues with state=closed requests closed issues", async () => {
  let calledUrl = "";
  const client = new GithubRestClient({
    baseUrl: "https://api.github.test",
    fetchImpl: mockFetch(async (url) => {
      calledUrl = String(url);
      return { status: 200, body: [{ ...ISSUE_BODY, state: "closed" }] };
    }),
  });
  const issues = await client.listIssues(tokenCredential, "acme", "box", "closed");
  assert.match(calledUrl, /\/repos\/acme\/box\/issues\?state=closed/);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].state, "closed");
});

test("listIssues with state=all requests both states", async () => {
  let calledUrl = "";
  const client = new GithubRestClient({
    baseUrl: "https://api.github.test",
    fetchImpl: mockFetch(async (url) => {
      calledUrl = String(url);
      return { status: 200, body: [] };
    }),
  });
  const issues = await client.listIssues(tokenCredential, "acme", "box", "all");
  assert.match(calledUrl, /\/repos\/acme\/box\/issues\?state=all/);
  assert.deepEqual(issues, []);
});

test("openPull POSTs the pull payload and maps the created PR", async () => {
  let calledUrl = "";
  let sentBody: unknown;
  const client = new GithubRestClient({
    baseUrl: "https://api.github.test",
    fetchImpl: mockFetch(async (url, init) => {
      calledUrl = String(url);
      sentBody = JSON.parse(String(init.body));
      return { status: 201, body: PR_BODY };
    }),
  });
  const pull = await client.openPull(tokenCredential, "acme", "box", {
    title: "Add feature",
    head: "feature",
    base: "master",
    body: "Closes #1",
  });
  assert.equal(calledUrl, "https://api.github.test/repos/acme/box/pulls");
  assert.deepEqual(sentBody, { title: "Add feature", head: "feature", base: "master", body: "Closes #1" });
  assert.equal(pull.number, 7);
  assert.equal(pull.head_ref, "feature");
});

test("editFile PUTs base64 contents to the file path", async () => {
  let calledUrl = "";
  let sentBody: unknown;
  const client = new GithubRestClient({
    baseUrl: "https://api.github.test",
    fetchImpl: mockFetch(async (url, init) => {
      calledUrl = String(url);
      sentBody = JSON.parse(String(init.body));
      return {
        status: 200,
        body: { sha: "c000", html_url: "https://github.com/acme/box/commit/c000", message: "Update README" },
      };
    }),
  });
  const commit = await client.editFile(tokenCredential, "acme", "box", "README.md", {
    message: "Update README",
    content: Buffer.from("hello").toString("base64"),
    branch: "master",
    sha: "oldsha",
  });
  assert.equal(calledUrl, "https://api.github.test/repos/acme/box/contents/README.md");
  assert.deepEqual(sentBody, {
    message: "Update README",
    content: Buffer.from("hello").toString("base64"),
    branch: "master",
    sha: "oldsha",
  });
  assert.equal(commit.sha, "c000");
});

test("mergePull PUTs to the PR merge endpoint and maps the result", async () => {
  let calledUrl = "";
  const client = new GithubRestClient({
    baseUrl: "https://api.github.test",
    fetchImpl: mockFetch(async (url) => {
      calledUrl = String(url);
      return { status: 200, body: { merged: true, message: "Pull Request successfully merged", sha: "m000" } };
    }),
  });
  const result = await client.mergePull(tokenCredential, "acme", "box", 7);
  assert.equal(calledUrl, "https://api.github.test/repos/acme/box/pulls/7/merge");
  assert.deepEqual(result, { merged: true, message: "Pull Request successfully merged", sha: "m000" });
});

test("openPull maps a 401 GitHub response to GithubAuthError", async () => {
  const client = new GithubRestClient({ fetchImpl: mockFetch(async () => ({ status: 401, body: {} })) });
  await assert.rejects(
    client.openPull(tokenCredential, "acme", "box", { title: "t", head: "h", base: "b" }),
    GithubAuthError,
  );
});

const BRANCH_BODY = [
  { name: "feature", protected: false, commit: { sha: "f000000000000000000000000000000000000000" } },
  { name: "master", protected: true, commit: { sha: "b000000000000000000000000000000000000000" } },
];

test("listBranches calls the branches endpoint and maps branch head shas", async () => {
  let calledUrl = "";
  const client = new GithubRestClient({
    baseUrl: "https://api.github.test",
    fetchImpl: mockFetch(async (url) => {
      calledUrl = String(url);
      return { status: 200, body: BRANCH_BODY };
    }),
  });
  const branches = await client.listBranches(tokenCredential, "acme", "box");
  assert.match(calledUrl, /\/repos\/acme\/box\/branches\?per_page=100/);
  assert.deepEqual(branches, [
    { name: "feature", sha: "f000000000000000000000000000000000000000", protected: false },
    { name: "master", sha: "b000000000000000000000000000000000000000", protected: true },
  ]);
});

test("listBranches rejects an ssh credential", async () => {
  const client = new GithubRestClient({ fetchImpl: mockFetch(async () => ({ status: 200, body: [] })) });
  await assert.rejects(
    client.listBranches({ type: "ssh", value: "ssh-ed25519 key" }, "acme", "box"),
    GithubCredentialUnsupportedError,
  );
});

const CONTENT_BODY = {
  name: "index.ts",
  path: "server/src/index.ts",
  sha: "cccc",
  size: 120,
  html_url: "https://github.com/acme/box/blob/master/server/src/index.ts",
  encoding: "base64",
  content: Buffer.from("const x = 1;\nconsole.log(x);\n").toString("base64"),
};

test("getFileContent fetches the contents API with a ref and decodes base64 to text", async () => {
  let calledUrl = "";
  const client = new GithubRestClient({
    baseUrl: "https://api.github.test",
    fetchImpl: mockFetch(async (url) => {
      calledUrl = String(url);
      return { status: 200, body: CONTENT_BODY };
    }),
  });
  const file = await client.getFileContent(tokenCredential, "acme", "box", "server/src/index.ts", "master");
  assert.match(calledUrl, /\/repos\/acme\/box\/contents\/server%2Fsrc%2Findex\.ts\?ref=master/);
  assert.equal(file.content, "const x = 1;\nconsole.log(x);\n");
  assert.equal(file.path, "server/src/index.ts");
  assert.equal(file.sha, "cccc");
});

test("getFileContent without a ref omits the query param", async () => {
  let calledUrl = "";
  const client = new GithubRestClient({
    baseUrl: "https://api.github.test",
    fetchImpl: mockFetch(async (url) => {
      calledUrl = String(url);
      return { status: 200, body: CONTENT_BODY };
    }),
  });
  const file = await client.getFileContent(tokenCredential, "acme", "box", "README.md");
  assert.equal(calledUrl, "https://api.github.test/repos/acme/box/contents/README.md");
  assert.equal(file.content, "const x = 1;\nconsole.log(x);\n");
});

test("getFileContent rejects an ssh credential", async () => {
  const client = new GithubRestClient({ fetchImpl: mockFetch(async () => ({ status: 200, body: {} })) });
  await assert.rejects(
    client.getFileContent({ type: "ssh", value: "ssh-ed25519 key" }, "acme", "box", "README.md"),
    GithubCredentialUnsupportedError,
  );
});
