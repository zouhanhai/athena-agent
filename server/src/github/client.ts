import type { GithubCredential } from "../employees/employees.js";

/** A GitHub repository as returned to the scoped-repos API. */
export interface GithubRepo {
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  private: boolean;
  default_branch: string;
}

/** A single entry in a repo's recursive git tree. */
export interface GithubTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  mode: string;
  sha: string;
  size: number | null;
}

/** A branch of a repo, for the branch selector. */
export interface GithubBranch {
  name: string;
  sha: string;
  protected: boolean;
}

/** A file's contents as returned for the code view (decoded to UTF-8 text). */
export interface GithubFileContent {
  path: string;
  sha: string;
  size: number | null;
  content: string;
}

/** A pull request as returned to the browse API. */
export interface GithubPull {
  number: number;
  title: string;
  state: string;
  html_url: string;
  head_ref: string;
  base_ref: string;
  user_login: string | null;
  body: string | null;
}

/** An issue as returned to the browse API. */
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

/** A commit as returned to the browse API (message, author, date, sha). */
export interface GithubCommitEntry {
  sha: string;
  message: string;
  author_name: string;
  author_email: string | null;
  date: string;
  html_url: string;
}

/** Options for listing commits of a repo/branch. */
export interface ListCommitsOptions {
  /** Branch/tag/sha to list commits for (GitHub `sha` query param). */
  ref?: string;
  /** Max commits to fetch. Default: 30. */
  perPage?: number;
}

/** Issue state filter for listIssues (GitHub API `state` query param). */
export type GithubIssueState = "open" | "closed" | "all";

/** Input for opening a pull request. */
export interface OpenPullInput {
  title: string;
  head: string;
  base: string;
  body?: string;
}

/** Input for editing (PUT) a file's contents. Content must be base64-encoded. */
export interface EditFileInput {
  message: string;
  content: string;
  branch?: string;
  sha?: string;
}

/** The commit created by an edit-file op. */
export interface GithubCommit {
  sha: string;
  html_url: string;
  message: string;
}

/** The result of merging a pull request. */
export interface GithubMergeResult {
  merged: boolean;
  message: string;
  sha: string | null;
}

/** GitHub operations driven by a per-user credential (G3.S2.T2 + G3.S6.T5). */
export interface GitHubApi {
  /** List repos visible to the authenticated credential. */
  listRepos(credential: GithubCredential): Promise<GithubRepo[]>;
  /** List the repo's recursive git tree at an optional ref (branch/tag/sha; default branch when omitted). */
  listTree(credential: GithubCredential, owner: string, repo: string, ref?: string): Promise<GithubTreeEntry[]>;
  /** List branches of a repo, for the branch selector. */
  listBranches(credential: GithubCredential, owner: string, repo: string): Promise<GithubBranch[]>;
  /** Read a file's UTF-8 text content at an optional ref (branch/tag/sha). */
  getFileContent(
    credential: GithubCredential,
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<GithubFileContent>;
  /** List recent commits for a repo/branch (message, author, date, sha). */
  listCommits(
    credential: GithubCredential,
    owner: string,
    repo: string,
    opts?: ListCommitsOptions,
  ): Promise<GithubCommitEntry[]>;
  /** List open pull requests for a repo. */
  listPulls(credential: GithubCredential, owner: string, repo: string): Promise<GithubPull[]>;
  /** List issues for a repo, optionally filtered by state (default: open). */
  listIssues(
    credential: GithubCredential,
    owner: string,
    repo: string,
    state?: GithubIssueState,
  ): Promise<GithubIssue[]>;
  /** Open a pull request. */
  openPull(credential: GithubCredential, owner: string, repo: string, input: OpenPullInput): Promise<GithubPull>;
  /** Edit (PUT) a file's contents. */
  editFile(
    credential: GithubCredential,
    owner: string,
    repo: string,
    path: string,
    input: EditFileInput,
  ): Promise<GithubCommit>;
  /** Merge a pull request. */
  mergePull(credential: GithubCredential, owner: string, repo: string, number: number): Promise<GithubMergeResult>;
}

export class GithubAuthError extends Error {}
export class GithubCredentialUnsupportedError extends Error {}

export interface GithubRestClientOptions {
  /** GitHub API base. Default: https://api.github.com */
  baseUrl?: string;
  /** Injectable fetch implementation for unit tests. */
  fetchImpl?: typeof fetch;
}

const COMMON_HEADERS: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "User-Agent": "athena-agent",
  "X-GitHub-Api-Version": "2022-11-28",
};

const SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * GitHub REST client. Browse + ops require a token; SSH keys can't
 * authenticate the REST API.
 */
export class GithubRestClient implements GitHubApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GithubRestClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Authenticated GET/POST/PUT/DELETE against the REST API; throws on non-2xx. */
  private async request(
    credential: GithubCredential,
    path: string,
    init: { method?: string; body?: string } = {},
  ): Promise<Response> {
    if (credential.type !== "token") {
      throw new GithubCredentialUnsupportedError(
        "GitHub REST operations require a token credential (an SSH key cannot authenticate the REST API)",
      );
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...COMMON_HEADERS,
        Authorization: `Bearer ${credential.value}`,
      },
      body: init.body,
    });
    if (response.status === 401 || response.status === 403) {
      throw new GithubAuthError(`GitHub rejected the credential (HTTP ${response.status})`);
    }
    if (!response.ok) {
      const err = new Error(`GitHub API error ${response.status}: ${await response.text().catch(() => "")}`);
      Object.assign(err, { status: response.status });
      throw err;
    }
    return response;
  }

  private async json(response: Response): Promise<unknown> {
    return response.json().catch(() => null);
  }

  private string(value: unknown): string {
    return value == null ? "" : String(value);
  }

  private maybeString(value: unknown): string | null {
    return value == null ? null : String(value);
  }

  private positiveInt(value: unknown): number | null {
    const n = typeof value === "number" && Number.isInteger(value) ? value : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /** Resolve a ref (branch/tag/sha; default branch when omitted) to a commit sha. */
  private async resolveRefSha(
    credential: GithubCredential,
    owner: string,
    repo: string,
    ref?: string,
  ): Promise<string> {
    let target = ref;
    if (!target) {
      const repoData = (await this.json(await this.request(credential, `/repos/${owner}/${repo}`))) as Record<
        string,
        unknown
      >;
      target = typeof repoData.default_branch === "string" ? repoData.default_branch : "HEAD";
    }
    if (SHA_RE.test(target)) {
      return target;
    }
    const encoded = encodeURIComponent(target);
    try {
      const headData = (await this.json(
        await this.request(credential, `/repos/${owner}/${repo}/git/ref/heads/${encoded}`),
      )) as { object?: { sha?: unknown } };
      const sha = headData.object?.sha;
      if (typeof sha === "string") {
        return sha;
      }
    } catch (err) {
      if (!(err instanceof Error) || err.message.startsWith("GitHub API error 404") === false) {
        throw err;
      }
    }
    const tagData = (await this.json(
      await this.request(credential, `/repos/${owner}/${repo}/git/ref/tags/${encoded}`),
    )) as { object?: { sha?: unknown } };
    const sha = tagData.object?.sha;
    if (typeof sha === "string") {
      return sha;
    }
    throw new Error(`GitHub API error: ref "${target}" not found in ${owner}/${repo}`);
  }

  async listRepos(credential: GithubCredential): Promise<GithubRepo[]> {
    const response = await this.request(credential, "/user/repos?per_page=100&sort=full_name");
    const data = await this.json(response);
    const repos = Array.isArray(data) ? data : [];
    const mapped: GithubRepo[] = [];
    for (const item of repos) {
      const repo = item as Record<string, unknown>;
      mapped.push({
        name: this.string(repo.name),
        full_name: this.string(repo.full_name),
        html_url: this.string(repo.html_url),
        description: this.maybeString(repo.description),
        private: Boolean(repo.private),
        default_branch: this.string(repo.default_branch) || "main",
      });
    }
    return mapped;
  }

  async listTree(
    credential: GithubCredential,
    owner: string,
    repo: string,
    ref?: string,
  ): Promise<GithubTreeEntry[]> {
    const sha = await this.resolveRefSha(credential, owner, repo, ref);
    const response = await this.request(credential, `/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`);
    const data = (await this.json(response)) as { tree?: unknown };
    const entries = Array.isArray(data.tree) ? data.tree : [];
    const mapped: GithubTreeEntry[] = [];
    for (const item of entries) {
      const entry = item as Record<string, unknown>;
      mapped.push({
        path: this.string(entry.path),
        type: entry.type === "blob" || entry.type === "commit" ? entry.type : "tree",
        mode: this.string(entry.mode),
        sha: this.string(entry.sha),
        size: this.positiveInt(entry.size),
      });
    }
    return mapped;
  }

  private async listCollection(
    credential: GithubCredential,
    owner: string,
    repo: string,
    resource: "pulls" | "issues",
    state: GithubIssueState = "open",
  ): Promise<unknown[]> {
    const response = await this.request(credential, `/repos/${owner}/${repo}/${resource}?state=${state}&per_page=100`);
    const data = await this.json(response);
    return Array.isArray(data) ? data : [];
  }

  async listBranches(credential: GithubCredential, owner: string, repo: string): Promise<GithubBranch[]> {
    const response = await this.request(credential, `/repos/${owner}/${repo}/branches?per_page=100`);
    const data = await this.json(response);
    const items = Array.isArray(data) ? data : [];
    const mapped: GithubBranch[] = [];
    for (const item of items) {
      const branch = item as Record<string, unknown>;
      const commit = branch.commit as Record<string, unknown> | null;
      mapped.push({
        name: this.string(branch.name),
        sha: this.string(commit?.sha),
        protected: Boolean(branch.protected),
      });
    }
    return mapped;
  }

  async listCommits(
    credential: GithubCredential,
    owner: string,
    repo: string,
    opts?: ListCommitsOptions,
  ): Promise<GithubCommitEntry[]> {
    const params = new URLSearchParams();
    if (opts?.ref) {
      params.set("sha", opts.ref);
    }
    params.set("per_page", String(opts?.perPage ?? 30));
    const response = await this.request(credential, `/repos/${owner}/${repo}/commits?${params.toString()}`);
    const data = await this.json(response);
    const items = Array.isArray(data) ? data : [];
    const mapped: GithubCommitEntry[] = [];
    for (const item of items) {
      const entry = item as Record<string, unknown>;
      const commit = entry.commit as Record<string, unknown> | null;
      const author = commit?.author as Record<string, unknown> | null;
      mapped.push({
        sha: this.string(entry.sha),
        message: this.string(commit?.message),
        author_name: this.string(author?.name),
        author_email: this.maybeString(author?.email),
        date: this.string(author?.date),
        html_url: this.string(entry.html_url),
      });
    }
    return mapped;
  }

  async getFileContent(
    credential: GithubCredential,
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<GithubFileContent> {
    const params = new URLSearchParams();
    if (ref) {
      params.set("ref", ref);
    }
    const suffix = params.toString() ? `?${params.toString()}` : "";
    const response = await this.request(
      credential,
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${suffix}`,
    );
    const data = (await this.json(response)) as Record<string, unknown>;
    const encoded = this.string(data.content);
    return {
      path: this.string(data.path),
      sha: this.string(data.sha),
      size: this.positiveInt(data.size),
      content: encoded ? Buffer.from(encoded, "base64").toString("utf8") : "",
    };
  }

  async listPulls(credential: GithubCredential, owner: string, repo: string): Promise<GithubPull[]> {
    const items = await this.listCollection(credential, owner, repo, "pulls");
    const mapped: GithubPull[] = [];
    for (const item of items) {
      const pull = item as Record<string, unknown>;
      const head = pull.head as Record<string, unknown> | null;
      const base = pull.base as Record<string, unknown> | null;
      const user = pull.user as Record<string, unknown> | null;
      mapped.push({
        number: this.positiveInt(pull.number) ?? 0,
        title: this.string(pull.title),
        state: this.string(pull.state),
        html_url: this.string(pull.html_url),
        head_ref: this.string(head?.ref),
        base_ref: this.string(base?.ref),
        user_login: this.maybeString(user?.login),
        body: this.maybeString(pull.body),
      });
    }
    return mapped;
  }

  async listIssues(
    credential: GithubCredential,
    owner: string,
    repo: string,
    state: GithubIssueState = "open",
  ): Promise<GithubIssue[]> {
    const items = await this.listCollection(credential, owner, repo, "issues", state);
    const mapped: GithubIssue[] = [];
    for (const item of items) {
      const issue = item as Record<string, unknown>;
      const user = issue.user as Record<string, unknown> | null;
      const labels = Array.isArray(issue.labels) ? issue.labels : [];
      const assignees = Array.isArray(issue.assignees) ? issue.assignees : [];
      mapped.push({
        number: this.positiveInt(issue.number) ?? 0,
        title: this.string(issue.title),
        state: this.string(issue.state),
        html_url: this.string(issue.html_url),
        user_login: this.maybeString(user?.login),
        body: this.maybeString(issue.body),
        labels: labels.map((label) => String((label as Record<string, unknown>)?.name ?? label)),
        assignees: assignees.map((assignee) =>
          String((assignee as Record<string, unknown>)?.login ?? assignee),
        ),
      });
    }
    return mapped;
  }

  async openPull(
    credential: GithubCredential,
    owner: string,
    repo: string,
    input: OpenPullInput,
  ): Promise<GithubPull> {
    const response = await this.request(credential, `/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    return (await this.toPull(await this.json(response)))!;
  }

  private async toPull(value: unknown): Promise<GithubPull | null> {
    if (typeof value !== "object" || value === null) {
      return null;
    }
    const pull = value as Record<string, unknown>;
    const head = pull.head as Record<string, unknown> | null;
    const base = pull.base as Record<string, unknown> | null;
    const user = pull.user as Record<string, unknown> | null;
    return {
      number: this.positiveInt(pull.number) ?? 0,
      title: this.string(pull.title),
      state: this.string(pull.state),
      html_url: this.string(pull.html_url),
      head_ref: this.string(head?.ref),
      base_ref: this.string(base?.ref),
      user_login: this.maybeString(user?.login),
      body: this.maybeString(pull.body),
    };
  }

  async editFile(
    credential: GithubCredential,
    owner: string,
    repo: string,
    path: string,
    input: EditFileInput,
  ): Promise<GithubCommit> {
    const response = await this.request(credential, `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
    const data = (await this.json(response)) as { sha?: unknown; html_url?: unknown; commit?: { html_url?: unknown; message?: unknown } };
    return {
      sha: this.string(data.sha),
      html_url: this.string(data.html_url ?? data.commit?.html_url),
      message: this.string(data.commit?.message),
    };
  }

  async mergePull(
    credential: GithubCredential,
    owner: string,
    repo: string,
    number: number,
  ): Promise<GithubMergeResult> {
    const response = await this.request(credential, `/repos/${owner}/${repo}/pulls/${number}/merge`, {
      method: "PUT",
    });
    const data = (await this.json(response)) as Record<string, unknown>;
    return {
      merged: Boolean(data.merged),
      message: this.string(data.message),
      sha: this.maybeString(data.sha),
    };
  }
}
