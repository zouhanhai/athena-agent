import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import {
  MagicLinkAuthService,
  MemoryAuthTokenStore,
  type MagicLinkMailer,
} from "../src/employees/auth.js";
import { createSecretCipher } from "../src/employees/crypto.js";
import { MemoryEmployeeRegistry, type GithubCredential } from "../src/employees/employees.js";
import { renderBoardMd } from "../src/kanban/frontmatter.js";
import type { RemoteBoardSource } from "../src/kanban/scan.js";
import {
  FileKanbanIndex,
  defaultBoardRoot,
  type KanbanIndex,
  type KanbanIndexService,
} from "../src/kanban/index-file.js";
import type { GithubFileContent, GithubTreeEntry, GitHubApi } from "../src/github/client.js";
import { GithubAuthError } from "../src/github/client.js";
import type { GithubIssue, GithubIssueComment, GithubProject, GithubProjectItem } from "../src/github/client.js";
import type { GithubProjectBoard } from "../src/kanban/github-sync.js";

const TEST_CIPHER = createSecretCipher("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");

interface SentMail {
  to: string;
  magicLinkUrl: string;
}

function tokenFromUrl(url: string): string {
  const match = /[?&]token=([^&]+)/.exec(url);
  assert.ok(match, `magic link should carry a token: ${url}`);
  return decodeURIComponent(match[1]);
}

const INDEX_SAMPLE: KanbanIndex = {
  version: 1,
  generated_at: "2026-08-09T16:00:00Z",
  goals: [
    {
      ref: "G1",
      id: "g1",
      title: "G1: goal",
      owner: "consultant",
      status: "active",
      milestone: "M3",
      specs: [
        {
          ref: "G1.S1",
          id: "g1_s1",
          title: "G1.S1: spec",
          owner: "pm",
          status: "active",
          milestone: "M3",
          tickets: [
            {
              ref: "G1.S1.T1",
              id: "t1",
              title: "G1.S1.T1: ticket",
              owner: "eng-director",
              status: "done",
              assignee: "opencode",
              session_id: "ses_x",
              blocked_by: [],
              acceptance_criteria: ["works"],
              progress_last_row: "Implemented the board",
              progress_updated_at: "2026-08-09T15:50:00Z",
            },
          ],
        },
      ],
    },
  ],
  errors: [],
};

class FakeKanbanIndex implements KanbanIndexService {
  readonly reads: number[] = [];
  readonly rescans: number[] = [];
  constructor(private readonly result: KanbanIndex | Error) {}
  async read(): Promise<KanbanIndex> {
    this.reads.push(1);
    if (this.result instanceof Error) {
      throw this.result;
    }
    return this.result;
  }
  async rescan(): Promise<KanbanIndex> {
    this.rescans.push(1);
    if (this.result instanceof Error) {
      throw this.result;
    }
    return this.result;
  }
}

let app: FastifyInstance;
let sent: SentMail[];

/** Build a fresh app with its own registry/auth so closing one never affects another. */
function makeApp(
  index?: KanbanIndexService,
  github?: GitHubApi,
  employees?: MemoryEmployeeRegistry,
): FastifyInstance {
  const registry =
    employees ??
    new MemoryEmployeeRegistry(
      [
        { email: "alice@caleo.com", display_name: "Alice", role: "member" },
        { email: "admin@caleo.com", display_name: "Admin", role: "admin" },
      ],
      { cipher: TEST_CIPHER },
    );
  const mailer: MagicLinkMailer = {
    async sendLoginLink(input) {
      sent.push(input);
    },
  };
  const auth = new MagicLinkAuthService({
    registry,
    mailer,
    tokens: new MemoryAuthTokenStore(),
    appBaseUrl: "http://localhost:5173",
  });
  return buildApp({ employees: registry, auth, index, github });
}

beforeEach(async () => {
  sent = [];
  app = makeApp();
});

after(async () => {
  if (app) {
    await app.close();
  }
});

async function login(email: string): Promise<string> {
  await app.inject({ method: "POST", url: "/api/auth/login", payload: { email } });
  const token = tokenFromUrl(sent[sent.length - 1].magicLinkUrl);
  const res = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { token } });
  assert.equal(res.statusCode, 200);
  return (res.json() as { session_token: string }).session_token;
}

function bearer(sessionToken: string): Record<string, string> {
  return { authorization: `Bearer ${sessionToken}` };
}

test("GET /api/kanban requires authentication", async () => {
  const res = await app.inject({ method: "GET", url: "/api/kanban" });
  assert.equal(res.statusCode, 401);
});

test("GET /api/kanban serves the root index without scanning", async () => {
  const index = new FakeKanbanIndex(INDEX_SAMPLE);
  await app.close();
  app = makeApp(index);
  const sessionToken = await login("alice@caleo.com");

  const res = await app.inject({ method: "GET", url: "/api/kanban", headers: bearer(sessionToken) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), INDEX_SAMPLE);
  assert.equal(index.reads.length, 1, "the fast path must read the index");
  assert.equal(index.rescans.length, 0, "a plain GET must not rescan");
});

