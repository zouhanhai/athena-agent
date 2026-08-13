import { test } from "node:test";
import assert from "node:assert/strict";
import { GithubGraphqlClient } from "../src/github/graphql.js";
import { GithubAuthError, GithubCredentialUnsupportedError } from "../src/github/client.js";

function mockFetch(
  handler: (url: string, init: RequestInit) => Promise<{ status: number; body: unknown }>,
): typeof fetch {
  return (async (input, init) => {
    const { status, body } = await handler(String(input), init ?? {});
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

const tokenCredential = { type: "token" as const, value: "ghp_testtoken" };

function projectNode(
  id: string,
  title: string,
  number: number,
  closed: boolean,
): { id: string; title: string; number: number; url: string; closed: boolean } {
  return {
    id,
    title,
    number,
    url: `https://github.com/zouhanhai/athena-agent/projects/${number}`,
    closed,
  };
}

test("getRepoProjects queries repository{projectsV2} and returns only OPEN projects (G4.S5.T12)", async () => {
  let sentQuery = "";
  const client = new GithubGraphqlClient({
    baseUrl: "https://api.github.test/graphql",
    fetchImpl: mockFetch(async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
      sentQuery = body.query;
      assert.equal(body.variables.owner, "zouhanhai");
      assert.equal(body.variables.name, "athena-agent");
      return {
        status: 200,
        body: {
          data: {
            repository: {
              projectsV2: {
                nodes: [
                  projectNode("PVT_open", "zouhanhai/athena-agent", 3, false),
                  projectNode("PVT_closed", "@zouhanhai's untitled project", 2, true),
                ],
              },
            },
          },
        },
      };
    }),
  });

  const projects = await client.getRepoProjects(tokenCredential, "zouhanhai", "athena-agent");

  // The query resolves projects via repository{projectsV2} and selects `closed`.
  assert.match(sentQuery, /repository\(owner: \$owner, name: \$name\)/);
  assert.match(sentQuery, /projectsV2\(first: \$first\)/);
  assert.match(sentQuery, /\bclosed\b/);

  // The CLOSED linked project is filtered out; only the open one is returned.
  assert.deepEqual(projects, [
    {
      id: "PVT_open",
      title: "zouhanhai/athena-agent",
      number: 3,
      url: "https://github.com/zouhanhai/athena-agent/projects/3",
    },
  ]);
});

test("getRepoProjects returns an empty list when every linked project is closed", async () => {
  const client = new GithubGraphqlClient({
    baseUrl: "https://api.github.test/graphql",
    fetchImpl: mockFetch(async () => ({
      status: 200,
      body: {
        data: {
          repository: {
            projectsV2: {
              nodes: [
                projectNode("PVT_closed_1", "@zouhanhai's untitled project", 1, true),
                projectNode("PVT_closed_2", "another closed", 2, true),
              ],
            },
          },
        },
      },
    })),
  });

  const projects = await client.getRepoProjects(tokenCredential, "zouhanhai", "athena-agent");
  assert.deepEqual(projects, []);
});

test("getRepoProjects keeps every project open order when none are closed", async () => {
  const client = new GithubGraphqlClient({
    baseUrl: "https://api.github.test/graphql",
    fetchImpl: mockFetch(async () => ({
      status: 200,
      body: {
        data: {
          repository: {
            projectsV2: {
              nodes: [
                projectNode("PVT_a", "Project A", 1, false),
                projectNode("PVT_b", "Project B", 2, false),
              ],
            },
          },
        },
      },
    })),
  });

  const projects = await client.getRepoProjects(tokenCredential, "zouhanhai", "athena-agent");
  assert.deepEqual(
    projects.map((p) => p.id),
    ["PVT_a", "PVT_b"],
  );
});

test("getRepoProjects returns an empty list when the repo cannot be resolved", async () => {
  const client = new GithubGraphqlClient({
    baseUrl: "https://api.github.test/graphql",
    fetchImpl: mockFetch(async () => ({
      status: 200,
      body: { data: null, errors: [{ message: "Could not resolve to a Repository" }] },
    })),
  });

  const projects = await client.getRepoProjects(tokenCredential, "nobody", "missing");
  assert.deepEqual(projects, []);
});

test("getRepoProjects rejects an ssh credential (GraphQL needs a token)", async () => {
  const client = new GithubGraphqlClient({ fetchImpl: mockFetch(async () => ({ status: 200, body: {} })) });
  await assert.rejects(
    client.getRepoProjects({ type: "ssh", value: "ssh-ed25519 key" }, "zouhanhai", "athena-agent"),
    GithubCredentialUnsupportedError,
  );
});

test("getRepoProjects maps a 401 GitHub response to GithubAuthError", async () => {
  const client = new GithubGraphqlClient({ fetchImpl: mockFetch(async () => ({ status: 401, body: {} })) });
  await assert.rejects(client.getRepoProjects(tokenCredential, "zouhanhai", "athena-agent"), GithubAuthError);
});
