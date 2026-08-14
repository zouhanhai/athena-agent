import type { GithubCredential } from "../employees/employees.js";
import { GithubGraphqlClient } from "./graphql.js";

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
  /** GitHub internal issue id (used by the sub-issues API). */
  id: number;
  /** GitHub node id (used as the Project v2 item content id). */
  node_id: string;
  number: number;
  title: string;
  state: string;
  html_url: string;
  user_login: string | null;
  body: string | null;
  labels: string[];
  assignees: string[];
}

/** Input for creating an issue via POST /issues (G4.S5). */
export interface CreateIssueInput {
  title: string;
  body?: string;
  labels?: string[];
}

/** Input for creating a sub-issue under a parent issue (G4.S5). */
export interface CreateSubIssueInput {
  title: string;
  body?: string;
}

/** A GitHub Project (v2) as used by the S5 sync. */
export interface GithubProject {
  /** GraphQL node id of the project. */
  id: string;
  title: string;
  number: number;
  url: string;
}

/** A single-select option of a Project v2 field (e.g. the Status column). */
export interface GithubProjectSelectOption {
  id: string;
  name: string;
  color?: string;
  description?: string;
}

/** Input for (re)configuring a Project v2 single-select option (e.g. a Status option). */
export interface ProjectV2StatusOptionInput {
  name: string;
  color: string;
  description: string;
}

/** A single card (item) on a Project v2 board. */
export interface GithubProjectItem {
  /** GraphQL node id of the item (card). */
  id: string;
  /** GraphQL node id of the linked issue content, or null for a draft card. */
  issueId: string | null;
  issueNumber: number | null;
  title: string | null;
  /** The Status single-select option name, or null when unset. */
  status: string | null;
}