test("GET /api/kanban?rescan=1 forces a rescan and rebuilds the index", async () => {
  const index = new FakeKanbanIndex(INDEX_SAMPLE);
  await app.close();
  app = makeApp(index);
  const sessionToken = await login("alice@caleo.com");

  const res = await app.inject({
    method: "GET",
    url: "/api/kanban?rescan=1",
    headers: bearer(sessionToken),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), INDEX_SAMPLE);
  assert.equal(index.rescans.length, 1, "rescan=1 must rebuild the index");
  assert.equal(index.reads.length, 0);
});

test("GET /api/kanban surfaces an index read failure as 500", async () => {
  const failing = new FakeKanbanIndex(new Error("disk read failed"));
  await app.close();
  app = makeApp(failing);
  const sessionToken = await login("alice@caleo.com");

  const res = await app.inject({ method: "GET", url: "/api/kanban", headers: bearer(sessionToken) });
  assert.equal(res.statusCode, 500);
  assert.match(res.json().error, /disk read failed/);
});

test("GET /api/kanban with the default index reads the real repo board", async () => {
  await app.close();
  app = makeApp(new FileKanbanIndex(defaultBoardRoot()));
  const sessionToken = await login("alice@caleo.com");

  const res = await app.inject({ method: "GET", url: "/api/kanban", headers: bearer(sessionToken) });
  assert.equal(res.statusCode, 200);
  const body = res.json() as KanbanIndex;
  assert.equal(body.version, 1);
  assert.ok(body.generated_at, "the index must carry a generated_at timestamp");
  assert.ok(body.goals.some((g) => g.ref === "G3"), "default index should surface G3");
  const s6 = body.goals.find((g) => g.ref === "G3")?.specs.find((s) => s.ref === "G3.S6");
  assert.ok(s6, "G3.S6 must appear");
});

/** Remote board source backed by an in-memory docs/kanban tree + contents. */
class FakeRemoteGithub implements RemoteBoardSource {
  readonly treeFetches: GithubCredential[] = [];
  constructor(
    private readonly tree: GithubTreeEntry[],
    private readonly contents: Record<string, string>,
  ) {}
  async listTree(
    credential: GithubCredential,
    _owner: string,
    _repo: string,
    _ref?: string,
  ): Promise<GithubTreeEntry[]> {
    this.treeFetches.push(credential);
    return this.tree;
  }
  async getFileContent(
    _credential: GithubCredential,
    _owner: string,
    _repo: string,
    p: string,
    _ref?: string,
  ): Promise<GithubFileContent> {
    const content = this.contents[p];
    return { path: p, sha: "sss", size: content.length, content };
  }
}

function remoteTree(): GithubTreeEntry[] {
  const tree = (type: string, path: string): GithubTreeEntry => ({
    path,
    type,
    mode: "100644",
    sha: path,
    size: type === "blob" ? 12 : null,
  });
  return [
    tree("tree", "docs/kanban"),
    tree("tree", "docs/kanban/G1"),
    tree("blob", "docs/kanban/G1/Goal.md"),
    tree("tree", "docs/kanban/G1/S1"),
    tree("blob", "docs/kanban/G1/S1/Spec.md"),
    tree("blob", "docs/kanban/G1/S1/T1.md"),
  ];
}

function remoteContents(): Record<string, string> {
  return {
    "docs/kanban/G1/Goal.md": renderBoardMd({
      id: "g1",
      title: "G1: goal",
      layer: "G",
      owner: "consultant",
      status: "active",
      acceptance_criteria: ["done"],
    }, "# body\n"),
    "docs/kanban/G1/S1/Spec.md": renderBoardMd({
      id: "g1_s1",
      title: "G1.S1: spec",
      layer: "S",
      parent: "G1",
      owner: "pm",
      status: "active",
      acceptance_criteria: ["done"],
    }, "# body\n"),
    "docs/kanban/G1/S1/T1.md": renderBoardMd({
      id: "t1",
      title: "G1.S1.T1: ticket",
      layer: "T",
      parent: "G1.S1",
      owner: "eng-director",
      status: "in_progress",
      assignee: "opencode",
      session_id: "ses_remote",
      blocked_by: [],
      acceptance_criteria: ["works"],
    }, "# body\n"),
  };
}

