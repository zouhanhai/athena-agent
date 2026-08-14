import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KANBAN_SPEC_STATUS_TO_PROJECT_STATUS,
  KANBAN_STATUS_TO_PROJECT_STATUS,
  kanbanSpecStatusToProjectStatus,
  kanbanStatusToProjectStatus,
  projectStatusToKanbanStatus,
} from "../src/kanban/status-map.js";
import { SPEC_STATUSES } from "../src/kanban/schema.js";
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

test("Spec statuses map to Project columns across the full lifecycle (G4.S5.T7, G4.S6.T2)", () => {
  assert.equal(KANBAN_SPEC_STATUS_TO_PROJECT_STATUS.backlog, "Backlog");
  assert.equal(KANBAN_SPEC_STATUS_TO_PROJECT_STATUS.in_progress, "In Progress");
  assert.equal(KANBAN_SPEC_STATUS_TO_PROJECT_STATUS.done, "Done");
  assert.equal(KANBAN_SPEC_STATUS_TO_PROJECT_STATUS.in_review, "In Review");
  assert.equal(KANBAN_SPEC_STATUS_TO_PROJECT_STATUS.approved, "Approved");
  assert.equal(KANBAN_SPEC_STATUS_TO_PROJECT_STATUS.rejected, "Rejected");
  assert.equal(KANBAN_SPEC_STATUS_TO_PROJECT_STATUS.canceled, "Rejected");
  assert.equal(kanbanSpecStatusToProjectStatus("backlog"), "Backlog");
  assert.equal(kanbanSpecStatusToProjectStatus("in_progress"), "In Progress");
  assert.equal(kanbanSpecStatusToProjectStatus("done"), "Done");
  assert.equal(kanbanSpecStatusToProjectStatus("in_review"), "In Review");
  assert.equal(kanbanSpecStatusToProjectStatus("approved"), "Approved");
  assert.equal(kanbanSpecStatusToProjectStatus("rejected"), "Rejected");
  assert.equal(kanbanSpecStatusToProjectStatus("canceled"), "Rejected");
  // legacy `active` Spec status still maps via the alias (G4.S5.T7 backward compat)
  assert.equal(kanbanSpecStatusToProjectStatus("active"), "In Progress");
});

test("an unknown Spec status maps to null (the card is left untouched) (G4.S5.T6)", () => {
  assert.equal(kanbanSpecStatusToProjectStatus("weird"), null);
  assert.equal(kanbanSpecStatusToProjectStatus(""), null);
});

test("KANBAN_SPEC_STATUS_OPTIONS carries a column for every Spec status (G4.S5.T7)", () => {
  const names = new Set(KANBAN_SPEC_STATUS_OPTIONS.map((o) => o.name));
  for (const status of SPEC_STATUSES) {
    assert.ok(names.has(kanbanSpecStatusToProjectStatus(status)!), `column for ${status}`);
  }
});

