/**
 * GDD's own GitHub API surface — types + the `GitHubApi` port the sync path
 * (github-sync.ts, github-feedback.ts, sync-github CLI, opencode auto-sync)
 * drives. GDD is independently runnable on the user's LOCAL machine, so it
 * carries its own credential + issue/project types and its own concrete client
 * (github/client.ts); it must NOT import athena's employees/github-client.
 *
 * The types are structurally compatible with athena's github client, so a
 * GDD `GitHubApi` instance and an athena `GithubRestClient` are interchangeable
 * where their method sets overlap (athena's read routes inject its own client).
 */

/** A GitHub token credential as used by the REST/GraphQL APIs. */
export interface GithubCredential {
  type: "token";
  value: string;
  /** Where the token came from — "gh" (gh CLI), "env" (GITHUB_TOKEN), or the athena employee store. */
  source?: "gh" | "env" | "athena-employee";
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
  /** The API URL of this issue's parent when it is a GitHub sub-issue. */
  parent_issue_url?: string;
}

/** Input for creating an issue via POST /issues. */
export interface CreateIssueInput {
  title: string;
  body?: string;
  labels?: string[];
}

/** Input for creating a sub-issue under a parent issue. */
export interface CreateSubIssueInput {
  title: string;
  body?: string;
}

/** Input for updating an issue via PATCH (all fields optional). */
export interface UpdateIssueInput {
  title?: string;
  body?: string;
  state?: "open" | "closed";
  labels?: string[];
}

/** A comment on an issue, as returned to the issue-detail API. */
export interface GithubIssueComment {
  id: number;
  user_login: string | null;
  body: string;
  created_at: string;
  html_url: string;
}

/** A GitHub Project (v2) as used by the sync. */
export interface GithubProject {
  /** GraphQL node id of the project. */
  id: string;
  title: string;
  number: number;
  url: string;
}

/** Input for (re)configuring a Project v2 single-select option (e.g. a Status option). */
export interface ProjectV2StatusOptionInput {
  name: string;
  color: string;
  description: string;
}

/** A single-select option of a Project v2 field (e.g. the Status column). */
export interface GithubProjectSelectOption {
  id: string;
  name: string;
  color?: string;
  description?: string;
}

/** The Status single-select field of a Project v2 board, with its options. */
export interface GithubProjectStatusField {
  fieldId: string;
  options: GithubProjectSelectOption[];
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

/**
 * The GitHub operations the GDD sync path drives. This is the sync subset of
 * the athena GitHub client (which additionally serves the read/view routes);
 * GDD's own client (github/client.ts) implements it.
 */
export interface GitHubApi {
  /** Find an issue by its exact title (for idempotent create/sync), or null. */
  getIssueByTitle(
    credential: GithubCredential,
    owner: string,
    repo: string,
    title: string,
  ): Promise<GithubIssue | null>;
  /** Find an issue whose title starts with a prefix (e.g. "G4.S6.T1 "), or null. */
  getIssueByTitlePrefix(
    credential: GithubCredential,
    owner: string,
    repo: string,
    prefix: string,
  ): Promise<GithubIssue | null>;
  /** Fetch a single issue by number. */
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
  /** Create an issue via POST /issues and return the created issue. */
  createIssue(credential: GithubCredential, owner: string, repo: string, input: CreateIssueInput): Promise<GithubIssue>;
  /** Create an issue and attach it as a sub-issue of a parent issue. */
  createSubIssue(
    credential: GithubCredential,
    owner: string,
    repo: string,
    parentIssueNumber: number,
    input: CreateSubIssueInput,
  ): Promise<GithubIssue>;
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
  /** Add "blocked by" issue-dependency links on an issue. */
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