/** The Status single-select field of a Project v2 board, with its options. */
export interface GithubProjectStatusField {
  fieldId: string;
  options: GithubProjectSelectOption[];
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

/** A comment on an issue, as returned to the issue-detail API. */
export interface GithubIssueComment {
  id: number;
  user_login: string | null;
  body: string;
  created_at: string;
  html_url: string;
}

/** Input for updating an issue via PATCH (all fields optional). */
export interface UpdateIssueInput {
  title?: string;
  body?: string;
  state?: "open" | "closed";
  labels?: string[];
}

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
  /** Fetch a single issue by number (title, body, state, labels, assignees). */
  getIssue(credential: GithubCredential, owner: string, repo: string, number: number): Promise<GithubIssue>;
  /** Fetch the comment thread of an issue. */
  getIssueComments(
    credential: GithubCredential,
    owner: string,
    repo: string,
    number: number,
  ): Promise<GithubIssueComment[]>;
  /** Update an issue (title, body, state, labels) and return the updated issue. */
  updateIssue(
    credential: GithubCredential,
    owner: string,
    repo: string,
    number: number,
    input: UpdateIssueInput,
  ): Promise<GithubIssue>;
  /** Add a comment to an issue and return the created comment. */
  createIssueComment(
    credential: GithubCredential,
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Promise<GithubIssueComment>;
  /** List the repo's labels (names), for the issue edit label picker. */
  listLabels(credential: GithubCredential, owner: string, repo: string): Promise<string[]>;
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
  /** Create an issue via POST /issues and return the created issue (G4.S5). */
  createIssue(
    credential: GithubCredential,
    owner: string,
    repo: string,
    input: CreateIssueInput,
  ): Promise<GithubIssue>;
  /** Create an issue and attach it as a sub-issue of a parent issue (G4.S5). */
  createSubIssue(
    credential: GithubCredential,
    owner: string,
    repo: string,
    parentIssueNumber: number,
    input: CreateSubIssueInput,
  ): Promise<GithubIssue>;
  /** Find an issue by its exact title (for idempotent create/sync), or null. */
  getIssueByTitle(
    credential: GithubCredential,
    owner: string,
    repo: string,
    title: string,
  ): Promise<GithubIssue | null>;
  /** Ensure the label exists on the repo, then add it to the issue. */
  addLabel(credential: GithubCredential, owner: string, repo: string, issueNumber: number, label: string): Promise<void>;
  /** Set the issue's milestone by its milestone number. */
  setMilestone(
    credential: GithubCredential,
    owner: string,
    repo: string,
    issueNumber: number,
    milestoneNumber: number,
  ): Promise<GithubIssue>;
  /** Resolve a milestone's number by title, or null when absent. */
  getMilestoneByTitle(credential: GithubCredential, owner: string, repo: string, title: string): Promise<number | null>;
  /** Create a milestone by title and return its number. */
  createMilestone(credential: GithubCredential, owner: string, repo: string, title: string): Promise<number>;
  /** Add "blocked by" issue-dependency links on an issue (G4.S5 blocked_by sync). */
  setIssueDependencies(
    credential: GithubCredential,
    owner: string,
    repo: string,
    issueNumber: number,
    dependencyIssueIds: number[],
  ): Promise<void>;
  /** Create a Project v2 board owned by the user/org and return it. */
  createProject(credential: GithubCredential, owner: string, title: string): Promise<GithubProject>;
  /** Find a Project v2 board owned by the user/org by title, or null. */
  getProjectByTitle(credential: GithubCredential, owner: string, title: string): Promise<GithubProject | null>;
  /** List the Projects v2 boards linked to a repository (G4.S5.T11); empty when the repo is unresolvable. */
  getRepoProjects(credential: GithubCredential, owner: string, repo: string): Promise<GithubProject[]>;
  /** Add an issue (by node id) to a Project v2 board. */
  addIssueToProject(credential: GithubCredential, projectId: string, contentId: string): Promise<void>;
  /** List the cards of a Project v2 board, with their linked issue + Status option. */
  getProjectItems(credential: GithubCredential, projectId: string): Promise<GithubProjectItem[]>;
  /** Set an item's Status field to the given single-select option name. */
  setItemStatusField(
    credential: GithubCredential,
    projectId: string,
    itemId: string,
    optionName: string,
  ): Promise<void>;
  /** Ensure the Project's Status field carries the given options (adds missing ones, idempotent). */
  ensureStatusFieldOptions(
    credential: GithubCredential,
    projectId: string,
    options: ProjectV2StatusOptionInput[],
  ): Promise<void>;
}

export class GithubAuthError extends Error {}
export class GithubCredentialUnsupportedError extends Error {}

export interface GithubRestClientOptions {
  /** GitHub API base. Default: https://api.github.com */
  baseUrl?: string;
  /** Injectable fetch implementation for unit tests. */
  fetchImpl?: typeof fetch;
  /** Optional GraphQL client for the Project v2 ops. Defaults to a live one. */
  graphql?: GithubGraphqlClient;
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
  private readonly graphql: GithubGraphqlClient;

  constructor(options: GithubRestClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.graphql =
      options.graphql ??
      new GithubGraphqlClient({
        baseUrl: `${this.baseUrl}/graphql`,
        fetchImpl: this.fetchImpl,
      });
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
    // Paginate through ALL pages (per_page=100 + page=N) so a repo with >100
    // issues (e.g. caleo's 161) returns everything, not just the first page.
    // Without this the GitHub Project view capped at 100 cards.
    const all: unknown[] = [];
    for (let page = 1; ; page++) {
      const response = await this.request(credential, `/repos/${owner}/${repo}/${resource}?state=${state}&per_page=100&page=${page}`);
      const data = await this.json(response);
      const batch = Array.isArray(data) ? data : [];
      all.push(...batch);
      if (!Array.isArray(data) || batch.length < 100) {
        break;
      }
    }
    return all;
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

  private async toIssue(value: unknown): Promise<GithubIssue | null> {
    if (typeof value !== "object" || value === null) {
      return null;
    }
    const issue = value as Record<string, unknown>;
    const user = issue.user as Record<string, unknown> | null;
    const labels = Array.isArray(issue.labels) ? issue.labels : [];
    const assignees = Array.isArray(issue.assignees) ? issue.assignees : [];
    return {
      id: this.positiveInt(issue.id) ?? 0,
      node_id: this.string(issue.node_id),
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
    };
  }

  private async toComment(value: unknown): Promise<GithubIssueComment | null> {
    if (typeof value !== "object" || value === null) {
      return null;
    }
    const comment = value as Record<string, unknown>;
    const user = comment.user as Record<string, unknown> | null;
    return {
      id: this.positiveInt(comment.id) ?? 0,
      user_login: this.maybeString(user?.login),
      body: this.string(comment.body),
      created_at: this.string(comment.created_at),
      html_url: this.string(comment.html_url),
    };
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
      const issue = await this.toIssue(item);
      if (issue) {
        mapped.push(issue);
      }
    }
    return mapped;
  }