test("GET /api/kanban?repo=owner/repo scans the selected repo and serves it as an index", async () => {
  const remote = new FakeRemoteGithub(remoteTree(), remoteContents());
  const employees = new MemoryEmployeeRegistry(
    [{ email: "alice@caleo.com", display_name: "Alice", role: "member", github_credential: { type: "token", value: "ghp_alice" } }],
    { cipher: TEST_CIPHER },
  );
  await app.close();
  app = makeApp(undefined, remote as unknown as GitHubApi, employees);
  const sessionToken = await login("alice@caleo.com");

  const res = await app.inject({
    method: "GET",
    url: "/api/kanban?repo=acme/box",
    headers: bearer(sessionToken),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as KanbanIndex;
  assert.equal(body.version, 1);
  assert.ok(body.generated_at, "remote boards are served in the index shape with a timestamp");
  assert.equal(body.goals.length, 1);
  assert.equal(body.goals[0].ref, "G1");
  const ticket = body.goals[0].specs[0].tickets[0];
  assert.equal(ticket.ref, "G1.S1.T1");
  assert.equal(ticket.status, "in_progress");
  assert.equal(ticket.assignee, "opencode");
  assert.equal(ticket.session_id, "ses_remote");
  assert.equal(remote.treeFetches.length, 1);
  assert.equal(remote.treeFetches[0].value, "ghp_alice", "the board must use the employee's credential");
});

test("GET /api/kanban?repo=owner/repo returns 400 when the user has no credential", async () => {
  const employees = new MemoryEmployeeRegistry(
    [{ email: "admin@caleo.com", display_name: "Admin", role: "admin" }],
    { cipher: TEST_CIPHER },
  );
  await app.close();
  app = makeApp(undefined, new FakeRemoteGithub(remoteTree(), remoteContents()) as unknown as GitHubApi, employees);
  const sessionToken = await login("admin@caleo.com");

  const res = await app.inject({
    method: "GET",
    url: "/api/kanban?repo=acme/box",
    headers: bearer(sessionToken),
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /no github credential/i);
});

test("GET /api/kanban?repo=invalid rejects a malformed repo", async () => {
  const sessionToken = await login("alice@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/kanban?repo=notarepo",
    headers: bearer(sessionToken),
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /owner\/repo/);
});

test("GET /api/kanban?repo=owner/repo requires authentication", async () => {
  const res = await app.inject({ method: "GET", url: "/api/kanban?repo=acme/box" });
  assert.equal(res.statusCode, 401);
});

// ---------------------------------------------------------------------------
// G4.S5.T4 — GET /api/kanban/github-project (synced GitHub Project board)
// ---------------------------------------------------------------------------

/** A RemoteBoardSource + Project v2 read surface, backed by in-memory maps. */
class FakeProjectGithub implements RemoteBoardSource {
  /** The comments the fake created via createIssueComment (issueNumber → body). */
  readonly createdComments: { issueNumber: number; body: string }[] = [];
  constructor(
    /** Repo-linked Projects v2, keyed by "owner/repo" (G4.S5.T11). */
    private readonly projectsByRepo: Map<string, GithubProject[]>,
    private readonly itemsByProject: Map<string, GithubProjectItem[]>,
    private readonly commentsByIssue: Map<number, GithubIssueComment[]> = new Map(),
    private readonly issuesByRepo: Map<string, GithubIssue[]> = new Map(),
  ) {}
  async createIssueComment(
    _credential: GithubCredential,
    _owner: string,
    _repo: string,
    issueNumber: number,
    body: string,
  ): Promise<GithubIssueComment> {
    this.createdComments.push({ issueNumber, body });
    const id = 500 + this.createdComments.length;
    return {
      id,
      user_login: "alice",
      body,
      created_at: "2026-08-13T12:00:00Z",
      html_url: `https://github.com/zouhanhai/athena-agent/issues/${issueNumber}#issuecomment-${id}`,
    };
  }
  async listTree(): Promise<GithubTreeEntry[]> {
    return [];
  }
  async getFileContent(): Promise<GithubFileContent> {
    return { path: "", sha: "", size: null, content: "" };
  }
  async getRepoProjects(
    _credential: GithubCredential,
    owner: string,
    repo: string,
  ): Promise<GithubProject[]> {
    return this.projectsByRepo.get(`${owner}/${repo}`) ?? [];
  }
  async getProjectItems(_credential: GithubCredential, projectId: string): Promise<GithubProjectItem[]> {
    return this.itemsByProject.get(projectId) ?? [];
  }
  async getIssueComments(
    _credential: GithubCredential,
    _owner: string,
    _repo: string,
    issueNumber: number,
  ): Promise<GithubIssueComment[]> {
    return this.commentsByIssue.get(issueNumber) ?? [];
  }
  async getIssue(
    _credential: GithubCredential,
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<GithubIssue> {
    const issues = this.issuesByRepo.get(`${owner}/${repo}`) ?? [];
    const found = issues.find((issue) => issue.number === issueNumber);
    if (!found) {
      throw new Error(`GitHub API error 404: issue ${issueNumber} not found`);
    }
    return found;
  }
  async listIssues(
    _credential: GithubCredential,
    owner: string,
    repo: string,
    _state: string,
  ): Promise<GithubIssue[]> {
    return this.issuesByRepo.get(`${owner}/${repo}`) ?? [];
  }
}

function projectGithub(): FakeProjectGithub {
  const project: GithubProject = {
    id: "PVT_1",
    title: "zouhanhai/athena-agent",
    number: 3,
    url: "https://github.com/zouhanhai/athena-agent/projects/3",
  };
  // T9 (revert T6): ticket sub-issues are cards too — each sits in its own
  // Status column spread across the board (GitHub-native). The draft item
  // (PVTI_4) has no linked issue and is skipped.
  const items: GithubProjectItem[] = [
    { id: "PVTI_1", issueId: "I_1", issueNumber: 1, title: "G4.S5 Workbench kanban sync", status: "Backlog" },
    { id: "PVTI_2", issueId: "I_2", issueNumber: 2, title: "G4.S5.T1", status: "Done" },
    { id: "PVTI_3", issueId: "I_3", issueNumber: 3, title: "G4.S5.T2", status: "In Progress" },
    { id: "PVTI_4", issueId: null, issueNumber: null, title: null, status: null },
    { id: "PVTI_5", issueId: "I_5", issueNumber: 5, title: "G4.S6 Knowledge lifecycle", status: "In Progress" },
  ];
  const issue = (number: number, title: string, state: string): GithubIssue => ({
    id: number, node_id: `I_${number}`, number, title, state, html_url: "", user_login: "alice", body: null, labels: [], assignees: [],
  });
  const issues: GithubIssue[] = [
    issue(2, "G4.S5.T1", "closed"),
    issue(3, "G4.S5.T2", "open"),
    issue(4, "G4.S5.T3", "closed"),
    issue(6, "G4.S5.T4", "closed"),
    issue(7, "G4.S5.T5", "open"),
    issue(8, "G4.S6.T1", "closed"),
    issue(9, "G4.S6.T2", "open"),
  ];
  return new FakeProjectGithub(
    new Map([["zouhanhai/athena-agent", [project]]]),
    new Map([[project.id, items]]),
    new Map(),
    new Map([["zouhanhai/athena-agent", issues]]),
  );
}

function credentialEmployee(): MemoryEmployeeRegistry {
  return new MemoryEmployeeRegistry(
    [
      {
        email: "alice@caleo.com",
        display_name: "Alice",
        role: "member",
        github_credential: { type: "token", value: "ghp_alice" },
      },
    ],
    { cipher: TEST_CIPHER },
  );
}

test("GET /api/kanban/github-project requires authentication", async () => {
  const res = await app.inject({ method: "GET", url: "/api/kanban/github-project?repo=acme/box" });
  assert.equal(res.statusCode, 401);
});

test("GET /api/kanban/github-project requires a repo param in owner/repo form", async () => {
  const sessionToken = await login("alice@caleo.com");
  const noRepo = await app.inject({
    method: "GET",
    url: "/api/kanban/github-project",
    headers: bearer(sessionToken),
  });
  assert.equal(noRepo.statusCode, 400);
  const malformed = await app.inject({
    method: "GET",
    url: "/api/kanban/github-project?repo=notarepo",
    headers: bearer(sessionToken),
  });
  assert.equal(malformed.statusCode, 400);
  assert.match(malformed.json().error, /owner\/repo/);
});

test("GET /api/kanban/github-project returns 400 when the user has no credential", async () => {
  const employees = new MemoryEmployeeRegistry(
    [{ email: "admin@caleo.com", display_name: "Admin", role: "admin" }],
    { cipher: TEST_CIPHER },
  );
  await app.close();
  app = makeApp(undefined, new FakeProjectGithub(new Map(), new Map()) as unknown as GitHubApi, employees);
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/kanban/github-project?repo=acme/box",
    headers: bearer(sessionToken),
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /no github credential/i);
});

test("GET /api/kanban/github-project returns 404 when the repo has no linked Project", async () => {
  await app.close();
  app = makeApp(undefined, new FakeProjectGithub(new Map(), new Map()) as unknown as GitHubApi, credentialEmployee());
  const sessionToken = await login("alice@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/kanban/github-project?repo=acme/box",
    headers: bearer(sessionToken),
  });
  assert.equal(res.statusCode, 404);
  assert.match(res.json().error, /no linked GitHub Project/);
});

test("GET /api/kanban/github-project serves Spec cards (progress) AND ticket cards spread across columns (G4.S5.T9)", async () => {
  await app.close();
  app = makeApp(undefined, projectGithub() as unknown as GitHubApi, credentialEmployee());
  const sessionToken = await login("alice@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/kanban/github-project?repo=zouhanhai/athena-agent",
    headers: bearer(sessionToken),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as GithubProjectBoard;
  assert.equal(body.project.title, "zouhanhai/athena-agent");
  assert.ok(body.generated_at, "the board must carry a generated_at timestamp");
  assert.deepEqual(
    body.columns.map((c) => c.status),
    ["Backlog", "In Progress", "Done"],
  );
  // T9 (revert T6): ticket sub-issues render as their own cards in their own
  // Status columns, spread across the board alongside the Spec cards.
  assert.deepEqual(
    body.columns[0].cards.map((c) => c.ref),
    ["G4.S5"],
  );
  assert.deepEqual(
    body.columns[1].cards.map((c) => c.ref),
    ["G4.S5.T2", "G4.S6"],
  );
  assert.deepEqual(
    body.columns[2].cards.map((c) => c.ref),
    ["G4.S5.T1"],
  );
  const spec = body.columns[0].cards[0];
  assert.equal(spec.ref, "G4.S5");
  assert.equal(spec.title, "Workbench kanban sync");
  assert.equal(spec.status, "Backlog");
  assert.equal(spec.url, "https://github.com/zouhanhai/athena-agent/issues/1");
  // Sub-task progress from the Spec's sub-issues (closed / total + percent).
  assert.deepEqual(spec.progress, { done: 3, total: 5, percent: 60 });
  assert.deepEqual(body.columns[1].cards[1].progress, { done: 1, total: 2, percent: 50 });
  // G4.S5.T8 — each Spec card carries its sub-issues (ref/title/status/number),
  // closed sub-issues → status "done", sorted by ref.
  assert.deepEqual(spec.subIssues, [
    { ref: "G4.S5.T1", title: "G4.S5.T1", status: "done", number: 2 },
    { ref: "G4.S5.T2", title: "G4.S5.T2", status: "open", number: 3 },
    { ref: "G4.S5.T3", title: "G4.S5.T3", status: "done", number: 4 },
    { ref: "G4.S5.T4", title: "G4.S5.T4", status: "done", number: 6 },
    { ref: "G4.S5.T5", title: "G4.S5.T5", status: "open", number: 7 },
  ]);
  assert.deepEqual(body.columns[1].cards[1].subIssues, [
    { ref: "G4.S6.T1", title: "G4.S6.T1", status: "done", number: 8 },
    { ref: "G4.S6.T2", title: "G4.S6.T2", status: "open", number: 9 },
  ]);
  // Ticket cards are plain: no sub-task progress, no nested sub-issues.
  const ticket = body.columns[1].cards[0];
  assert.equal(ticket.ref, "G4.S5.T2");
  assert.equal(ticket.status, "In Progress");
  assert.deepEqual(ticket.progress, { done: 0, total: 0, percent: 0 });
  assert.deepEqual(ticket.subIssues, []);
});

test("GET /api/kanban/github-project resolves a repo-linked Project titled with just the repo name", async () => {
  const project: GithubProject = {
    id: "PVT_2",
    title: "athena-agent",
    number: 7,
    url: "https://github.com/zouhanhai/athena-agent/projects/7",
  };
  const github = new FakeProjectGithub(
    new Map([["zouhanhai/athena-agent", [project]]]),
    new Map([[project.id, [{ id: "PVTI_2", issueId: "I_2", issueNumber: 2, title: "G4.S5 Workbench kanban sync", status: "Done" }]]]),
  );
  await app.close();
  app = makeApp(undefined, github as unknown as GitHubApi, credentialEmployee());
  const sessionToken = await login("alice@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/kanban/github-project?repo=zouhanhai/athena-agent",
    headers: bearer(sessionToken),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as GithubProjectBoard;
  assert.equal(body.project.title, "athena-agent");
  assert.equal(body.columns[0].cards[0].ref, "G4.S5");
});

test("GET /api/kanban/github-project resolves a repo-linked Project whose title differs from the repo name (G4.S5.T11)", async () => {
  const project: GithubProject = {
    id: "PVT_abap",
    title: "Abaplorer Project",
    number: 9,
    url: "https://github.com/orgs/caleo/projects/9",
  };
  const github = new FakeProjectGithub(
    new Map([["CALEO-Consulting/caleo.int.abaplorer", [project]]]),
    new Map([[project.id, [{ id: "PVTI_abap", issueId: "I_1", issueNumber: 1, title: "G4.S5 Workbench kanban sync", status: "Backlog" }]]]),
  );
  await app.close();
  app = makeApp(undefined, github as unknown as GitHubApi, credentialEmployee());
  const sessionToken = await login("alice@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/kanban/github-project?repo=CALEO-Consulting/caleo.int.abaplorer",
    headers: bearer(sessionToken),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as GithubProjectBoard;
  assert.equal(body.project.id, "PVT_abap");
  assert.equal(body.project.title, "Abaplorer Project");
  assert.equal(body.columns[0].cards[0].ref, "G4.S5");
});

test("GET /api/kanban/github-project uses the employee's credential", async () => {
  const used: string[] = [];
  const project: GithubProject = { id: "PVT_1", title: "athena-agent", number: 3, url: "" };
  const github = new FakeProjectGithub(
    new Map([["zouhanhai/athena-agent", [project]]]),
    new Map([[project.id, []]]),
  );
  const original = github.getRepoProjects.bind(github);
  github.getRepoProjects = async (credential, owner, repo) => {
    used.push(credential.value);
    return original(credential, owner, repo);
  };
  await app.close();
  app = makeApp(undefined, github as unknown as GitHubApi, credentialEmployee());
  const sessionToken = await login("alice@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/kanban/github-project?repo=zouhanhai/athena-agent",
    headers: bearer(sessionToken),
  });
  assert.equal(res.statusCode, 200);
  assert.ok(used.every((v) => v === "ghp_alice"), "the board must use the employee's credential");
});

test("GET /api/kanban/github-project surfaces a GitHub auth failure as 401", async () => {
  const github = new FakeProjectGithub(new Map(), new Map());
  github.getRepoProjects = async () => {
    throw new GithubAuthError("GitHub rejected the credential (HTTP 401)");
  };
  await app.close();
  app = makeApp(undefined, github as unknown as GitHubApi, credentialEmployee());
  const sessionToken = await login("alice@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/kanban/github-project?repo=zouhanhai/athena-agent",
    headers: bearer(sessionToken),
  });
  assert.equal(res.statusCode, 401);
  assert.match(res.json().error, /GitHub rejected/);
});

// ---------------------------------------------------------------------------
// G4.S5.T12 — GET /api/kanban/github-project project selector + github-projects
// ---------------------------------------------------------------------------

test("GET /api/kanban/github-projects requires authentication", async () => {
  const res = await app.inject({ method: "GET", url: "/api/kanban/github-projects?repo=acme/box" });
  assert.equal(res.statusCode, 401);
});

test("GET /api/kanban/github-projects requires a repo param in owner/repo form", async () => {
  const sessionToken = await login("alice@caleo.com");
  const noRepo = await app.inject({
    method: "GET",
    url: "/api/kanban/github-projects",
    headers: bearer(sessionToken),
  });
  assert.equal(noRepo.statusCode, 400);
  const malformed = await app.inject({
    method: "GET",
    url: "/api/kanban/github-projects?repo=notarepo",
    headers: bearer(sessionToken),
  });
  assert.equal(malformed.statusCode, 400);
  assert.match(malformed.json().error, /owner\/repo/);
});

test("GET /api/kanban/github-projects lists the repo's open linked projects for the selector (G4.S5.T12)", async () => {
  const open: GithubProject = {
    id: "PVT_open",
    title: "zouhanhai/athena-agent",
    number: 3,
    url: "https://github.com/zouhanhai/athena-agent/projects/3",
  };
  const second: GithubProject = {
    id: "PVT_second",
    title: "Second project",
    number: 4,
    url: "https://github.com/zouhanhai/athena-agent/projects/4",
  };
  const github = new FakeProjectGithub(
    new Map([["zouhanhai/athena-agent", [open, second]]]),
    new Map(),
  );
  await app.close();
  app = makeApp(undefined, github as unknown as GitHubApi, credentialEmployee());
  const sessionToken = await login("alice@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/kanban/github-projects?repo=zouhanhai/athena-agent",
    headers: bearer(sessionToken),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((res.json() as { projects: GithubProject[] }).projects, [open, second]);
});

test("GET /api/kanban/github-project serves the specified project when ?project=<id> is passed (G4.S5.T12)", async () => {
  const open: GithubProject = {
    id: "PVT_open",
    title: "zouhanhai/athena-agent",
    number: 3,
    url: "https://github.com/zouhanhai/athena-agent/projects/3",
  };
  const second: GithubProject = {
    id: "PVT_second",
    title: "Second project",
    number: 4,
    url: "https://github.com/zouhanhai/athena-agent/projects/4",
  };
  const github = new FakeProjectGithub(
    new Map([["zouhanhai/athena-agent", [open, second]]]),
    new Map([
      [open.id, [{ id: "PVTI_a", issueId: "I_1", issueNumber: 1, title: "G4.S5 Workbench kanban sync", status: "Backlog" }]],
      [second.id, [{ id: "PVTI_b", issueId: "I_2", issueNumber: 2, title: "G4.S5.T1", status: "Done" }]],
    ]),
  );
  await app.close();
  app = makeApp(undefined, github as unknown as GitHubApi, credentialEmployee());
  const sessionToken = await login("alice@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/kanban/github-project?repo=zouhanhai/athena-agent&project=PVT_second",
    headers: bearer(sessionToken),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as GithubProjectBoard;
  assert.equal(body.project.id, "PVT_second");
  assert.equal(body.project.title, "Second project");
  assert.equal(body.columns[0].cards[0].ref, "G4.S5.T1");
});

test("GET /api/kanban/github-project serves the FIRST open project when no ?project is passed (G4.S5.T12)", async () => {
  const open: GithubProject = {
    id: "PVT_open",
    title: "zouhanhai/athena-agent",
    number: 3,
    url: "https://github.com/zouhanhai/athena-agent/projects/3",
  };
  const second: GithubProject = {
    id: "PVT_second",
    title: "Second project",
    number: 4,
    url: "https://github.com/zouhanhai/athena-agent/projects/4",
  };
  const github = new FakeProjectGithub(
    new Map([["zouhanhai/athena-agent", [open, second]]]),
    new Map([
      [open.id, [{ id: "PVTI_a", issueId: "I_1", issueNumber: 1, title: "G4.S5 Workbench kanban sync", status: "Backlog" }]],
      [second.id, [{ id: "PVTI_b", issueId: "I_2", issueNumber: 2, title: "G4.S5.T1", status: "Done" }]],
    ]),
  );
  await app.close();
  app = makeApp(undefined, github as unknown as GitHubApi, credentialEmployee());
  const sessionToken = await login("alice@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/kanban/github-project?repo=zouhanhai/athena-agent",
    headers: bearer(sessionToken),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as GithubProjectBoard;
  assert.equal(body.project.id, "PVT_open");
  assert.equal(body.project.title, "zouhanhai/athena-agent");
});

test("GET /api/kanban/github-project returns 404 for an unknown ?project=<id> (G4.S5.T12)", async () => {
  const open: GithubProject = {
    id: "PVT_open",
    title: "zouhanhai/athena-agent",
    number: 3,
    url: "https://github.com/zouhanhai/athena-agent/projects/3",
  };
  const github = new FakeProjectGithub(
    new Map([["zouhanhai/athena-agent", [open]]]),
    new Map([[open.id, []]]),
  );
  await app.close();
  app = makeApp(undefined, github as unknown as GitHubApi, credentialEmployee());
  const sessionToken = await login("alice@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/kanban/github-project?repo=zouhanhai/athena-agent&project=PVT_nope",
    headers: bearer(sessionToken),
  });
  assert.equal(res.statusCode, 404);
  assert.match(res.json().error, /no linked GitHub Project/);
});

test("GET /api/kanban/github-project returns 404 when no open project remains (all closed) (G4.S5.T12)", async () => {
  const github = new FakeProjectGithub(new Map(), new Map());
  await app.close();
  app = makeApp(undefined, github as unknown as GitHubApi, credentialEmployee());
  const sessionToken = await login("alice@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/kanban/github-project?repo=zouhanhai/athena-agent",
    headers: bearer(sessionToken),
  });
  assert.equal(res.statusCode, 404);
  assert.match(res.json().error, /no linked GitHub Project/);
});

// G4.S5.T16 — GET /api/kanban/github-issue (GitHub issue body for the detail panel)
// -----------------------------------------------------------------------------

test("GET /api/kanban/github-issue requires authentication", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/kanban/github-issue?repo=acme/box&issueNumber=5",
  });
  assert.equal(res.statusCode, 401);
});

test("GET /api/kanban/github-issue requires repo + issueNumber", async () => {
  const sessionToken = await login("alice@caleo.com");
  const noRepo = await app.inject({
    method: "GET",
    url: "/api/kanban/github-issue?issueNumber=5",
    headers: bearer(sessionToken),
  });
  assert.equal(noRepo.statusCode, 400);
  const noIssue = await app.inject({
    method: "GET",
    url: "/api/kanban/github-issue?repo=acme/box",
    headers: bearer(sessionToken),
  });
  assert.equal(noIssue.statusCode, 400);
  const badIssue = await app.inject({
    method: "GET",
    url: "/api/kanban/github-issue?repo=acme/box&issueNumber=nope",
    headers: bearer(sessionToken),
  });
  assert.equal(badIssue.statusCode, 400);
});

test("GET /api/kanban/github-issue serves the issue body (title/body/state/labels)", async () => {
  const issue: GithubIssue = {
    id: 5,
    node_id: "I_5",
    number: 5,
    title: "G4.S5 Workbench kanban sync",
    state: "open",
    html_url: "https://github.com/zouhanhai/athena-agent/issues/5",
    user_login: "alice",
    body: "## Sub-tasks\n\n- [x] T1\n- [ ] T2",
    labels: ["G4"],
    assignees: ["alice"],
  };
  const github = new FakeProjectGithub(
    new Map(),
    new Map(),
    new Map(),
    new Map([["zouhanhai/athena-agent", [issue]]]),
  );
  await app.close();
  app = makeApp(undefined, github as unknown as GitHubApi, credentialEmployee());
  const sessionToken = await login("alice@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/kanban/github-issue?repo=zouhanhai/athena-agent&issueNumber=5",
    headers: bearer(sessionToken),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((res.json() as { issue: GithubIssue }).issue, issue);
});

test("GET /api/kanban/github-issue returns 400 when the user has no credential", async () => {
  const employees = new MemoryEmployeeRegistry(
    [{ email: "admin@caleo.com", display_name: "Admin", role: "admin" }],
    { cipher: TEST_CIPHER },
  );
  await app.close();
  app = makeApp(undefined, new FakeProjectGithub(new Map(), new Map()) as unknown as GitHubApi, employees);
  const sessionToken = await login("admin@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/kanban/github-issue?repo=zouhanhai/athena-agent&issueNumber=5",
    headers: bearer(sessionToken),
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /no github credential/i);
});

test("GET /api/kanban/github-issue surfaces a GitHub auth failure as 401", async () => {
  const github = new FakeProjectGithub(new Map(), new Map());
  github.getIssue = async () => {
    throw new GithubAuthError("GitHub rejected the credential (HTTP 401)");
  };
  await app.close();
  app = makeApp(undefined, github as unknown as GitHubApi, credentialEmployee());
  const sessionToken = await login("alice@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/kanban/github-issue?repo=zouhanhai/athena-agent&issueNumber=5",
    headers: bearer(sessionToken),
  });
  assert.equal(res.statusCode, 401);
  assert.match(res.json().error, /GitHub rejected/);
});

// G4.S5.T4 — GET /api/kanban/github-issue-comments (local detail panel discussion)
// -----------------------------------------------------------------------------

test("GET /api/kanban/github-issue-comments requires authentication", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/kanban/github-issue-comments?repo=acme/box&issueNumber=5",
  });
  assert.equal(res.statusCode, 401);
});

