/**
 * GDD's own concrete GitHub client — REST (issues/milestones/labels/search) +
 * GraphQL (Projects v2, which has no REST surface). This is the sync subset of
 * athena's github client, self-contained so the `gdd` package runs standalone on
 * the user's machine. It implements `GitHubApi` from `./types.js` and resolves
 * the token from a `GithubCredential` supplied by the caller (see
 * ../credential.ts). The athena server keeps its own richer client for the read
 * routes; the two are structurally interchangeable where the sync methods overlap.
 */

import type {
  CreateIssueInput,
  CreateSubIssueInput,
  GithubCredential,
  GithubIssue,
  GithubIssueComment,
  GithubProject,
  GithubProjectItem,
  GithubProjectSelectOption,
  GithubProjectStatusField,
  GitHubApi,
  ProjectV2StatusOptionInput,
  UpdateIssueInput,
} from "./types.js";

export interface GithubClientOptions {
  /** GitHub API base. Default: https://api.github.com */
  baseUrl?: string;
  /** Injectable fetch implementation for unit tests. */
  fetchImpl?: typeof fetch;
}

export class GithubAuthError extends Error {}
export class GithubCredentialUnsupportedError extends Error {}

const COMMON_HEADERS: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "User-Agent": "gdd",
  "X-GitHub-Api-Version": "2022-11-28",
};

interface GraphqlEnvelope<T> {
  data?: T | null;
  errors?: { message?: string }[];
}

interface ProjectNode {
  id: string;
  title: string;
  number: number;
  url: string;
  closed?: boolean;
}

interface ProjectItemNode {
  id: string;
  content?: { id?: string; number?: number; title?: string } | null;
  fieldValueByName?: { name?: string } | null;
}

interface GetProjectItemsResponse {
  node?: {
    items?: {
      nodes?: ProjectItemNode[] | null;
      pageInfo?: { hasNextPage: boolean; endCursor?: string | null } | null;
    } | null;
  } | null;
}

interface StatusFieldNode {
  id?: string;
  name?: string;
  options?: Array<{ id?: string; name?: string; color?: string; description?: string } | null> | null;
}

/**
 * GitHub REST + GraphQL client for the GDD sync path. REST ops require a token
 * credential (an SSH key cannot authenticate the GitHub API).
 */
