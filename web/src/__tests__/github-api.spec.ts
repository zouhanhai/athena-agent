import { describe, expect, it, vi, afterEach } from "vitest";

import {
  addIssueComment,
  fetchBranches,
  fetchCommits,
  fetchFileContent,
  fetchIssueDetail,
  fetchIssues,
  fetchLabels,
  fetchRepos,
  fetchTree,
  updateIssue,
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

const ISSUE = {
  number: 2,
  title: "Bug",
  state: "open",
  html_url: "https://github.com/acme/box/issues/2",
  user_login: "bob",
  body: "Details",
  labels: ["bug"],
  assignees: ["alice"],
};

const COMMENT = {
  id: 100,
  user_login: "bob",
  body: "I'll take a look",
  created_at: "2026-08-01T10:00:00Z",
  html_url: "https://github.com/acme/box/issues/2#issuecomment-100",
};

describe("fetchIssueDetail", () => {
  it("GETs the issue detail endpoint and returns issue + comments", async () => {
    stubFetch(jsonResponse({ issue: ISSUE, comments: [COMMENT] }));
    const result = await fetchIssueDetail("tok_1", "acme", "box", 2);
    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/github/repos/acme/box/issues/2");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok_1");
    expect(result).toEqual({ issue: ISSUE, comments: [COMMENT] });
  });
});

describe("updateIssue", () => {
  it("PATCHes the issue endpoint with the update payload", async () => {
    stubFetch(jsonResponse({ issue: { ...ISSUE, title: "Bug (renamed)" } }));
    const result = await updateIssue("tok_1", "acme", "box", 2, {
      title: "Bug (renamed)",
      state: "closed",
      labels: ["bug"],
    });
    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/github/repos/acme/box/issues/2");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ title: "Bug (renamed)", state: "closed", labels: ["bug"] });
    expect(result.title).toBe("Bug (renamed)");
  });

  it("throws the server error message on a non-ok response", async () => {
    stubFetch(jsonResponse({ error: "nothing to update" }, 400));
    await expect(updateIssue("tok_1", "acme", "box", 2, {})).rejects.toThrow("nothing to update");
  });
});

describe("addIssueComment", () => {
  it("POSTs the comment body to the comments endpoint", async () => {
    stubFetch(jsonResponse({ comment: COMMENT }, 201));
    const result = await addIssueComment("tok_1", "acme", "box", 2, "I'll take a look");
    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/github/repos/acme/box/issues/2/comments");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ body: "I'll take a look" });
    expect(result).toEqual(COMMENT);
  });
});

describe("fetchLabels", () => {
  it("GETs the labels endpoint and returns label names", async () => {
    stubFetch(jsonResponse({ labels: ["bug", "p1"] }));
    const result = await fetchLabels("tok_1", "acme", "box");
    const [url] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/github/repos/acme/box/labels");
    expect(result).toEqual(["bug", "p1"]);
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