test("GET /api/kanban/github-issue-comments requires repo + issueNumber", async () => {
  const sessionToken = await login("alice@caleo.com");
  const noRepo = await app.inject({
    method: "GET",
    url: "/api/kanban/github-issue-comments?issueNumber=5",
    headers: bearer(sessionToken),
  });
  assert.equal(noRepo.statusCode, 400);
  const noIssue = await app.inject({
    method: "GET",
    url: "/api/kanban/github-issue-comments?repo=acme/box",
    headers: bearer(sessionToken),
  });
  assert.equal(noIssue.statusCode, 400);
  const badIssue = await app.inject({
    method: "GET",
    url: "/api/kanban/github-issue-comments?repo=acme/box&issueNumber=nope",
    headers: bearer(sessionToken),
  });
  assert.equal(badIssue.statusCode, 400);
});

test("GET /api/kanban/github-issue-comments serves the issue's comment thread", async () => {
  const comments: GithubIssueComment[] = [
    {
      id: 11,
      user_login: "alice",
      body: "Let's keep the board inside the Workbench.",
      created_at: "2026-08-13T10:00:00Z",
      html_url: "https://github.com/zouhanhai/athena-agent/issues/5#issuecomment-11",
    },
  ];
  const github = new FakeProjectGithub(
    new Map(),
    new Map(),
    new Map([[5, comments]]),
  );
  await app.close();
  app = makeApp(undefined, github as unknown as GitHubApi, credentialEmployee());
  const sessionToken = await login("alice@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/kanban/github-issue-comments?repo=zouhanhai/athena-agent&issueNumber=5",
    headers: bearer(sessionToken),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((res.json() as { comments: GithubIssueComment[] }).comments, comments);
});

test("GET /api/kanban/github-issue-comments returns an empty list when the issue has no comments", async () => {
  await app.close();
  app = makeApp(undefined, new FakeProjectGithub(new Map(), new Map()) as unknown as GitHubApi, credentialEmployee());
  const sessionToken = await login("alice@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/kanban/github-issue-comments?repo=zouhanhai/athena-agent&issueNumber=9",
    headers: bearer(sessionToken),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((res.json() as { comments: GithubIssueComment[] }).comments, []);
});

test("GET /api/kanban/github-issue-comments surfaces a GitHub auth failure as 401", async () => {
  const github = new FakeProjectGithub(new Map(), new Map());
  github.getIssueComments = async () => {
    throw new GithubAuthError("GitHub rejected the credential (HTTP 401)");
  };
  await app.close();
  app = makeApp(undefined, github as unknown as GitHubApi, credentialEmployee());
  const sessionToken = await login("alice@caleo.com");
  const res = await app.inject({
    method: "GET",
    url: "/api/kanban/github-issue-comments?repo=zouhanhai/athena-agent&issueNumber=5",
    headers: bearer(sessionToken),
  });
  assert.equal(res.statusCode, 401);
  assert.match(res.json().error, /GitHub rejected/);
});

// G4.S5.T8 — POST /api/kanban/github-issue-comments (create a GitHub comment)
// -----------------------------------------------------------------------------

function postComment(sessionToken: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/kanban/github-issue-comments",
    payload,
    headers: bearer(sessionToken),
  });
}