export class GithubClient implements GitHubApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GithubClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private graphqlUrl(): string {
    return `${this.baseUrl}/graphql`;
  }

  /** Authenticated REST GET/POST/PATCH; throws on non-2xx. */
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

  private async toIssue(value: unknown): Promise<GithubIssue | null> {
    if (typeof value !== "object" || value === null) {
      return null;
    }
    const issue = value as Record<string, unknown>;
    const user = issue.user as Record<string, unknown> | null;
    const labels = Array.isArray(issue.labels) ? issue.labels : [];
    const assignees = Array.isArray(issue.assignees) ? issue.assignees : [];
    const parent = issue.parent_issue_url;
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
      ...(typeof parent === "string" && parent ? { parent_issue_url: parent } : {}),
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

  async getIssueByTitlePrefix(
    credential: GithubCredential,
    owner: string,
    repo: string,
    prefix: string,
  ): Promise<GithubIssue | null> {
    const q = `repo:${owner}/${repo} type:issue in:title ${JSON.stringify(prefix)}`;
    const response = await this.request(credential, `/search/issues?q=${encodeURIComponent(q)}&per_page=10`);
    const data = (await this.json(response)) as { items?: unknown };
    const items = Array.isArray(data.items) ? data.items : [];
    for (const item of items) {
      const issue = await this.toIssue(item);
      if (issue && (issue.title === prefix || issue.title.startsWith(prefix))) {
        return issue;
      }
    }
    return null;
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

  // ---------------------------------------------------------------------------
  // GraphQL (Projects v2)
  // ---------------------------------------------------------------------------

  /** Authenticated GraphQL POST; throws GithubAuthError on 401/403. */
  private async gqlRequest(credential: GithubCredential, body: string): Promise<unknown> {
    if (credential.type !== "token") {
      throw new GithubCredentialUnsupportedError(
        "GitHub GraphQL operations require a token credential (an SSH key cannot authenticate the GraphQL API)",
      );
    }
    const response = await this.fetchImpl(this.graphqlUrl(), {
      method: "POST",
      headers: {
        ...COMMON_HEADERS,
        Authorization: `Bearer ${credential.value}`,
      },
      body,
    });
    if (response.status === 401 || response.status === 403) {
      throw new GithubAuthError(`GitHub rejected the credential (HTTP ${response.status})`);
    }
    if (!response.ok) {
      const err = new Error(`GitHub API error ${response.status}: ${await response.text().catch(() => "")}`);
      Object.assign(err, { status: response.status });
      throw err;
    }
    return response.json().catch(() => null);
  }

  private async gql<T>(
    credential: GithubCredential,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const envelope = (await this.gqlRequest(credential, JSON.stringify({ query, variables: variables ?? {} }))) as
      GraphqlEnvelope<T> | null;
    if (!envelope || typeof envelope !== "object") {
      throw new Error("GitHub GraphQL returned an empty response");
    }
    if (envelope.errors?.length) {
      const message = envelope.errors.map((e) => e.message ?? "unknown error").join("; ");
      throw new Error(`GitHub GraphQL error: ${message}`);
    }
    if (envelope.data === undefined || envelope.data === null) {
      throw new Error("GitHub GraphQL returned no data");
    }
    return envelope.data;
  }

  private async lookupOwnerId(
    credential: GithubCredential,
    owner: string,
    kind: "user" | "organization",
  ): Promise<string | null> {
    try {
      const data = await this.gql<{ [key: string]: { id?: string } | null }>(
        credential,
        `query($owner: String!) { ${kind}(login: $owner) { id } }`,
        { owner },
      );
      return data[kind]?.id ?? null;
    } catch (err) {
      if (err instanceof Error && /could not resolve/i.test(err.message)) {
        return null;
      }
      throw err;
    }
  }

  private async resolveOwnerId(credential: GithubCredential, owner: string): Promise<string> {
    const user = await this.lookupOwnerId(credential, owner, "user");
    if (user) {
      return user;
    }
    const organization = await this.lookupOwnerId(credential, owner, "organization");
    if (!organization) {
      throw new Error(`GitHub owner "${owner}" not found for Projects v2`);
    }
    return organization;
  }

  async createProject(credential: GithubCredential, owner: string, title: string): Promise<GithubProject> {
    const ownerId = await this.resolveOwnerId(credential, owner);
    const data = await this.gql<{ createProjectV2?: { projectV2?: ProjectNode | null } | null }>(
      credential,
      `mutation($ownerId: ID!, $title: String!) {
        createProjectV2(input: { ownerId: $ownerId, title: $title }) {
          projectV2 { id title number url }
        }
      }`,
      { ownerId, title },
    );
    const project = data.createProjectV2?.projectV2;
    if (!project?.id) {
      throw new Error(`GitHub failed to create Project "${title}"`);
    }
    return {
      id: project.id,
      title: project.title ?? title,
      number: project.number ?? 0,
      url: project.url ?? "",
    };
  }

  async getProjectByTitle(credential: GithubCredential, owner: string, title: string): Promise<GithubProject | null> {
    for (const kind of ["user", "organization"] as const) {
      const match = await this.lookupProjectByTitle(credential, owner, title, kind);
      if (match) {
        return match;
      }
    }
    return null;
  }

  private async lookupProjectByTitle(
    credential: GithubCredential,
    owner: string,
    title: string,
    kind: "user" | "organization",
  ): Promise<GithubProject | null> {
    try {
      const data = await this.gql<{
        [key: string]: { projectsV2?: { nodes?: ProjectNode[] | null } | null } | null;
      }>(
        credential,
        `query($owner: String!, $first: Int!) {
          ${kind}(login: $owner) { projectsV2(first: $first) { nodes { id title number url } } }
        }`,
        { owner, first: 100 },
      );
      const nodes = data[kind]?.projectsV2?.nodes ?? [];
      const match = nodes.find((n) => n?.title === title);
      return match ? { id: match.id, title: match.title, number: match.number, url: match.url } : null;
    } catch (err) {
      if (err instanceof Error && /could not resolve/i.test(err.message)) {
        return null;
      }
      throw err;
    }
  }

  async addIssueToProject(credential: GithubCredential, projectId: string, contentId: string): Promise<void> {
    await this.gql(
      credential,
      `mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
          item { id }
        }
      }`,
      { projectId, contentId },
    );
  }

  async getProjectItems(credential: GithubCredential, projectId: string): Promise<GithubProjectItem[]> {
    let all: GithubProjectItem[] = [];
    let cursor: string | null = null;
    for (;;) {
      const data: GetProjectItemsResponse = await this.gql<GetProjectItemsResponse>(
        credential,
        `query($projectId: ID!, $first: Int!, $after: String) {
          node(id: $projectId) {
            ... on ProjectV2 {
              items(first: $first, after: $after) {
                nodes {
                  id
                  content { ... on Issue { id number title } }
                  fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        { projectId, first: 100, after: cursor },
      );
      const nodes = data.node?.items?.nodes ?? [];
      for (const node of nodes) {
        if (!node?.id) {
          continue;
        }
        const issue = node.content && typeof node.content.number === "number" ? node.content : null;
        all.push({
          id: node.id,
          issueId: issue?.id ?? null,
          issueNumber: issue?.number ?? null,
          title: issue?.title ?? null,
          status: typeof node.fieldValueByName?.name === "string" ? node.fieldValueByName.name : null,
        });
      }
      const pageInfo = data.node?.items?.pageInfo;
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) {
        break;
      }
      cursor = pageInfo.endCursor;
    }
    return all;
  }

  private async getStatusField(
    credential: GithubCredential,
    projectId: string,
  ): Promise<GithubProjectStatusField> {
    const data = await this.gql<{ node?: { fields?: { nodes?: StatusFieldNode[] | null } | null } | null }>(
      credential,
      `query($projectId: ID!, $first: Int!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            fields(first: $first) {
              nodes {
                ... on ProjectV2SingleSelectField { id name options { id name color description } }
              }
            }
          }
        }
      }`,
      { projectId, first: 100 },
    );
    const field = (data.node?.fields?.nodes ?? []).find((n) => n?.name === "Status");
    if (!field?.id) {
      throw new Error(`GitHub Project ${projectId} has no Status single-select field`);
    }
    const options: GithubProjectSelectOption[] = (field.options ?? [])
      .filter((o): o is { id: string; name: string; color?: string; description?: string } => Boolean(o?.id && o?.name))
      .map((o) => ({
        id: o.id,
        name: o.name,
        ...(o.color ? { color: o.color } : {}),
        ...(o.description ? { description: o.description } : {}),
      }));
    return { fieldId: field.id, options };
  }

  async setItemStatusField(
    credential: GithubCredential,
    projectId: string,
    itemId: string,
    optionName: string,
  ): Promise<void> {
    const { fieldId, options } = await this.getStatusField(credential, projectId);
    const option = options.find((o) => o.name === optionName);
    if (!option) {
      throw new Error(`GitHub Project has no Status option "${optionName}"`);
    }
    await this.gql(
      credential,
      `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId,
          itemId: $itemId,
          fieldId: $fieldId,
          value: { singleSelectOptionId: $optionId }
        }) {
          projectV2Item { id }
        }
      }`,
      { projectId, itemId, fieldId, optionId: option.id },
    );
  }

  async ensureStatusFieldOptions(
    credential: GithubCredential,
    projectId: string,
    options: ProjectV2StatusOptionInput[],
  ): Promise<void> {
    const { fieldId, options: existing } = await this.getStatusField(credential, projectId);
    const existingNames = new Set(existing.map((o) => o.name));
    const missing = options.filter((o) => !existingNames.has(o.name));
    if (missing.length === 0) {
      return;
    }
    const merged = [
      ...existing.map((o) => ({
        name: o.name,
        color: o.color ?? "GRAY",
        description: o.description ?? o.name,
      })),
      ...missing,
    ];
    await this.gql(
      credential,
      `mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
        updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $options }) {
          projectV2Field { ... on ProjectV2SingleSelectField { id } }
        }
      }`,
      { fieldId, options: merged },
    );
  }
}