  async getIssue(credential: GithubCredential, owner: string, repo: string, number: number): Promise<GithubIssue> {
    const response = await this.request(credential, `/repos/${owner}/${repo}/issues/${number}`);
    return (await this.toIssue(await this.json(response)))!;
  }

  async getIssueComments(
    credential: GithubCredential,
    owner: string,
    repo: string,
    number: number,
  ): Promise<GithubIssueComment[]> {
    const response = await this.request(credential, `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`);
    const data = await this.json(response);
    const items = Array.isArray(data) ? data : [];
    const mapped: GithubIssueComment[] = [];
    for (const item of items) {
      const comment = await this.toComment(item);
      if (comment) {
        mapped.push(comment);
      }
    }
    return mapped;
  }

  async updateIssue(
    credential: GithubCredential,
    owner: string,
    repo: string,
    number: number,
    input: UpdateIssueInput,
  ): Promise<GithubIssue> {
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) {
      body.title = input.title;
    }
    if (input.body !== undefined) {
      body.body = input.body;
    }
    if (input.state !== undefined) {
      body.state = input.state;
    }
    if (input.labels !== undefined) {
      body.labels = input.labels;
    }
    const response = await this.request(credential, `/repos/${owner}/${repo}/issues/${number}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return (await this.toIssue(await this.json(response)))!;
  }

  async createIssueComment(
    credential: GithubCredential,
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Promise<GithubIssueComment> {
    const response = await this.request(credential, `/repos/${owner}/${repo}/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    return (await this.toComment(await this.json(response)))!;
  }