test("POST /api/kanban/github-issue-comments requires authentication", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/kanban/github-issue-comments",
    payload: { repo: "acme/box", issueNumber: 5, body: "hi" },
  });
  assert.equal(res.statusCode, 401);
});

test("POST /api/kanban/github-issue-comments requires repo / issueNumber / body", async () => {
  const sessionToken = await login("alice@caleo.com");
  const status = (body: Record<string, unknown>) => postComment(sessionToken, body).then((r) => r.statusCode);
  assert.equal(await status({ issueNumber: 5, body: "hi" }), 400, "missing repo");
  assert.equal(await status({ repo: "acme/box", body: "hi" }), 400, "missing issueNumber");
  assert.equal(await status({ repo: "acme/box", issueNumber: 5 }), 400, "missing body");
  assert.equal(await status({ repo: "acme/box", issueNumber: "nope", body: "hi" }), 400, "bad issueNumber");
  assert.equal(await status({ repo: "notarepo", issueNumber: 5, body: "hi" }), 400, "malformed repo");
});

test("POST /api/kanban/github-issue-comments creates the comment via the employee's credential and returns it (G4.S5.T8)", async () => {
  const github = new FakeProjectGithub(new Map(), new Map());
  await app.close();
  app = makeApp(undefined, github as unknown as GitHubApi, credentialEmployee());
  const sessionToken = await login("alice@caleo.com");
  const res = await postComment(sessionToken, {
    repo: "zouhanhai/athena-agent",
    issueNumber: 5,
    body: "Please keep the panel inside the Kanban tab.",
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { comment: GithubIssueComment };
  assert.equal(body.comment.user_login, "alice");
  assert.equal(body.comment.body, "Please keep the panel inside the Kanban tab.");
  assert.deepEqual(github.createdComments, [
    { issueNumber: 5, body: "Please keep the panel inside the Kanban tab." },
  ]);
});

test("POST /api/kanban/github-issue-comments returns 400 when the user has no credential", async () => {
  const employees = new MemoryEmployeeRegistry(
    [{ email: "admin@caleo.com", display_name: "Admin", role: "admin" }],
    { cipher: TEST_CIPHER },
  );
  await app.close();
  app = makeApp(undefined, new FakeProjectGithub(new Map(), new Map()) as unknown as GitHubApi, employees);
  const sessionToken = await login("admin@caleo.com");
  const res = await postComment(sessionToken, { repo: "acme/box", issueNumber: 5, body: "hi" });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /no github credential/i);
});

test("POST /api/kanban/github-issue-comments surfaces a GitHub auth failure as 401", async () => {
  const github = new FakeProjectGithub(new Map(), new Map());
  github.createIssueComment = async () => {
    throw new GithubAuthError("GitHub rejected the credential (HTTP 401)");
  };
  await app.close();
  app = makeApp(undefined, github as unknown as GitHubApi, credentialEmployee());
  const sessionToken = await login("alice@caleo.com");
  const res = await postComment(sessionToken, { repo: "acme/box", issueNumber: 5, body: "hi" });
  assert.equal(res.statusCode, 401);
  assert.match(res.json().error, /GitHub rejected/);
});
