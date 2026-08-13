import type { GithubCredential } from "../employees/employees.js";
import {
  GithubAuthError,
  GithubCredentialUnsupportedError,
  type GithubProject,
  type GithubProjectItem,
  type GithubProjectSelectOption,
  type GithubProjectStatusField,
  type ProjectV2StatusOptionInput,
} from "./client.js";

export interface GithubGraphqlClientOptions {
  /** GitHub GraphQL endpoint. Default: https://api.github.com/graphql */
  baseUrl?: string;
  /** Injectable fetch implementation for unit tests. */
  fetchImpl?: typeof fetch;
}

interface GraphqlEnvelope<T> {
  data?: T | null;
  errors?: { message?: string }[];
}

interface ProjectNode {
  id: string;
  title: string;
  number: number;
  url: string;
}

interface ProjectItemContentNode {
  id?: string;
  number?: number;
  title?: string;
}

interface ProjectItemNode {
  id: string;
  content?: ProjectItemContentNode | null;
  fieldValueByName?: { name?: string } | null;
}

interface StatusFieldNode {
  id?: string;
  name?: string;
  options?: Array<{ id?: string; name?: string; color?: string; description?: string } | null> | null;
}

const GRAPHQL_HEADERS: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "User-Agent": "athena-agent",
  "X-GitHub-Api-Version": "2022-11-28",
};

/**
 * GitHub GraphQL client for Projects v2 — the REST API has no Projects v2
 * surface, so S5 talks GraphQL. Reuses the employee token + auth error
 * conventions of GithubRestClient (GithubAuthError / GithubCredentialUnsupportedError).
 */
export class GithubGraphqlClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GithubGraphqlClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://api.github.com/graphql").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Authenticated GraphQL POST; throws GithubAuthError on 401/403. */
  private async request(credential: GithubCredential, body: string): Promise<unknown> {
    if (credential.type !== "token") {
      throw new GithubCredentialUnsupportedError(
        "GitHub GraphQL operations require a token credential (an SSH key cannot authenticate the GraphQL API)",
      );
    }
    const response = await this.fetchImpl(this.baseUrl, {
      method: "POST",
      headers: {
        ...GRAPHQL_HEADERS,
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

  /** Run a GraphQL query/mutation; throws on response `errors` or missing data. */
  async gql<T>(credential: GithubCredential, query: string, variables?: Record<string, unknown>): Promise<T> {
    const envelope = (await this.request(credential, JSON.stringify({ query, variables: variables ?? {} }))) as
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

  /**
   * Resolve an owner login (user or org) to its GraphQL node id. GitHub errors
   * a field whose login kind does not match (`user(login: "org")`), so the two
   * kinds are queried separately and a "could not resolve" error is treated as
   * a non-match for that kind.
   */
  async resolveOwnerId(credential: GithubCredential, owner: string): Promise<string> {
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

  /** Create a Project v2 board owned by the user/org login. */
  async createProject(credential: GithubCredential, owner: string, title: string): Promise<GithubProject> {
    const ownerId = await this.resolveOwnerId(credential, owner);
    const data = await this.gql<{
      createProjectV2?: { projectV2?: ProjectNode | null } | null;
    }>(
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

  /** Find a Project v2 board owned by the user/org login by exact title, or null. */
  async getProjectByTitle(credential: GithubCredential, owner: string, title: string): Promise<GithubProject | null> {
    const asUser = await this.lookupProjectByTitle(credential, owner, title, "user");
    if (asUser) {
      return asUser;
    }
    return this.lookupProjectByTitle(credential, owner, title, "organization");
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

  /**
   * List the Projects v2 boards linked to a repository (G4.S5.T11). This is the
   * correct way to resolve a repo's Project: `repository(owner,name){ projectsV2 }`
   * returns the projects linked to that repo regardless of their title, unlike
   * title-guessing against the owner's project list.
   */
  async getRepoProjects(
    credential: GithubCredential,
    owner: string,
    repo: string,
  ): Promise<GithubProject[]> {
    try {
      const data = await this.gql<{ repository?: { projectsV2?: { nodes?: ProjectNode[] | null } | null } | null }>(
        credential,
        `query($owner: String!, $name: String!, $first: Int!) {
          repository(owner: $owner, name: $name) { projectsV2(first: $first) { nodes { id title number url } } }
        }`,
        { owner, name: repo, first: 100 },
      );
      const nodes = data.repository?.projectsV2?.nodes ?? [];
      return nodes
        .filter((n): n is ProjectNode => Boolean(n?.id))
        .map((n) => ({ id: n.id, title: n.title, number: n.number, url: n.url }));
    } catch (err) {
      if (err instanceof Error && /could not resolve/i.test(err.message)) {
        return [];
      }
      throw err;
    }
  }

  /** Add an issue (by its GraphQL node id) to a Project v2 board. */
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

  /** List the cards of a Project v2 board, with their linked issue + Status option. */
  async getProjectItems(credential: GithubCredential, projectId: string): Promise<GithubProjectItem[]> {
    const data = await this.gql<{ node?: { items?: { nodes?: ProjectItemNode[] | null } | null } | null }>(
      credential,
      `query($projectId: ID!, $first: Int!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: $first) {
              nodes {
                id
                content { ... on Issue { id number title } }
                fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
              }
            }
          }
        }
      }`,
      { projectId, first: 100 },
    );
    const nodes = data.node?.items?.nodes ?? [];
    const items: GithubProjectItem[] = [];
    for (const node of nodes) {
      if (!node?.id) {
        continue;
      }
      const issue = node.content && typeof node.content.number === "number" ? node.content : null;
      items.push({
        id: node.id,
        issueId: issue?.id ?? null,
        issueNumber: issue?.number ?? null,
        title: issue?.title ?? null,
        status: typeof node.fieldValueByName?.name === "string" ? node.fieldValueByName.name : null,
      });
    }
    return items;
  }

  /** Resolve the Status single-select field (id + options) of a Project v2 board. */
  async getStatusField(
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

  /** Set an item's Status field to the given single-select option name. */
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

  /**
   * Ensure the Status field carries the given single-select options: adds the
   * missing ones (preserving existing options) via updateProjectV2Field, since
   * the default Status field ships only Todo/In Progress/Done.
   */
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