  async listLabels(credential: GithubCredential, owner: string, repo: string): Promise<string[]> {
    const response = await this.request(credential, `/repos/${owner}/${repo}/labels?per_page=100`);
    const data = await this.json(response);
    const items = Array.isArray(data) ? data : [];
    return items.map((item) => String((item as Record<string, unknown>)?.name ?? item));
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

  async createIssue(
    credential: GithubCredential,
    owner: string,
    repo: string,
    input: CreateIssueInput,
  ): Promise<GithubIssue> {
    const body: Record<string, unknown> = { title: input.title };
    if (input.body !== undefined) {
      body.body = input.body;
    }
    if (input.labels !== undefined) {
      body.labels = input.labels;
    }
    const response = await this.request(credential, `/repos/${owner}/${repo}/issues`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return (await this.toIssue(await this.json(response)))!;
  }

  async createSubIssue(
    credential: GithubCredential,
    owner: string,
    repo: string,
    parentIssueNumber: number,
    input: CreateSubIssueInput,
  ): Promise<GithubIssue> {
    const created = await this.createIssue(credential, owner, repo, {
      title: input.title,
      body: input.body,
    });
    await this.request(credential, `/repos/${owner}/${repo}/issues/${parentIssueNumber}/sub_issues`, {
      method: "POST",
      body: JSON.stringify({ sub_issue_id: created.id }),
    });
    return created;
  }

  async getIssueByTitle(
    credential: GithubCredential,
    owner: string,
    repo: string,
    title: string,
  ): Promise<GithubIssue | null> {
    const q = `repo:${owner}/${repo} type:issue in:title ${JSON.stringify(title)}`;
    const response = await this.request(credential, `/search/issues?q=${encodeURIComponent(q)}&per_page=5`);
    const data = (await this.json(response)) as { items?: unknown };
    const items = Array.isArray(data.items) ? data.items : [];
    for (const item of items) {
      const issue = await this.toIssue(item);
      if (issue && issue.title === title) {
        return issue;
      }
    }
    return null;
  }

  async addLabel(
    credential: GithubCredential,
    owner: string,
    repo: string,
    issueNumber: number,
    label: string,
  ): Promise<void> {
    await this.ensureLabel(credential, owner, repo, label);
    await this.request(credential, `/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels: [label] }),
    });
  }

  private async ensureLabel(
    credential: GithubCredential,
    owner: string,
    repo: string,
    name: string,
  ): Promise<void> {
    try {
      await this.request(credential, `/repos/${owner}/${repo}/labels`, {
        method: "POST",
        body: JSON.stringify({ name, color: "0366d6" }),
      });
    } catch (err) {
      if (!(err instanceof Error) || (err as { status?: number }).status !== 422) {
        throw err;
      }
    }
  }

  async setMilestone(
    credential: GithubCredential,
    owner: string,
    repo: string,
    issueNumber: number,
    milestoneNumber: number,
  ): Promise<GithubIssue> {
    const response = await this.request(credential, `/repos/${owner}/${repo}/issues/${issueNumber}`, {
      method: "PATCH",
      body: JSON.stringify({ milestone: milestoneNumber }),
    });
    return (await this.toIssue(await this.json(response)))!;
  }

  async getMilestoneByTitle(
    credential: GithubCredential,
    owner: string,
    repo: string,
    title: string,
  ): Promise<number | null> {
    const response = await this.request(credential, `/repos/${owner}/${repo}/milestones?state=all&per_page=100`);
    const data = await this.json(response);
    const items = Array.isArray(data) ? data : [];
    for (const item of items) {
      const milestone = item as Record<string, unknown>;
      if (this.string(milestone.title) === title) {
        return this.positiveInt(milestone.number);
      }
    }
    return null;
  }

  async createMilestone(
    credential: GithubCredential,
    owner: string,
    repo: string,
    title: string,
  ): Promise<number> {
    const response = await this.request(credential, `/repos/${owner}/${repo}/milestones`, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    const data = (await this.json(response)) as { number?: unknown };
    const number = this.positiveInt(data.number);
    if (number === null) {
      throw new Error(`GitHub failed to create milestone "${title}"`);
    }
    return number;
  }

  async setIssueDependencies(
    credential: GithubCredential,
    owner: string,
    repo: string,
    issueNumber: number,
    dependencyIssueIds: number[],
  ): Promise<void> {
    for (const id of dependencyIssueIds) {
      try {
        await this.request(
          credential,
          `/repos/${owner}/${repo}/issues/${issueNumber}/dependencies/blocked_by`,
          {
            method: "POST",
            body: JSON.stringify({ issue_id: id }),
          },
        );
      } catch (err) {
        // Idempotent: GitHub 422s when the dependency already exists.
        if (
          err instanceof Error &&
          (err as { status?: number }).status === 422 &&
          /already been taken/i.test(err.message)
        ) {
          continue;
        }
        throw err;
      }
    }
  }

  async createProject(credential: GithubCredential, owner: string, title: string): Promise<GithubProject> {
    return this.graphql.createProject(credential, owner, title);
  }

  async getProjectByTitle(credential: GithubCredential, owner: string, title: string): Promise<GithubProject | null> {
    return this.graphql.getProjectByTitle(credential, owner, title);
  }

  async getRepoProjects(
    credential: GithubCredential,
    owner: string,
    repo: string,
  ): Promise<GithubProject[]> {
    return this.graphql.getRepoProjects(credential, owner, repo);
  }

  async addIssueToProject(credential: GithubCredential, projectId: string, contentId: string): Promise<void> {
    return this.graphql.addIssueToProject(credential, projectId, contentId);
  }

  async getProjectItems(credential: GithubCredential, projectId: string): Promise<GithubProjectItem[]> {
    return this.graphql.getProjectItems(credential, projectId);
  }

  async setItemStatusField(
    credential: GithubCredential,
    projectId: string,
    itemId: string,
    optionName: string,
  ): Promise<void> {
    return this.graphql.setItemStatusField(credential, projectId, itemId, optionName);
  }

  async ensureStatusFieldOptions(
    credential: GithubCredential,
    projectId: string,
    options: ProjectV2StatusOptionInput[],
  ): Promise<void> {
    return this.graphql.ensureStatusFieldOptions(credential, projectId, options);
  }
}
