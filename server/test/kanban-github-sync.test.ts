import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KANBAN_STATUS_TO_PROJECT_STATUS,
  kanbanStatusToProjectStatus,
  projectStatusToKanbanStatus,
} from "../src/kanban/status-map.js";
import {
  GithubAuthError,
  GithubCredentialUnsupportedError,
  GithubRestClient,
} from "../src/github/client.js";
import { GithubGraphqlClient, type GithubGraphqlClientOptions } from "../src/github/graphql.js";

const tokenCredential = { type: "token" as const, value: "ghp_testtoken" };
const sshCredential = { type: "ssh" as const, value: "ssh-ed25519 AAAA key" };

function mockFetch(
  handler: (url: string, init: RequestInit) => Promise<{ status: number; body: unknown }>,
): typeof fetch {
  return (async (input, init) => {
    const { status, body } = await handler(String(input), init ?? {});
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

function graphqlClient(
  handler: (url: string, init: RequestInit) => Promise<{ status: number; body: unknown }>,
): GithubGraphqlClient {
  return new GithubGraphqlClient({
    baseUrl: "https://api.github.test/graphql",
    fetchImpl: mockFetch(handler),
  });
}

function restClient(
  handler: (url: string, init: RequestInit) => Promise<{ status: number; body: unknown }>,
  options?: Omit<GithubGraphqlClientOptions, "baseUrl" | "fetchImpl">,
): GithubRestClient {
  return new GithubRestClient({
    baseUrl: "https://api.github.test",
    fetchImpl: mockFetch(handler),
    graphql: options?.graphql,
  });
}

test("kanban statuses map to Project Status option names", () => {
  assert.equal(KANBAN_STATUS_TO_PROJECT_STATUS.backlog, "Backlog");
  assert.equal(KANBAN_STATUS_TO_PROJECT_STATUS.in_progress, "In Progress");
  assert.equal(KANBAN_STATUS_TO_PROJECT_STATUS.done, "Done");
  assert.equal(KANBAN_STATUS_TO_PROJECT_STATUS.in_review, "In Review");
  assert.equal(KANBAN_STATUS_TO_PROJECT_STATUS.approved, "Approved");
  assert.equal(KANBAN_STATUS_TO_PROJECT_STATUS.rejected, "Rejected");
  assert.equal(KANBAN_STATUS_TO_PROJECT_STATUS.canceled, "Canceled");
  assert.equal(kanbanStatusToProjectStatus("in_review"), "In Review");
});

test("project Status option names map back to kanban statuses", () => {
  assert.equal(projectStatusToKanbanStatus("Backlog"), "backlog");
  assert.equal(projectStatusToKanbanStatus("In Progress"), "in_progress");
  assert.equal(projectStatusToKanbanStatus("Done"), "done");
  assert.equal(projectStatusToKanbanStatus("In Review"), "in_review");
  assert.equal(projectStatusToKanbanStatus("Approved"), "approved");
  assert.equal(projectStatusToKanbanStatus("Rejected"), "rejected");
  assert.equal(projectStatusToKanbanStatus("Canceled"), "canceled");
});

test("an unknown Project Status option maps to null", () => {
  assert.equal(projectStatusToKanbanStatus("No status"), null);
  assert.equal(projectStatusToKanbanStatus(""), null);
});

test("status mapping round-trips in both directions", () => {
  for (const [kanban, option] of Object.entries(KANBAN_STATUS_TO_PROJECT_STATUS)) {
    assert.equal(kanbanStatusToProjectStatus(kanban as keyof typeof KANBAN_STATUS_TO_PROJECT_STATUS), option);
    assert.equal(projectStatusToKanbanStatus(option), kanban);
  }
});

test("gql posts the query + variables to the GraphQL endpoint with the token", async () => {
  let calledUrl = "";
  let sentBody: unknown;
  let headers: Record<string, string> = {};
  const client = graphqlClient(async (url, init) => {
    calledUrl = String(url);
    sentBody = JSON.parse(String(init.body));
    headers = init.headers as Record<string, string>;
    return { status: 200, body: { data: { viewer: { login: "alice" } } } };
  });
  const data = await client.gql<{ viewer: { login: string } }>(
    tokenCredential,
    "query { viewer { login } }",
    { a: 1 },
  );
  assert.equal(calledUrl, "https://api.github.test/graphql");
  assert.equal(headers.Authorization, "Bearer ghp_testtoken");
  assert.deepEqual(sentBody, { query: "query { viewer { login } }", variables: { a: 1 } });
  assert.equal(data.viewer.login, "alice");
});

test("gql throws GithubAuthError on a 401", async () => {
  const client = graphqlClient(async () => ({ status: 401, body: {} }));
  await assert.rejects(client.gql(tokenCredential, "query { viewer { id } }"), GithubAuthError);
});

test("gql throws GithubAuthError on a 403", async () => {
  const client = graphqlClient(async () => ({ status: 403, body: {} }));
  await assert.rejects(client.gql(tokenCredential, "query { viewer { id } }"), GithubAuthError);
});

test("gql rejects an ssh credential", async () => {
  const client = graphqlClient(async () => ({ status: 200, body: { data: {} } }));
  await assert.rejects(client.gql(sshCredential, "query { viewer { id } }"), GithubCredentialUnsupportedError);
});

test("gql throws when the response carries GraphQL errors", async () => {
  const client = graphqlClient(async () => ({
    status: 200,
    body: { data: null, errors: [{ message: "Field 'x' doesn't exist" }] },
  }));
  await assert.rejects(client.gql(tokenCredential, "query { x }"), /GraphQL error: Field 'x'/);
});

test("resolveOwnerId queries user + organization and returns the owner node id", async () => {
  let sentQuery = "";
  const client = graphqlClient(async (_url, init) => {
    sentQuery = String((JSON.parse(String(init.body)) as { query: string }).query);
    return { status: 200, body: { data: { user: null, organization: { id: "O_org123" } } } };
  });
  const id = await client.resolveOwnerId(tokenCredential, "caleo-consulting");
  assert.equal(id, "O_org123");
  assert.match(sentQuery, /user\(login/);
  assert.match(sentQuery, /organization\(login/);
});

test("createProject resolves the owner then posts the createProjectV2 mutation", async () => {
  const queries: string[] = [];
  const variables: Record<string, unknown>[] = [];
  const client = graphqlClient(async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    queries.push(body.query);
    variables.push(body.variables);
    if (body.query.includes("createProjectV2")) {
      return {
        status: 200,
        body: { data: { createProjectV2: { projectV2: { id: "PVT_1", title: "G4", number: 5, url: "https://github.com/orgs/caleo/projects/5" } } } },
      };
    }
    return { status: 200, body: { data: { user: { id: "U_alice" }, organization: null } } };
  });
  const project = await client.createProject(tokenCredential, "caleo-consulting", "G4");
  assert.deepEqual(project, {
    id: "PVT_1",
    title: "G4",
    number: 5,
    url: "https://github.com/orgs/caleo/projects/5",
  });
  assert.equal(queries.length, 2);
  assert.match(queries[1], /createProjectV2\(input: \{ ownerId: \$ownerId, title: \$title \}\)/);
  assert.deepEqual(variables[1], { ownerId: "U_alice", title: "G4" });
});

test("getProjectByTitle queries owner projects and matches by exact title", async () => {
  let sentVariables: unknown;
  const client = graphqlClient(async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { variables: unknown };
    sentVariables = body.variables;
    return {
      status: 200,
      body: {
        data: {
          user: { projectsV2: { nodes: [{ id: "PVT_1", title: "G4", number: 5, url: "https://github.com/orgs/caleo/projects/5" }] } },
          organization: null,
        },
      },
    };
  });
  const project = await client.getProjectByTitle(tokenCredential, "caleo-consulting", "G4");
  assert.deepEqual(sentVariables, { owner: "caleo-consulting", first: 100 });
  assert.deepEqual(project, {
    id: "PVT_1",
    title: "G4",
    number: 5,
    url: "https://github.com/orgs/caleo/projects/5",
  });
});

test("getProjectByTitle returns null when no project matches", async () => {
  const client = graphqlClient(async () => ({
    status: 200,
    body: { data: { user: { projectsV2: { nodes: [{ id: "PVT_1", title: "Other", number: 1, url: "" }] } }, organization: null } },
  }));
  assert.equal(await client.getProjectByTitle(tokenCredential, "caleo-consulting", "Missing"), null);
});

test("addIssueToProject posts the addProjectV2ItemById mutation", async () => {
  let sentBody: unknown;
  const client = graphqlClient(async (_url, init) => {
    sentBody = JSON.parse(String(init.body));
    return { status: 200, body: { data: { addProjectV2ItemById: { item: { id: "PVTI_1" } } } } };
  });
  await client.addIssueToProject(tokenCredential, "PVT_1", "I_issue1");
  const body = sentBody as { query: string; variables: Record<string, unknown> };
  assert.match(body.query, /addProjectV2ItemById/);
  assert.deepEqual(body.variables, { projectId: "PVT_1", contentId: "I_issue1" });
});

test("getProjectItems maps cards with linked issue + Status option", async () => {
  const client = graphqlClient(async () => ({
    status: 200,
    body: {
      data: {
        projectV2: {
          items: {
            nodes: [
              {
                id: "PVTI_1",
                content: { id: "I_issue1", number: 2, title: "G4.S5.T1" },
                fieldValueByName: { name: "In Progress" },
              },
              {
                id: "PVTI_2",
                content: { id: "I_issue2", number: 3, title: "G4.S5.T2" },
                fieldValueByName: null,
              },
            ],
          },
        },
      },
    },
  }));
  const items = await client.getProjectItems(tokenCredential, "PVT_1");
  assert.deepEqual(items, [
    { id: "PVTI_1", issueId: "I_issue1", issueNumber: 2, title: "G4.S5.T1", status: "In Progress" },
    { id: "PVTI_2", issueId: "I_issue2", issueNumber: 3, title: "G4.S5.T2", status: null },
  ]);
});

test("getStatusField resolves the Status single-select field id + options", async () => {
  const client = graphqlClient(async () => ({
    status: 200,
    body: {
      data: {
        projectV2: {
          fields: {
            nodes: [
              { id: "PVTF_1", name: "Status", options: [{ id: "1", name: "Backlog" }, { id: "2", name: "In Progress" }] },
              { id: "PVTF_2", name: "Priority", options: [] },
            ],
          },
        },
      },
    },
  }));
  const field = await client.getStatusField(tokenCredential, "PVT_1");
  assert.deepEqual(field, {
    fieldId: "PVTF_1",
    options: [{ id: "1", name: "Backlog" }, { id: "2", name: "In Progress" }],
  });
});

test("getStatusField throws when the project has no Status field", async () => {
  const client = graphqlClient(async () => ({
    status: 200,
    body: { data: { projectV2: { fields: { nodes: [{ id: "PVTF_2", name: "Priority", options: [] }] } } } },
  }));
  await assert.rejects(client.getStatusField(tokenCredential, "PVT_1"), /no Status single-select field/);
});

test("setItemStatusField resolves the option id then updates the field value", async () => {
  const queries: string[] = [];
  const variables: Record<string, unknown>[] = [];
  const client = graphqlClient(async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    queries.push(body.query);
    variables.push(body.variables);
    if (body.query.includes("updateProjectV2ItemFieldValue")) {
      return { status: 200, body: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_1" } } } } };
    }
    return {
      status: 200,
      body: {
        data: {
          projectV2: {
            fields: {
              nodes: [
                { id: "PVTF_1", name: "Status", options: [{ id: "1", name: "Backlog" }, { id: "2", name: "In Progress" }] },
              ],
            },
          },
        },
      },
    };
  });
  await client.setItemStatusField(tokenCredential, "PVT_1", "PVTI_1", "In Progress");
  assert.equal(queries.length, 2);
  assert.match(queries[1], /updateProjectV2ItemFieldValue/);
  assert.deepEqual(variables[1], { projectId: "PVT_1", itemId: "PVTI_1", fieldId: "PVTF_1", optionId: "2" });
});

test("setItemStatusField throws when the option name does not exist", async () => {
  const client = graphqlClient(async () => ({
    status: 200,
    body: {
      data: {
        projectV2: {
          fields: {
            nodes: [{ id: "PVTF_1", name: "Status", options: [{ id: "1", name: "Backlog" }] }],
          },
        },
      },
    },
  }));
  await assert.rejects(
    client.setItemStatusField(tokenCredential, "PVT_1", "PVTI_1", "Nonexistent"),
    /no Status option "Nonexistent"/,
  );
});

const CREATED_ISSUE_BODY = {
  id: 900,
  node_id: "I_kwDOtest",
  number: 12,
  title: "G4.S5.T1",
  state: "open",
  html_url: "https://github.com/caleo/athena/issues/12",
  user: { login: "alice" },
  body: "T1 body",
  labels: [],
  assignees: [],
};

test("createIssue POSTs the issue payload and maps the created issue", async () => {
  let calledUrl = "";
  let method = "";
  let sentBody: unknown;
  const client = restClient(async (url, init) => {
    calledUrl = String(url);
    method = String(init.method ?? "GET");
    sentBody = JSON.parse(String(init.body));
    return { status: 201, body: CREATED_ISSUE_BODY };
  });
  const issue = await client.createIssue(tokenCredential, "caleo", "athena", {
    title: "G4.S5.T1",
    body: "T1 body",
    labels: ["G4"],
  });
  assert.equal(calledUrl, "https://api.github.test/repos/caleo/athena/issues");
  assert.equal(method, "POST");
  assert.deepEqual(sentBody, { title: "G4.S5.T1", body: "T1 body", labels: ["G4"] });
  assert.equal(issue.number, 12);
  assert.equal(issue.id, 900);
  assert.equal(issue.node_id, "I_kwDOtest");
});

test("createIssue omits optional body/labels when not provided", async () => {
  let sentBody: unknown;
  const client = restClient(async (_url, init) => {
    sentBody = JSON.parse(String(init.body));
    return { status: 201, body: CREATED_ISSUE_BODY };
  });
  await client.createIssue(tokenCredential, "caleo", "athena", { title: "T" });
  assert.deepEqual(sentBody, { title: "T" });
});

test("createSubIssue creates the issue then attaches it via the sub-issues endpoint", async () => {
  const calls: string[] = [];
  const sentBodies: unknown[] = [];
  const methods: string[] = [];
  const client = restClient(async (url, init) => {
    calls.push(String(url));
    methods.push(String(init.method ?? "GET"));
    sentBodies.push(init.body ? JSON.parse(String(init.body)) : undefined);
    if (calls.length === 1) {
      return { status: 201, body: CREATED_ISSUE_BODY };
    }
    return { status: 201, body: { id: 900, node_id: "I_kwDOtest", number: 10, title: "G4.S5", url: "" } };
  });
  const issue = await client.createSubIssue(tokenCredential, "caleo", "athena", 10, {
    title: "G4.S5.T1",
    body: "T1 body",
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://api.github.test/repos/caleo/athena/issues/10/sub_issues");
  assert.equal(methods[1], "POST");
  assert.deepEqual(sentBodies[1], { sub_issue_id: 900 });
  assert.equal(issue.number, 12);
});

test("getIssueByTitle searches the repo and returns the matching issue", async () => {
  let calledUrl = "";
  const client = restClient(async (url) => {
    calledUrl = String(url);
    return { status: 200, body: { items: [{ ...CREATED_ISSUE_BODY, title: "G4.S5.T1" }] } };
  });
  const issue = await client.getIssueByTitle(tokenCredential, "caleo", "athena", "G4.S5.T1");
  assert.match(calledUrl, /\/search\/issues\?q=/);
  assert.ok(calledUrl.includes(encodeURIComponent('repo:caleo/athena type:issue in:title "G4.S5.T1"')));
  assert.equal(issue?.number, 12);
});

test("getIssueByTitle returns null when nothing matches", async () => {
  const client = restClient(async () => ({ status: 200, body: { items: [] } }));
  assert.equal(await client.getIssueByTitle(tokenCredential, "caleo", "athena", "Nope"), null);
});

test("addLabel ensures the label exists then adds it to the issue", async () => {
  const calls: string[] = [];
  const sentBodies: unknown[] = [];
  const client = restClient(async (url, init) => {
    calls.push(String(url));
    if (init.body) {
      sentBodies.push(JSON.parse(String(init.body)));
    }
    if (String(url).endsWith("/labels")) {
      return { status: 201, body: { name: "G4", color: "0366d6" } };
    }
    return { status: 200, body: {} };
  });
  await client.addLabel(tokenCredential, "caleo", "athena", 12, "G4");
  assert.equal(calls.length, 2);
  assert.match(calls[0], /\/repos\/caleo\/athena\/labels$/);
  assert.deepEqual(sentBodies[0], { name: "G4", color: "0366d6" });
  assert.match(calls[1], /\/repos\/caleo\/athena\/issues\/12\/labels$/);
  assert.deepEqual(sentBodies[1], { labels: ["G4"] });
});

test("addLabel tolerates a 422 when the label already exists", async () => {
  const calls: string[] = [];
  const client = restClient(async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/repos/caleo/athena/labels")) {
      return { status: 422, body: { message: "already exists" } };
    }
    return { status: 200, body: {} };
  });
  await client.addLabel(tokenCredential, "caleo", "athena", 12, "G4");
  assert.equal(calls.length, 2);
});

test("setMilestone PATCHes the milestone number", async () => {
  let sentBody: unknown;
  let method = "";
  const client = restClient(async (_url, init) => {
    method = String(init.method ?? "GET");
    sentBody = JSON.parse(String(init.body));
    return { status: 200, body: { ...CREATED_ISSUE_BODY, milestone: { number: 4, title: "M4" } } };
  });
  const issue = await client.setMilestone(tokenCredential, "caleo", "athena", 12, 4);
  assert.equal(method, "PATCH");
  assert.deepEqual(sentBody, { milestone: 4 });
  assert.equal(issue.number, 12);
});

test("getMilestoneByTitle lists milestones and finds the number by title", async () => {
  const client = restClient(async (url) => {
    assert.match(String(url), /\/repos\/caleo\/athena\/milestones\?state=all&per_page=100/);
    return {
      status: 200,
      body: [{ number: 3, title: "M3" }, { number: 4, title: "M4" }],
    };
  });
  assert.equal(await client.getMilestoneByTitle(tokenCredential, "caleo", "athena", "M4"), 4);
  assert.equal(await client.getMilestoneByTitle(tokenCredential, "caleo", "athena", "Missing"), null);
});

test("the REST client delegates Project v2 ops to its GraphQL client", async () => {
  const delegated: string[] = [];
  const fakeGraphql = {
    async createProject(_c: unknown, _o: string, title: string) {
      delegated.push(`createProject:${title}`);
      return { id: "PVT_1", title, number: 5, url: "https://github.com/orgs/caleo/projects/5" };
    },
    async getProjectByTitle(_c: unknown, _o: string, title: string) {
      delegated.push(`getProjectByTitle:${title}`);
      return null;
    },
    async addIssueToProject(_c: unknown, projectId: string, contentId: string) {
      delegated.push(`addIssueToProject:${projectId}:${contentId}`);
    },
    async getProjectItems(_c: unknown, projectId: string) {
      delegated.push(`getProjectItems:${projectId}`);
      return [];
    },
    async setItemStatusField(_c: unknown, projectId: string, itemId: string, option: string) {
      delegated.push(`setItemStatusField:${projectId}:${itemId}:${option}`);
    },
  } as unknown as GithubGraphqlClient;
  const client = restClient(async () => ({ status: 200, body: {} }), { graphql: fakeGraphql });

  await client.createProject(tokenCredential, "caleo-consulting", "G4");
  await client.getProjectByTitle(tokenCredential, "caleo-consulting", "G4");
  await client.addIssueToProject(tokenCredential, "PVT_1", "I_issue1");
  await client.getProjectItems(tokenCredential, "PVT_1");
  await client.setItemStatusField(tokenCredential, "PVT_1", "PVTI_1", "In Progress");

  assert.deepEqual(delegated, [
    "createProject:G4",
    "getProjectByTitle:G4",
    "addIssueToProject:PVT_1:I_issue1",
    "getProjectItems:PVT_1",
    "setItemStatusField:PVT_1:PVTI_1:In Progress",
  ]);
});


