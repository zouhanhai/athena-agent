import { describe, expect, it, vi, afterEach } from "vitest";

import {
  fetchBranches,
  fetchCommits,
  fetchFileContent,
  fetchIssues,
  fetchRepos,
  fetchTree,
} from "@/api/github";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function stubFetch(response: Response) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function fetchMock(): ReturnType<typeof vi.fn> {
  return fetch as unknown as ReturnType<typeof vi.fn>;
}

describe("fetchRepos", () => {
  it("GETs /api/github/repos with the Bearer token and returns repos", async () => {
    const repos = [{ name: "athena-agent", full_name: "zouhanhai/athena-agent", default_branch: "master" }];
    stubFetch(jsonResponse({ repos }));
    const result = await fetchRepos("tok_1");
    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/github/repos");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok_1");
    expect(result).toEqual(repos);
  });

  it("throws the server error message on a non-ok response", async () => {
    stubFetch(jsonResponse({ error: "no github credential registered" }, 400));
    await expect(fetchRepos("tok_1")).rejects.toThrow("no github credential registered");
  });
});

describe("fetchBranches", () => {
  it("GETs the branches endpoint for owner/repo", async () => {
    const branches = [{ name: "master", sha: "b000", protected: true }];
    stubFetch(jsonResponse({ branches }));
    const result = await fetchBranches("tok_1", "acme", "box");
    const [url] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/github/repos/acme/box/branches");
    expect(result).toEqual(branches);
  });
});

describe("fetchTree", () => {
  it("GETs the tree endpoint without a ref when omitted", async () => {
    const tree = [{ path: "README.md", type: "blob", mode: "100644", sha: "aaaa", size: 12 }];
    stubFetch(jsonResponse({ tree }));
    const result = await fetchTree("tok_1", "acme", "box");
    const [url] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/github/repos/acme/box/tree");
    expect(result).toEqual(tree);
  });

  it("appends the ref query param when provided", async () => {
    stubFetch(jsonResponse({ tree: [] }));
    await fetchTree("tok_1", "acme", "box", "feature");
    const [url] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/github/repos/acme/box/tree?ref=feature");
  });
});

describe("fetchFileContent", () => {
  it("GETs the content endpoint with path and ref", async () => {
    const file = { path: "server/src/index.ts", sha: "cccc", size: 120, content: "const x = 1;\n" };
    stubFetch(jsonResponse(file));
    const result = await fetchFileContent("tok_1", "acme", "box", "server/src/index.ts", "master");
    const [url] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/api/github/repos/acme/box/content?path=server%2Fsrc%2Findex.ts&ref=master",
    );
    expect(result).toEqual(file);
  });

  it("omits the ref query param when not provided", async () => {
    stubFetch(jsonResponse({ path: "README.md", sha: "aaaa", size: 12, content: "hi" }));
    await fetchFileContent("tok_1", "acme", "box", "README.md");
    const [url] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/github/repos/acme/box/content?path=README.md");
  });
});

describe("fetchIssues", () => {
  it("GETs the issues endpoint for owner/repo with the default open state", async () => {
    const issues = [
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
    stubFetch(jsonResponse({ issues }));
    const result = await fetchIssues("tok_1", "acme", "box");
    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/github/repos/acme/box/issues?state=open");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok_1");
    expect(result).toEqual(issues);
  });

  it("passes a custom state filter through", async () => {
    stubFetch(jsonResponse({ issues: [] }));
    await fetchIssues("tok_1", "acme", "box", "closed");
    const [url] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/github/repos/acme/box/issues?state=closed");
  });
});

describe("fetchCommits", () => {
  it("GETs the commits endpoint with the ref and returns commits", async () => {
    const commits = [
      {
        sha: "c111111111111111111111111111111111111111",
        message: "Fix login bug",
        author_name: "Alice",
        author_email: "alice@acme.com",
        date: "2026-08-01T10:00:00Z",
        html_url: "https://github.com/acme/box/commit/c111",
      },
    ];
    stubFetch(jsonResponse({ commits }));
    const result = await fetchCommits("tok_1", "acme", "box", "feature");
    const [url] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/github/repos/acme/box/commits?ref=feature");
    expect(result).toEqual(commits);
  });

  it("omits the ref query param when not provided", async () => {
    stubFetch(jsonResponse({ commits: [] }));
    await fetchCommits("tok_1", "acme", "box");
    const [url] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/github/repos/acme/box/commits");
  });
});