test("statusFieldOptions merges ticket + Spec Status options without duplicates (G4.S5.T7)", () => {
  const options = statusFieldOptions();
  const names = options.map((o) => o.name);
  assert.equal(new Set(names).size, names.length, "no duplicate option names");
  for (const column of ["Backlog", "In Progress", "Done", "In Review", "Approved", "Rejected", "Canceled"]) {
    assert.ok(names.includes(column), `status options include ${column}`);
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

test("resolveOwnerId queries user then organization and returns the owner node id", async () => {
  const queries: string[] = [];
  const client = graphqlClient(async (_url, init) => {
    const query = String((JSON.parse(String(init.body)) as { query: string }).query);
    queries.push(query);
    if (query.includes("user(login")) {
      return { status: 200, body: { data: { user: null } } };
    }
    return { status: 200, body: { data: { organization: { id: "O_org123" } } } };
  });
  const id = await client.resolveOwnerId(tokenCredential, "caleo-consulting");
  assert.equal(id, "O_org123");
  assert.equal(queries.length, 2);
  assert.match(queries[0], /user\(login/);
  assert.match(queries[1], /organization\(login/);
  assert.ok(!queries[0].includes("organization("));
});

test("resolveOwnerId tolerates a could-not-resolve user error and uses the organization id", async () => {
  const queries: string[] = [];
  const client = graphqlClient(async (_url, init) => {
    const query = String((JSON.parse(String(init.body)) as { query: string }).query);
    queries.push(query);
    if (query.includes("user(login")) {
      return {
        status: 200,
        body: { data: null, errors: [{ message: "Could not resolve to a User with the login of 'CALEO-Consulting'." }] },
      };
    }
    return { status: 200, body: { data: { organization: { id: "O_org123" } } } };
  });
  const id = await client.resolveOwnerId(tokenCredential, "CALEO-Consulting");
  assert.equal(id, "O_org123");
  assert.equal(queries.length, 2);
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

test("getProjectByTitle resolves a user-owned project (organization lookup errors are tolerated)", async () => {
  const queries: string[] = [];
  const client = graphqlClient(async (_url, init) => {
    const query = String((JSON.parse(String(init.body)) as { query: string }).query);
    queries.push(query);
    if (query.includes("organization(login")) {
      return {
        status: 200,
        body: { data: null, errors: [{ message: "Could not resolve to an Organization with the login of 'alice'." }] },
      };
    }
    return {
      status: 200,
      body: { data: { user: { projectsV2: { nodes: [{ id: "PVT_1", title: "athena-agent", number: 5, url: "" }] } } } },
    };
  });
  const project = await client.getProjectByTitle(tokenCredential, "alice", "athena-agent");
  assert.deepEqual(project, { id: "PVT_1", title: "athena-agent", number: 5, url: "" });
  assert.equal(queries.length, 1);
});

test("getRepoProjects queries the repo's linked projectsV2 and returns them (G4.S5.T11)", async () => {
  let sentBody: unknown;
  const client = graphqlClient(async (_url, init) => {
    sentBody = JSON.parse(String(init.body));
    return {
      status: 200,
      body: {
        data: {
          repository: {
            projectsV2: {
              nodes: [
                { id: "PVT_1", title: "Abaplorer Project", number: 9, url: "https://github.com/orgs/caleo/projects/9" },
              ],
            },
          },
        },
      },
    };
  });
  const projects = await client.getRepoProjects(tokenCredential, "CALEO-Consulting", "caleo.int.abaplorer");
  const body = sentBody as { query: string; variables: Record<string, unknown> };
  assert.match(body.query, /repository\(owner: \$owner, name: \$name\)/);
  assert.match(body.query, /projectsV2\(first: \$first\) \{ nodes \{ id title number url closed \} \}/);
  assert.deepEqual(body.variables, { owner: "CALEO-Consulting", name: "caleo.int.abaplorer", first: 100 });
  assert.deepEqual(projects, [
    { id: "PVT_1", title: "Abaplorer Project", number: 9, url: "https://github.com/orgs/caleo/projects/9" },
  ]);
});

test("getRepoProjects returns an empty array when the repo cannot be resolved (G4.S5.T11)", async () => {
  const client = graphqlClient(async () => ({
    status: 200,
    body: {
      data: null,
      errors: [{ message: "Could not resolve to a Repository with the name 'caleo.int.abaplorer'." }],
    },
  }));
  assert.deepEqual(await client.getRepoProjects(tokenCredential, "CALEO-Consulting", "caleo.int.abaplorer"), []);
});

test("getRepoProjects returns an empty array when the repo has no linked projects (G4.S5.T11)", async () => {
  const client = graphqlClient(async () => ({
    status: 200,
    body: { data: { repository: { projectsV2: { nodes: [] } } } },
  }));
  assert.deepEqual(await client.getRepoProjects(tokenCredential, "zouhanhai", "athena-agent"), []);
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
        node: {
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
        node: {
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
    body: { data: { node: { fields: { nodes: [{ id: "PVTF_2", name: "Priority", options: [] }] } } } },
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
          node: {
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
        node: {
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

test("ensureStatusFieldOptions adds missing Status options via updateProjectV2Field", async () => {
  const queries: string[] = [];
  const variables: Record<string, unknown>[] = [];
  const client = graphqlClient(async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    queries.push(body.query);
    variables.push(body.variables);
    if (body.query.includes("updateProjectV2Field")) {
      return { status: 200, body: { data: { updateProjectV2Field: { projectV2Field: { id: "PVTF_1" } } } } };
    }
    return {
      status: 200,
      body: {
        data: {
          node: {
            fields: {
              nodes: [
                { id: "PVTF_1", name: "Status", options: [{ id: "1", name: "Todo" }, { id: "2", name: "In Progress" }] },
              ],
            },
          },
        },
      },
    };
  });
  await client.ensureStatusFieldOptions(tokenCredential, "PVT_1", [
    { name: "Backlog", color: "GRAY", description: "Not started" },
    { name: "Done", color: "GREEN", description: "Implementation complete" },
  ]);
  assert.equal(queries.length, 2);
  assert.match(queries[1], /updateProjectV2Field/);
  const opts = variables[1].options as Array<Record<string, string>>;
  assert.deepEqual(opts, [
    { name: "Todo", color: "GRAY", description: "Todo" },
    { name: "In Progress", color: "GRAY", description: "In Progress" },
    { name: "Backlog", color: "GRAY", description: "Not started" },
    { name: "Done", color: "GREEN", description: "Implementation complete" },
  ]);
});

test("ensureStatusFieldOptions is a no-op when every option already exists", async () => {
  let queries = 0;
  const client = graphqlClient(async () => {
    queries++;
    return {
      status: 200,
      body: {
        data: {
          node: {
            fields: {
              nodes: [
                { id: "PVTF_1", name: "Status", options: [{ id: "1", name: "Backlog" }, { id: "2", name: "Done" }] },
              ],
            },
          },
        },
      },
    };
  });
  await client.ensureStatusFieldOptions(tokenCredential, "PVT_1", [
    { name: "Backlog", color: "GRAY", description: "Not started" },
    { name: "Done", color: "GREEN", description: "Implementation complete" },
  ]);
  assert.equal(queries, 1);
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

test("createMilestone POSTs the milestone and returns its number", async () => {
  let calledUrl = "";
  let sentBody: unknown;
  const client = restClient(async (url, init) => {
    calledUrl = String(url);
    sentBody = init.body ? JSON.parse(String(init.body)) : undefined;
    return { status: 201, body: { number: 4, title: "M4", state: "open" } };
  });
  const number = await client.createMilestone(tokenCredential, "caleo", "athena", "M4");
  assert.equal(calledUrl, "https://api.github.test/repos/caleo/athena/milestones");
  assert.deepEqual(sentBody, { title: "M4" });
  assert.equal(number, 4);
});

test("setIssueDependencies POSTs one blocked_by link per dependency issue id", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const client = restClient(async (url, init) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : undefined });
    return { status: 201, body: { id: 905, number: 12 } };
  });
  await client.setIssueDependencies(tokenCredential, "caleo", "athena", 12, [901, 902]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    url: "https://api.github.test/repos/caleo/athena/issues/12/dependencies/blocked_by",
    body: { issue_id: 901 },
  });
  assert.deepEqual(calls[1].body, { issue_id: 902 });
});

test("setIssueDependencies tolerates a 422 when the dependency already exists", async () => {
  const calls: string[] = [];
  const client = restClient(async (url, init) => {
    calls.push(String(url));
    return { status: 422, body: { message: "Validation failed: Target issue has already been taken" } };
  });
  await client.setIssueDependencies(tokenCredential, "caleo", "athena", 12, [901, 902]);
  assert.equal(calls.length, 2);
});

test("setIssueDependencies rethrows other API errors", async () => {
  const client = restClient(async () => ({ status: 404, body: { message: "not found" } }));
  await assert.rejects(
    client.setIssueDependencies(tokenCredential, "caleo", "athena", 12, [901]),
    /GitHub API error 404/,
  );
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
    async ensureStatusFieldOptions(_c: unknown, projectId: string, options: unknown[]) {
      delegated.push(`ensureStatusFieldOptions:${projectId}:${options.map((o) => (o as { name: string }).name).join("|")}`);
    },
  } as unknown as GithubGraphqlClient;
  const client = restClient(async () => ({ status: 200, body: {} }), { graphql: fakeGraphql });

  await client.createProject(tokenCredential, "caleo-consulting", "G4");
  await client.getProjectByTitle(tokenCredential, "caleo-consulting", "G4");
  await client.addIssueToProject(tokenCredential, "PVT_1", "I_issue1");
  await client.getProjectItems(tokenCredential, "PVT_1");
  await client.setItemStatusField(tokenCredential, "PVT_1", "PVTI_1", "In Progress");
  await client.ensureStatusFieldOptions(tokenCredential, "PVT_1", [
    { name: "Backlog", color: "GRAY", description: "Not started" },
  ]);

  assert.deepEqual(delegated, [
    "createProject:G4",
    "getProjectByTitle:G4",
    "addIssueToProject:PVT_1:I_issue1",
    "getProjectItems:PVT_1",
    "setItemStatusField:PVT_1:PVTI_1:In Progress",
    "ensureStatusFieldOptions:PVT_1:Backlog",
  ]);
});

// ---------------------------------------------------------------------------
// G4.S5.T2 — md → GitHub Project projection + sync (mock GitHubApi)
// ---------------------------------------------------------------------------

import type { KanbanBoard } from "../src/kanban/scan.js";
import type {
  GithubCredential,
  GithubIssue,
  GithubProject,
  GithubProjectItem,
} from "../src/github/client.js";
import type { GitHubApi } from "../src/github/client.js";
import {
  KANBAN_SPEC_STATUS_OPTIONS,
  blockedByToDeps,
  buildGithubProjectBoard,
  buildIssueForSpec,
  buildIssueForTicket,
  createSpecIssue,
  goalToMilestoneAndLabel,
  statusFieldOptions,
  statusToColumn,
  stripProgressLog,
  stripRefPrefix,
  subIssuesForSpec,
  subTaskProgress,
  syncBlockedBy,
  syncSpecStatus,
  syncTicketStatus,
  ticketState,
  specIssueState,
} from "../src/kanban/github-sync.js";

const board: KanbanBoard = {
  errors: [],
  goals: [
    {
      ref: "G4",
      goal: {
        id: "g4",
        title: "G4: RAG Self-Build, KB Intelligence & Agent Collaboration",
        layer: "G",
        owner: "consultant",
        status: "active",
        created_at: "2026-08-09",
        milestone: "M4",
        acceptance_criteria: ["G4 acceptance"],
      },
      specs: [
        {
          ref: "G4.S5",
          spec: {
            id: "s5",
            title: "G4.S5: Kanban ↔ GitHub Issues bidirectional sync + planning feedback loop",
            layer: "S",
            parent: "G4",
            owner: "consultant",
            status: "in_progress",
            milestone: "M4",
            acceptance_criteria: ["Each Spec → a GitHub Issue"],
          },
          body: "## Background\n\nmd files stay the single source of truth.\n\n## Confirmed mapping\n\nSpec → Main Issue.\n",
          tickets: [
            {
              ref: "G4.S5.T1",
              ticket: {
                id: "t1",
                title: "G4.S5.T1: GitHub GraphQL client + Project v2 API layer",
                layer: "T",
                parent: "G4.S5",
                owner: "eng-director",
                status: "done",
                assignee: "opencode",
                started_at: "2026-08-13",
                blocked_by: [],
                acceptance_criteria: ["GraphQL client works"],
              },
              body: "# G4.S5.T1\n\n## Task\n\nBuild the GraphQL client.\n\n## Acceptance\n\nTests green.\n\n## Progress Log\n| timestamp | status | progress |\n| 2026-08-13T00:00:00Z | done | shipped |\n",
            },
            {
              ref: "G4.S5.T2",
              ticket: {
                id: "t2",
                title: "G4.S5.T2: md→GitHub Project projection + sync CLI",
                layer: "T",
                parent: "G4.S5",
                owner: "eng-director",
                status: "in_progress",
                assignee: "opencode",
                started_at: "2026-08-13",
                blocked_by: ["G4.S5.T1"],
                acceptance_criteria: ["Each Spec → a main Issue"],
              },
              body: "# G4.S5.T2\n\n## Context\n\nmd is the source of truth.\n\n## Task\n\nBuild the projection.\n\n## Acceptance\n\nTests green.\n\n## Progress Log\n| timestamp | status | progress |\n| 2026-08-13T00:00:00Z | in_progress | working |\n\n## Log\n\n[2026-08-13] claimed\n",
            },
          ],
        },
      ],
    },
  ],
};

const project: GithubProject = {
  id: "PVT_1",
  title: "athena-agent",
  number: 5,
  url: "https://github.com/caleo/athena/projects/5",
};

/** In-memory recording GitHubApi stub — records calls + simulates issues/items. */
class RecordingGithub {
  calls: string[] = [];
  readonly issues = new Map<number, GithubIssue>();
  private readonly issuesByTitle = new Map<string, GithubIssue>();
  readonly items: GithubProjectItem[] = [];
  private readonly milestones = new Map<string, number>();
  private nextId = 900;
  private nextNumber = 10;

  constructor(seed: GithubIssue[] = [], options: { milestones?: Record<string, number> } = {}) {
    for (const issue of seed) {
      this.issues.set(issue.number, issue);
      this.issuesByTitle.set(issue.title, issue);
      this.items.push({
        id: `PVTI_${issue.number}`,
        issueId: issue.node_id,
        issueNumber: issue.number,
        title: issue.title,
        status: null,
      });
    }
    for (const [title, number] of Object.entries(options.milestones ?? {})) {
      this.milestones.set(title, number);
    }
  }

  private makeIssue(title: string, body?: string): GithubIssue {
    const issue: GithubIssue = {
      id: this.nextId++,
      node_id: `I_kwDO${this.nextNumber}`,
      number: this.nextNumber++,
      title,
      state: "open",
      html_url: "",
      user_login: "alice",
      body: body ?? null,
      labels: [],
      assignees: [],
    };
    this.issues.set(issue.number, issue);
    this.issuesByTitle.set(issue.title, issue);
    return issue;
  }

  issueNumberForNodeId(nodeId: string): number | null {
    for (const issue of this.issues.values()) {
      if (issue.node_id === nodeId) return issue.number;
    }
    return null;
  }

  asApi(): GitHubApi {
    const github: Partial<GitHubApi> = {
      getIssueByTitle: async (_c, _o, _r, title) => {
        this.calls.push(`getIssueByTitle:${title}`);
        return this.issuesByTitle.get(title) ?? null;
      },
      getIssueByTitlePrefix: async (_c, _o, _r, prefix) => {
        this.calls.push(`getIssueByTitlePrefix:${prefix}`);
        const p = prefix.trimEnd();
        for (const [t, issue] of this.issuesByTitle) {
          // match exact, title starts with prefix, or bare ref (title === p when
          // the existing issue title is just "G4.S5.T1" without a space)
          if (t === p || t.startsWith(prefix) || p.startsWith(t) || t.startsWith(p + " ")) {
            return issue;
          }
        }
        return null;
      },
      createIssue: async (_c, _o, _r, input) => {
        this.calls.push(`createIssue:${input.title}`);
        const issue = this.makeIssue(input.title, input.body);
        issue.labels = input.labels ?? [];
        return issue;
      },
      createSubIssue: async (_c, _o, _r, parent, input) => {
        this.calls.push(`createSubIssue:${parent}:${input.title}`);
        return this.makeIssue(input.title, input.body);
      },
      updateIssue: async (_c, _o, _r, number, input) => {
        this.calls.push(`updateIssue:${number}:${input.title ?? ""}:${input.state ?? ""}`);
        const issue = this.issues.get(number)!;
        if (input.title !== undefined) issue.title = input.title;
        if (input.body !== undefined) issue.body = input.body;
        if (input.labels !== undefined) issue.labels = input.labels;
        if (input.state !== undefined) issue.state = input.state;
        return issue;
      },
      getIssue: async (_c, _o, _r, number) => {
        this.calls.push(`getIssue:${number}`);
        return this.issues.get(number)!;
      },
      addIssueToProject: async (_c, projectId, contentId) => {
        const number = this.issueNumberForNodeId(contentId);
        this.calls.push(`addIssueToProject:${projectId}:${contentId}:${number ?? "?"}`);
        if (!this.items.some((item) => item.issueId === contentId)) {
          this.items.push({
            id: `PVTI_${number ?? contentId}`,
            issueId: contentId,
            issueNumber: number,
            title: number ? this.issues.get(number)?.title ?? null : null,
            status: null,
          });
        }
      },
      getProjectItems: async () => {
        this.calls.push(`getProjectItems`);
        return this.items;
      },
      setItemStatusField: async (_c, projectId, itemId, option) => {
        this.calls.push(`setItemStatusField:${projectId}:${itemId}:${option}`);
        const item = this.items.find((it) => it.id === itemId);
        if (item) item.status = option;
      },
      setMilestone: async (_c, _o, _r, number, milestone) => {
        this.calls.push(`setMilestone:${number}:${milestone}`);
      },
      addLabel: async (_c, _o, _r, number, label) => {
        this.calls.push(`addLabel:${number}:${label}`);
      },
      getMilestoneByTitle: async (_c, _o, _r, title) => {
        this.calls.push(`getMilestoneByTitle:${title}`);
        return this.milestones.get(title) ?? null;
      },
      createMilestone: async (_c, _o, _r, title) => {
        this.calls.push(`createMilestone:${title}`);
        const number = 4;
        this.milestones.set(title, number);
        return number;
      },
      setIssueDependencies: async (_c, _o, _r, number, ids) => {
        this.calls.push(`setIssueDependencies:${number}:${ids.join(",")}`);
      },
      ensureStatusFieldOptions: async (_c, projectId, options) => {
        const names = (options as ProjectV2StatusOptionInput[]).map((o) => o.name).join("|");
        this.calls.push(`ensureStatusFieldOptions:${projectId}:${names}`);
      },
    };
    return github as GitHubApi;
  }
}

test("buildIssueForSpec builds the main Issue: title, body = description + link + Sub-tasks checklist", () => {
  const payload = buildIssueForSpec(board, "G4.S5");
  assert.equal(
    payload.title,
    "G4.S5 Kanban ↔ GitHub Issues bidirectional sync + planning feedback loop",
  );
  assert.deepEqual(payload.labels, ["G4"]);
  assert.match(payload.body, /md files stay the single source of truth/);
  assert.match(payload.body, /docs\/kanban\/G4\/S5\/Spec\.md/);
  assert.match(payload.body, /## Sub-tasks/);
  assert.match(payload.body, /- \[x\] G4\.S5\.T1 GitHub GraphQL client \+ Project v2 API layer/);
  assert.match(payload.body, /- \[ \] G4\.S5\.T2 md→GitHub Project projection \+ sync CLI/);
});

test("stripRefPrefix strips a leading `Gx.Sy.Tz:` ref prefix from a title", () => {
  assert.equal(stripRefPrefix("G4.S5.T1: GitHub GraphQL client", "G4.S5.T1"), "GitHub GraphQL client");
  assert.equal(stripRefPrefix("G4.S5: Kanban sync", "G4.S5"), "Kanban sync");
  // No prefix → the title is returned unchanged.
  assert.equal(stripRefPrefix("Plain title", "G4.S5.T1"), "Plain title");
});

test("buildIssueForTicket includes description/status/assignee/blocked_by/link but never the Progress Log (T10 title = ref + stripped title)", () => {
  const payload = buildIssueForTicket(board, "G4.S5", "G4.S5.T2");
  assert.equal(payload.title, "G4.S5.T2 md→GitHub Project projection + sync CLI");
  assert.match(payload.body, /md is the source of truth/);
  assert.match(payload.body, /Build the projection/);
  assert.match(payload.body, /Tests green/);
  assert.match(payload.body, /\*\*Status:\*\* in_progress/);
  assert.match(payload.body, /\*\*Assignee:\*\* opencode/);
  assert.match(payload.body, /\*\*Blocked by:\*\* G4\.S5\.T1/);
  assert.match(payload.body, /docs\/kanban\/G4\/S5\/T2\.md/);
  assert.ok(!/Progress Log/.test(payload.body));
  assert.ok(!/working/.test(payload.body));
  assert.ok(!/claimed/.test(payload.body));
});

test("stripProgressLog drops the Progress Log + Log sections from a ticket body", () => {
  const stripped = stripProgressLog(board.goals[0].specs[0].tickets[1].body ?? "");
  assert.match(stripped, /Build the projection/);
  assert.ok(!/Progress Log/.test(stripped));
  assert.ok(!/working/.test(stripped));
  assert.ok(!/## Log/.test(stripped));
});

test("statusToColumn maps kanban status → Project Status option", () => {
  assert.equal(statusToColumn("backlog"), "Backlog");
  assert.equal(statusToColumn("in_progress"), "In Progress");
  assert.equal(statusToColumn("done"), "Done");
  assert.equal(statusToColumn("in_review"), "In Review");
  assert.equal(statusToColumn("approved"), "Approved");
  assert.equal(statusToColumn("rejected"), "Rejected");
  assert.equal(statusToColumn("canceled"), "Canceled");
});

test("blockedByToDeps resolves blocked_by refs to dependency issue ids", () => {
  const resolve = (ref: string): number | null =>
    ref === "G4.S5.T1" ? 905 : ref === "G4.S5.T2" ? 906 : null;
  assert.deepEqual(blockedByToDeps(["G4.S5.T1"], resolve), [905]);
  assert.deepEqual(blockedByToDeps(["G4.S5.T1", "G4.S5.T2"], resolve), [905, 906]);
  assert.deepEqual(blockedByToDeps(["G4.S5.T1", "G4.S9"], resolve), [905]);
  assert.deepEqual(blockedByToDeps([], resolve), []);
});

test("goalToMilestoneAndLabel derives the Goal milestone + label", () => {
  const { milestone, label } = goalToMilestoneAndLabel(board.goals[0].goal);
  assert.equal(milestone, "M4");
  assert.equal(label, "G4");
});

test("goalToMilestoneAndLabel returns null milestone + ref label when the Goal has no milestone", () => {
  const goal = { ...board.goals[0].goal, milestone: undefined };
  const { milestone, label } = goalToMilestoneAndLabel(goal);
  assert.equal(milestone, null);
  assert.equal(label, "G4");
});

test("createSpecIssue creates the Spec Issue + Ticket sub-issues with milestone/label/status/blocked_by", async () => {
  const github = new RecordingGithub();
  const result = await createSpecIssue(github.asApi(), tokenCredential, "caleo", "athena", board, "G4.S5", project);

  assert.equal(result.specRef, "G4.S5");
  assert.equal(result.created, true);
  assert.equal(result.specIssue.title, "G4.S5 Kanban ↔ GitHub Issues bidirectional sync + planning feedback loop");
  assert.equal(result.specIssue.number, 10);
  assert.equal(result.tickets.length, 2);
  assert.deepEqual(
    result.tickets.map((t) => ({ ref: t.ref, created: t.created })),
    [
      { ref: "G4.S5.T1", created: true },
      { ref: "G4.S5.T2", created: true },
    ],
  );

  assert.ok(github.calls.some((c) => c.startsWith("createIssue:G4.S5 Kanban")));
  assert.ok(github.calls.includes("createSubIssue:10:G4.S5.T1 GitHub GraphQL client + Project v2 API layer"));
  assert.ok(github.calls.includes("createSubIssue:10:G4.S5.T2 md→GitHub Project projection + sync CLI"));
  // Goal milestone created once and applied to all issues.
  assert.ok(github.calls.includes("createMilestone:M4"));
  assert.equal(github.calls.filter((c) => c === "setMilestone:10:4").length, 1);
  assert.equal(github.calls.filter((c) => c === "setMilestone:11:4").length, 1);
  assert.equal(github.calls.filter((c) => c === "setMilestone:12:4").length, 1);
  // Goal label on every issue.
  assert.ok(github.calls.includes("addLabel:10:G4"));
  assert.ok(github.calls.includes("addLabel:11:G4"));
  assert.ok(github.calls.includes("addLabel:12:G4"));
  // T9 (revert T6): the Spec AND every ticket sub-issue land on the Project —
  // each is its own card, GitHub-native.
  assert.equal(github.calls.filter((c) => c.startsWith("addIssueToProject:PVT_1:")).length, 3);
  assert.ok(github.calls.includes("addIssueToProject:PVT_1:I_kwDO10:10"));
  assert.ok(github.calls.includes("addIssueToProject:PVT_1:I_kwDO11:11"));
  assert.ok(github.calls.includes("addIssueToProject:PVT_1:I_kwDO12:12"));
  // The Spec card's Status column reflects the md Spec status (in_progress → In Progress).
  assert.ok(github.calls.some((c) => c.startsWith("ensureStatusFieldOptions:PVT_1:")));
  assert.ok(github.calls.includes("setItemStatusField:PVT_1:PVTI_10:In Progress"));
  // Ticket sub-issue cards are synced to their own Status columns
  // (T1 done → Done, T2 in_progress → In Progress) via the syncTicketStatus path.
  assert.ok(github.calls.includes("setItemStatusField:PVT_1:PVTI_11:Done"));
  assert.ok(github.calls.includes("setItemStatusField:PVT_1:PVTI_12:In Progress"));
  // Done/approved sub-issues close (native + segmented sub-task progress); others stay open.
  assert.ok(github.calls.includes("updateIssue:11::closed"));
  assert.ok(github.calls.includes("updateIssue:12::open"));
  // T2 is blocked by T1 → issue dependency (T1's issue id = 901).
  assert.ok(github.calls.includes("setIssueDependencies:12:901"));
});

test("createSpecIssue is idempotent: re-run updates in place, never duplicates", async () => {
  const specIssue: GithubIssue = {
    id: 900, node_id: "I_kwDO10", number: 10, title: "G4.S5 Kanban ↔ GitHub Issues bidirectional sync + planning feedback loop",
    state: "open", html_url: "", user_login: "alice", body: "old", labels: [], assignees: [],
  };
  const t1Issue: GithubIssue = {
    id: 901, node_id: "I_kwDO11", number: 11, title: "G4.S5.T1",
    state: "open", html_url: "", user_login: "alice", body: "old", labels: [], assignees: [],
  };
  const t2Issue: GithubIssue = {
    id: 902, node_id: "I_kwDO12", number: 12, title: "G4.S5.T2",
    state: "open", html_url: "", user_login: "alice", body: "old", labels: [], assignees: [],
  };
  const github = new RecordingGithub([specIssue, t1Issue, t2Issue], { milestones: { M4: 4 } });
  const first = await createSpecIssue(github.asApi(), tokenCredential, "caleo", "athena", board, "G4.S5", project);
  assert.equal(first.created, false);
  assert.equal(first.tickets.every((t) => t.created === false), true);

  const creates = github.calls.filter(
    (c) => c.startsWith("createIssue:") || c.startsWith("createSubIssue:"),
  );
  assert.deepEqual(creates, []);

  const updates = github.calls.filter((c) => c.startsWith("updateIssue:"));
  assert.equal(updates.length, 3);
  assert.ok(updates.some((c) => c.startsWith("updateIssue:10:")));
  assert.ok(updates.some((c) => c.startsWith("updateIssue:11:")));
  assert.ok(updates.some((c) => c.startsWith("updateIssue:12:")));

  // Milestone not recreated on re-run.
  assert.equal(github.calls.filter((c) => c === "createMilestone:M4").length, 0);
});

test("createSpecIssue syncs the Spec main issue open/closed to the md Spec status (G4.S6.T2)", async () => {
  // Update path: an existing spec issue in an in_progress spec stays open; a
  // done spec closes it, so the Project Status column and issue list agree.
  const specIssue: GithubIssue = {
    id: 900, node_id: "I_kwDO10", number: 10, title: "G4.S5 Kanban ↔ GitHub Issues bidirectional sync + planning feedback loop",
    state: "open", html_url: "", user_login: "alice", body: "old", labels: [], assignees: [],
  };
  const t1Issue: GithubIssue = {
    id: 901, node_id: "I_kwDO11", number: 11, title: "G4.S5.T1",
    state: "open", html_url: "", user_login: "alice", body: "old", labels: [], assignees: [],
  };
  const t2Issue: GithubIssue = {
    id: 902, node_id: "I_kwDO12", number: 12, title: "G4.S5.T2",
    state: "open", html_url: "", user_login: "alice", body: "old", labels: [], assignees: [],
  };
  // Board fixture's G4.S5 spec is in_progress → the existing issue must stay open.
  const github = new RecordingGithub([specIssue, t1Issue, t2Issue], { milestones: { M4: 4 } });
  await createSpecIssue(github.asApi(), tokenCredential, "caleo", "athena", board, "G4.S5", project);
  const specUpdate = github.calls.find((c) => c.startsWith("updateIssue:10:"));
  assert.ok(specUpdate, "the existing Spec main issue is updated");
  assert.ok(specUpdate!.endsWith(":open"), "in_progress spec issue stays open");

  // A done spec closes its existing main issue.
  const doneBoard: KanbanBoard = {
    ...board,
    goals: board.goals.map((goal) => ({
      ...goal,
      specs: goal.specs.map((spec) =>
        spec.ref === "G4.S5" ? { ...spec, spec: { ...spec.spec, status: "done" } } : spec,
      ),
    })),
  };
  const github2 = new RecordingGithub([specIssue, t1Issue, t2Issue], { milestones: { M4: 4 } });
  await createSpecIssue(github2.asApi(), tokenCredential, "caleo", "athena", doneBoard, "G4.S5", project);
  const specUpdateDone = github2.calls.find((c) => c.startsWith("updateIssue:10:"));
  assert.ok(specUpdateDone!.endsWith(":closed"), "done spec issue is closed");

  // Create path: a freshly created spec issue in a done spec closes right away.
  const github3 = new RecordingGithub([], { milestones: { M4: 4 } });
  await createSpecIssue(github3.asApi(), tokenCredential, "caleo", "athena", doneBoard, "G4.S5", project);
  assert.ok(github3.calls.some((c) => c.startsWith("createIssue:G4.S5 Kanban")));
  assert.ok(
    github3.calls.some((c) => c.startsWith("updateIssue:10:") && c.endsWith(":closed")),
    "freshly created done-spec issue is closed",
  );
});

test("createSpecIssue updates a sub-issue created with the bare-ref title, not a duplicate (T10)", async () => {
  // Pre-T10 syncs created ticket sub-issues with ONLY the ref as their title
  // (`G4.S5.T1`). The next sync must find them and update the title in place
  // instead of creating a second sub-issue.
  const t1Issue: GithubIssue = {
    id: 901, node_id: "I_kwDO11", number: 11, title: "G4.S5.T1",
    state: "open", html_url: "", user_login: "alice", body: "old", labels: [], assignees: [],
  };
  const t2Issue: GithubIssue = {
    id: 902, node_id: "I_kwDO12", number: 12, title: "G4.S5.T2",
    state: "open", html_url: "", user_login: "alice", body: "old", labels: [], assignees: [],
  };
  const github = new RecordingGithub([t1Issue, t2Issue], { milestones: { M4: 4 } });
  const result = await createSpecIssue(github.asApi(), tokenCredential, "caleo", "athena", board, "G4.S5", project);

  assert.equal(result.tickets.every((t) => t.created === false), true, "no new sub-issues created");
  assert.equal(
    github.calls.filter((c) => c.startsWith("createSubIssue:")).length,
    0,
    "existing bare-ref sub-issues are updated, never duplicated",
  );
  // The updated sub-issues now carry the ref + stripped title.
  const t1 = [...github.issues.values()].find((i) => i.number === 11)!;
  const t2 = [...github.issues.values()].find((i) => i.number === 12)!;
  assert.equal(t1.title, "G4.S5.T1 GitHub GraphQL client + Project v2 API layer");
  assert.equal(t2.title, "G4.S5.T2 md→GitHub Project projection + sync CLI");
});

test("createSpecIssue ensures the merged Status options cover the Spec lifecycle columns (G4.S5.T7)", async () => {
  const github = new RecordingGithub();
  await createSpecIssue(github.asApi(), tokenCredential, "caleo", "athena", board, "G4.S5", project);
  const call = github.calls.find((c) => c.startsWith("ensureStatusFieldOptions:PVT_1:"));
  assert.ok(call, "ensureStatusFieldOptions was called with the Project");
  const names = call!.split(":").slice(2).join(":").split("|");
  for (const column of ["Backlog", "In Progress", "Done", "In Review", "Approved", "Rejected", "Canceled"]) {
    assert.ok(names.includes(column), `Status options include ${column}`);
  }
});

test("syncTicketStatus moves a ticket's card to the right Status column", async () => {
  const github = new RecordingGithub();
  github.items.push({
    id: "PVTI_20", issueId: "I_kwDO20", issueNumber: 20, title: "G4.S5.T2", status: null,
  });
  await syncTicketStatus(github.asApi(), tokenCredential, "caleo", "athena", project, 20, "done");
  assert.ok(github.calls.includes("setItemStatusField:PVT_1:PVTI_20:Done"));
});

test("syncTicketStatus adds the card to the Project when missing, then sets the status", async () => {
  const github = new RecordingGithub();
  const issue: GithubIssue = {
    id: 905, node_id: "I_kwDO21", number: 21, title: "G4.S5.T2",
    state: "open", html_url: "", user_login: "alice", body: "b", labels: [], assignees: [],
  };
  github.issues.set(issue.number, issue);
  await syncTicketStatus(github.asApi(), tokenCredential, "caleo", "athena", project, 21, "in_review");
  assert.ok(github.calls.includes("getIssue:21"));
  assert.ok(github.calls.includes("addIssueToProject:PVT_1:I_kwDO21:21"));
  assert.ok(github.calls.includes("setItemStatusField:PVT_1:PVTI_21:In Review"));
});

test("syncBlockedBy sets the issue dependencies for a ticket's blocked_by refs", async () => {
  const github = new RecordingGithub();
  await syncBlockedBy(
    github.asApi(),
    tokenCredential,
    "caleo",
    "athena",
    12,
    ["G4.S5.T1", "G4.S5.T3"],
    (ref) => (ref === "G4.S5.T1" ? 905 : ref === "G4.S5.T3" ? 907 : null),
  );
  assert.ok(github.calls.includes("setIssueDependencies:12:905,907"));
});

test("syncBlockedBy skips the call when blocked_by resolves to nothing", async () => {
  const github = new RecordingGithub();
  await syncBlockedBy(github.asApi(), tokenCredential, "caleo", "athena", 12, ["G4.S9"], () => null);
  assert.equal(github.calls.some((c) => c.startsWith("setIssueDependencies")), false);
});

test("syncSpecStatus moves the Spec card to the column for its md Spec status (G4.S5.T6)", async () => {
  const github = new RecordingGithub();
  github.items.push({
    id: "PVTI_30", issueId: "I_kwDO30", issueNumber: 30, title: "G4.S5 Kanban sync", status: null,
  });
  await syncSpecStatus(github.asApi(), tokenCredential, "caleo", "athena", project, 30, "active");
  assert.ok(github.calls.includes("setItemStatusField:PVT_1:PVTI_30:In Progress"));
});

test("syncSpecStatus maps backlog/done spec statuses to Backlog/Done (G4.S5.T6)", async () => {
  const github = new RecordingGithub();
  github.items.push({
    id: "PVTI_31", issueId: "I_kwDO31", issueNumber: 31, title: "G4.S6", status: null,
  });
  await syncSpecStatus(github.asApi(), tokenCredential, "caleo", "athena", project, 31, "backlog");
  assert.ok(github.calls.includes("setItemStatusField:PVT_1:PVTI_31:Backlog"));
  await syncSpecStatus(github.asApi(), tokenCredential, "caleo", "athena", project, 31, "done");
  assert.ok(github.calls.includes("setItemStatusField:PVT_1:PVTI_31:Done"));
});

test("syncSpecStatus leaves the card untouched for an unknown Spec status (G4.S5.T6)", async () => {
  const github = new RecordingGithub();
  github.items.push({
    id: "PVTI_32", issueId: "I_kwDO32", issueNumber: 32, title: "G4.S7", status: null,
  });
  await syncSpecStatus(github.asApi(), tokenCredential, "caleo", "athena", project, 32, "weird");
  assert.equal(github.calls.some((c) => c.startsWith("setItemStatusField")), false);
});

test("syncSpecStatus adds the Spec card to the Project when missing, then sets the status (G4.S5.T6)", async () => {
  const github = new RecordingGithub();
  const issue: GithubIssue = {
    id: 906, node_id: "I_kwDO33", number: 33, title: "G4.S8", state: "open",
    html_url: "", user_login: "alice", body: "b", labels: [], assignees: [],
  };
  github.issues.set(issue.number, issue);
  await syncSpecStatus(github.asApi(), tokenCredential, "caleo", "athena", project, 33, "active");
  assert.ok(github.calls.includes("getIssue:33"));
  assert.ok(github.calls.includes("addIssueToProject:PVT_1:I_kwDO33:33"));
  assert.ok(github.calls.includes("setItemStatusField:PVT_1:PVTI_33:In Progress"));
});

test("ticketState closes done/approved/canceled sub-issues, opens everything else (G4.S5.T6)", () => {
  assert.equal(ticketState("done"), "closed");
  assert.equal(ticketState("approved"), "closed");
  assert.equal(ticketState("canceled"), "closed"); // canceled is terminal — drops out of progress
  assert.equal(ticketState("in_progress"), "open");
  assert.equal(ticketState("backlog"), "open");
  assert.equal(ticketState("in_review"), "open");
});

test("specIssueState closes the spec MAIN issue on done/approved/canceled, opens otherwise (G4.S6.T2)", () => {
  assert.equal(specIssueState("done"), "closed");
  assert.equal(specIssueState("approved"), "closed");
  assert.equal(specIssueState("canceled"), "closed");
  assert.equal(specIssueState("backlog"), "open");
  assert.equal(specIssueState("in_progress"), "open");
  assert.equal(specIssueState("in_review"), "open");
  assert.equal(specIssueState("rejected"), "open");
});

test("subTaskProgress counts a Spec's closed sub-issues over its total (G4.S5.T6)", () => {
  const issues: GithubIssue[] = [
    { id: 1, node_id: "i1", number: 2, title: "G4.S5.T1", state: "closed", html_url: "", user_login: "a", body: null, labels: [], assignees: [] },
    { id: 2, node_id: "i2", number: 3, title: "G4.S5.T2", state: "open", html_url: "", user_login: "a", body: null, labels: [], assignees: [] },
    { id: 3, node_id: "i3", number: 4, title: "G4.S5.T3", state: "closed", html_url: "", user_login: "a", body: null, labels: [], assignees: [] },
    // Not a sub-issue of G4.S5: a sibling spec's ticket + the spec issue itself.
    { id: 4, node_id: "i4", number: 5, title: "G4.S5.T10", state: "closed", html_url: "", user_login: "a", body: null, labels: [], assignees: [] },
    { id: 5, node_id: "i5", number: 6, title: "G4.S5 Workbench", state: "open", html_url: "", user_login: "a", body: null, labels: [], assignees: [] },
    { id: 6, node_id: "i6", number: 7, title: "G4.S6.T1", state: "closed", html_url: "", user_login: "a", body: null, labels: [], assignees: [] },
  ];
  // G4.S5 sub-issues: T1/T3/T10 closed, T2 open → 3/4 = 75%. The spec issue
  // itself ("G4.S5 Workbench") and a sibling spec's ticket (G4.S6.T1) don't count.
  assert.deepEqual(subTaskProgress("G4.S5", issues), { done: 3, total: 4, percent: 75 });
  assert.deepEqual(subTaskProgress("G4.S6", issues), { done: 1, total: 1, percent: 100 });
  assert.deepEqual(subTaskProgress("G4.S9", issues), { done: 0, total: 0, percent: 0 });
  assert.deepEqual(subTaskProgress(null, issues), { done: 0, total: 0, percent: 0 });
});

// ---------------------------------------------------------------------------
// G4.S5.T8 — Spec card sub-issues (detail panel list)
// ---------------------------------------------------------------------------

function tIssue(id: number, number: number, title: string, state: string): GithubIssue {
  return { id, node_id: `I_${number}`, number, title, state, html_url: "", user_login: "alice", body: null, labels: [], assignees: [] };
}

test("subIssuesForSpec lists a Spec's ticket sub-issues (ref/title/status/number) (G4.S5.T8)", () => {
  const issues: GithubIssue[] = [
    tIssue(1, 2, "G4.S5.T1 GitHub GraphQL client", "closed"),
    tIssue(2, 3, "G4.S5.T2 md→GitHub projection", "open"),
    tIssue(3, 4, "G4.S5.T3 Feedback loop", "open"),
    tIssue(4, 5, "G4.S5.T10 Workbench", "open"),
    // The Spec issue itself + a sibling spec's ticket are NOT sub-issues.
    tIssue(5, 6, "G4.S5 Workbench", "open"),
    tIssue(6, 7, "G4.S6.T1 KB lifecycle", "closed"),
  ];
  // closed → status "done"; sorted by ref so T1..T10 read in order.
  assert.deepEqual(subIssuesForSpec("G4.S5", issues), [
    { ref: "G4.S5.T1", title: "G4.S5.T1 GitHub GraphQL client", status: "done", number: 2 },
    { ref: "G4.S5.T2", title: "G4.S5.T2 md→GitHub projection", status: "open", number: 3 },
    { ref: "G4.S5.T3", title: "G4.S5.T3 Feedback loop", status: "open", number: 4 },
    { ref: "G4.S5.T10", title: "G4.S5.T10 Workbench", status: "open", number: 5 },
  ]);
  assert.deepEqual(subIssuesForSpec(null, issues), []);
  assert.deepEqual(subIssuesForSpec("G4.S9", issues), []);
});

test("buildGithubProjectBoard populates progress + subIssues for ANY card whose issue is a parent of sub-issues (non-Gx.Sy) (G4.S5.T18)", () => {
  const project: GithubProject = {
    id: "PVT_abap",
    title: "Abaplorer Project",
    number: 9,
    url: "https://github.com/orgs/caleo/projects/9",
  };
  const items: GithubProjectItem[] = [
    // abaplorer #201 'ABAP Object Import' — plain title, NO Gx.Sy ref, but the
    // parent of 9 sub-issues (#202-#210). T18: it must show progress + the list.
    { id: "PVTI_201", issueId: "I_201", issueNumber: 201, title: "ABAP Object Import", status: "Done" },
    // A sub-issue card (#202) is on the board too — it must stay plain.
    { id: "PVTI_202", issueId: "I_202", issueNumber: 202, title: "Import tables", status: "Done" },
  ];
  const sub = (id: number, number: number, title: string, state: string): GithubIssue => ({
    id,
    node_id: `I_${number}`,
    number,
    title,
    state,
    html_url: "",
    user_login: "alice",
    body: null,
    labels: [],
    assignees: [],
    // GitHub sub-issues relationship: each sub-issue's parent_issue_url → #201.
    parent_issue_url: "https://api.github.com/repos/caleo/abaplorer/issues/201",
  });
  const issues: GithubIssue[] = [
    { id: 201, node_id: "I_201", number: 201, title: "ABAP Object Import", state: "open", html_url: "", user_login: "alice", body: null, labels: [], assignees: [] },
    sub(202, 202, "Import tables", "closed"),
    sub(203, 203, "Import BADI", "closed"),
    sub(204, 204, "Import user-exits", "open"),
  ];
  const board = buildGithubProjectBoard(
    project,
    items,
    issues,
    (n) => `https://github.com/caleo/abaplorer/issues/${n}`,
  );
  const card = board.columns[0].cards[0];
  assert.equal(card.ref, null, "no Gx.Sy ref parsed from a plain parent title");
  assert.equal(card.title, "ABAP Object Import");
  // Progress from the ACTUAL sub-issues (2 closed / 3 total) regardless of naming.
  assert.deepEqual(card.progress, { done: 2, total: 3, percent: 67 });
  assert.deepEqual(card.subIssues, [
    { ref: null, title: "Import tables", status: "done", number: 202 },
    { ref: null, title: "Import BADI", status: "done", number: 203 },
    { ref: null, title: "Import user-exits", status: "open", number: 204 },
  ]);
  // The sub-issue card (#202) is plain: no progress, no nested sub-issues.
  const subCard = board.columns[0].cards[1];
  assert.equal(subCard.ref, null);
  assert.deepEqual(subCard.progress, { done: 0, total: 0, percent: 0 });
  assert.deepEqual(subCard.subIssues, []);
});

test("buildGithubProjectBoard carries each Spec card's subIssues + renders ticket cards spread across columns (G4.S5.T8/T9)", () => {
  const project: GithubProject = { id: "PVT_1", title: "athena-agent", number: 3, url: "" };
  const items: GithubProjectItem[] = [
    { id: "PVTI_1", issueId: "I_1", issueNumber: 1, title: "G4.S5 Workbench", status: "Backlog" },
    // T9 (revert T6): a ticket item IS a card now — it lands in its own Status column.
    { id: "PVTI_2", issueId: "I_2", issueNumber: 2, title: "G4.S5.T1", status: "Done" },
  ];
  const issues: GithubIssue[] = [
    tIssue(1, 2, "G4.S5.T1 GitHub GraphQL client", "closed"),
    tIssue(2, 3, "G4.S5.T2 md→GitHub projection", "open"),
    tIssue(3, 4, "G4.S5.T3 Feedback loop", "open"),
  ];
  const board = buildGithubProjectBoard(
    project,
    items,
    issues,
    (n) => `https://github.com/zouhanhai/athena-agent/issues/${n}`,
  );
  // The Spec card sits in Backlog; the ticket sub-issue card in its Done column.
  assert.deepEqual(
    board.columns.map((c) => c.cards.map((card) => card.ref)),
    [["G4.S5"], ["G4.S5.T1"]],
  );
  const card = board.columns[0].cards[0];
  assert.equal(card.ref, "G4.S5");
  assert.deepEqual(card.subIssues, [
    { ref: "G4.S5.T1", title: "G4.S5.T1 GitHub GraphQL client", status: "done", number: 2 },
    { ref: "G4.S5.T2", title: "G4.S5.T2 md→GitHub projection", status: "open", number: 3 },
    { ref: "G4.S5.T3", title: "G4.S5.T3 Feedback loop", status: "open", number: 4 },
  ]);
  // The ticket card is plain: no sub-task progress, no nested sub-issues.
  const ticket = board.columns[1].cards[0];
  assert.equal(ticket.ref, "G4.S5.T1");
  assert.equal(ticket.status, "Done");
  assert.deepEqual(ticket.progress, { done: 0, total: 0, percent: 0 });
  assert.deepEqual(ticket.subIssues, []);
});


