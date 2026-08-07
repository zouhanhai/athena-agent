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

/** GitHub operations driven by a per-user credential (G3.S2.T2). */
export interface GitHubApi {
  /** List repos visible to the authenticated credential. */
  listRepos(credential: GithubCredential): Promise<GithubRepo[]>;
}

export class GithubAuthError extends Error {}
export class GithubCredentialUnsupportedError extends Error {}

export interface GithubRestClientOptions {
  /** GitHub API base. Default: https://api.github.com */
  baseUrl?: string;
  /** Injectable fetch implementation for unit tests. */
  fetchImpl?: typeof fetch;
}

/** GitHub REST client. Repo listing requires a token; SSH keys can't authenticate the REST API. */
export class GithubRestClient implements GitHubApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GithubRestClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listRepos(credential: GithubCredential): Promise<GithubRepo[]> {
    if (credential.type !== "token") {
      throw new GithubCredentialUnsupportedError(
        "repo listing requires a token credential (an SSH key cannot authenticate the GitHub REST API)",
      );
    }
    const response = await this.fetchImpl(`${this.baseUrl}/user/repos?per_page=100&sort=full_name`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credential.value}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "athena-agent",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (response.status === 401 || response.status === 403) {
      throw new GithubAuthError(`GitHub rejected the credential (HTTP ${response.status})`);
    }
    if (!response.ok) {
      throw new Error(`GitHub API error ${response.status}: ${await response.text().catch(() => "")}`);
    }
    const data = (await response.json()) as unknown[];
    const repos = Array.isArray(data) ? data : [];
    return repos.map((item) => {
      const repo = item as Record<string, unknown>;
      return {
        name: String(repo.name ?? ""),
        full_name: String(repo.full_name ?? ""),
        html_url: String(repo.html_url ?? ""),
        description: typeof repo.description === "string" ? repo.description : null,
        private: Boolean(repo.private),
        default_branch: String(repo.default_branch ?? "main"),
      };
    });
  }
}
