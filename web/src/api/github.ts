/**
 * Frontend API layer for the per-user GitHub integration (G3.S6.T5 + G3.S4.T2).
 * Every call is scoped to the signed-in employee via their session token.
 */

export interface GithubRepo {
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  private: boolean;
  default_branch: string;
}

export interface GithubTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  mode: string;
  sha: string;
  size: number | null;
}

export interface GithubBranch {
  name: string;
  sha: string;
  protected: boolean;
}

export interface GithubFileContent {
  path: string;
  sha: string;
  size: number | null;
  content: string;
}

export interface GithubIssue {
  number: number;
  title: string;
  state: string;
  html_url: string;
  user_login: string | null;
  body: string | null;
  labels: string[];
  assignees: string[];
}

export interface GithubCommit {
  sha: string;
  message: string;
  author_name: string;
  author_email: string | null;
  date: string;
  html_url: string;
}

export type GithubIssueState = "open" | "closed" | "all";

async function request<T>(sessionToken: string, url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    const message =
      detail && typeof (detail as { error?: unknown }).error === "string"
        ? (detail as { error: string }).error
        : `Request failed with status ${res.status}`;
    throw new Error(message);
  }
  return (await res.json()) as T;
}

/** GET /api/github/repos → repos visible to the signed-in user's credential. */
export async function fetchRepos(sessionToken: string): Promise<GithubRepo[]> {
  const data = await request<{ repos: GithubRepo[] }>(sessionToken, "/api/github/repos");
  return data.repos;
}

/** GET /api/github/repos/:owner/:repo/branches → branches of a repo. */
export async function fetchBranches(
  sessionToken: string,
  owner: string,
  repo: string,
): Promise<GithubBranch[]> {
  const data = await request<{ branches: GithubBranch[] }>(
    sessionToken,
    `/api/github/repos/${owner}/${repo}/branches`,
  );
  return data.branches;
}

/** GET /api/github/repos/:owner/:repo/tree?ref=... → the repo's recursive git tree. */
export async function fetchTree(
  sessionToken: string,
  owner: string,
  repo: string,
  ref?: string,
): Promise<GithubTreeEntry[]> {
  const params = new URLSearchParams();
  if (ref) {
    params.set("ref", ref);
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const data = await request<{ tree: GithubTreeEntry[] }>(
    sessionToken,
    `/api/github/repos/${owner}/${repo}/tree${suffix}`,
  );
  return data.tree;
}

/** GET /api/github/repos/:owner/:repo/content?path=...&ref=... → a file's text. */
export async function fetchFileContent(
  sessionToken: string,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<GithubFileContent> {
  const params = new URLSearchParams({ path });
  if (ref) {
    params.set("ref", ref);
  }
  return request<GithubFileContent>(
    sessionToken,
    `/api/github/repos/${owner}/${repo}/content?${params.toString()}`,
  );
}

/** GET /api/github/repos/:owner/:repo/issues?state=... → issues of a repo. */
export async function fetchIssues(
  sessionToken: string,
  owner: string,
  repo: string,
  state: GithubIssueState = "open",
): Promise<GithubIssue[]> {
  const params = new URLSearchParams({ state });
  const data = await request<{ issues: GithubIssue[] }>(
    sessionToken,
    `/api/github/repos/${owner}/${repo}/issues?${params.toString()}`,
  );
  return data.issues;
}

/** GET /api/github/repos/:owner/:repo/commits?ref=... → recent commits of a repo/branch. */
export async function fetchCommits(
  sessionToken: string,
  owner: string,
  repo: string,
  ref?: string,
): Promise<GithubCommit[]> {
  const params = new URLSearchParams();
  if (ref) {
    params.set("ref", ref);
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const data = await request<{ commits: GithubCommit[] }>(
    sessionToken,
    `/api/github/repos/${owner}/${repo}/commits${suffix}`,
  );
  return data.commits;
}
