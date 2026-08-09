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
import type { KanbanBoard, BoardScanner, RemoteBoardSource } from "../src/kanban/scan.js";
import type { GithubFileContent, GithubTreeEntry, GitHubApi } from "../src/github/client.js";

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

const BOARD_SAMPLE: KanbanBoard = {
  goals: [
    {
      ref: "G1",
      goal: {
        id: "g1",
        title: "G1: goal",
        layer: "G",
        owner: "consultant",
        status: "active",
        milestone: "M3",
        acceptance_criteria: ["done"],
      },
      specs: [
        {
          ref: "G1.S1",
          spec: {
            id: "g1_s1",
            title: "G1.S1: spec",
            layer: "S",
            parent: "G1",
            owner: "pm",
            status: "active",
            milestone: "M3",
            acceptance_criteria: ["done"],
          },
          tickets: [
            {
              ref: "G1.S1.T1",
              ticket: {
                id: "t1",
                title: "G1.S1.T1: ticket",
                layer: "T",
                parent: "G1.S1",
                owner: "eng-director",
                status: "done",
                assignee: "opencode",
                session_id: "ses_x",
                blocked_by: [],
                acceptance_criteria: ["works"],
              },
            },
          ],
        },
      ],
    },
  ],
  errors: [],
};

class FakeBoardScanner implements BoardScanner {
  readonly calls: number[] = [];
  constructor(private readonly result: KanbanBoard | Error) {}
  async scan(): Promise<KanbanBoard> {
    this.calls.push(1);
    if (this.result instanceof Error) {
      throw this.result;
    }
    return this.result;
  }
}

let app: FastifyInstance;
let sent: SentMail[];

/** Build a fresh app with its own registry/auth so closing one never affects another. */
function makeApp(board?: BoardScanner, github?: GitHubApi, employees?: MemoryEmployeeRegistry): FastifyInstance {
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
  return buildApp({ employees: registry, auth, board, github });
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

test("GET /api/kanban returns the scanned board", async () => {
  const board = new FakeBoardScanner(BOARD_SAMPLE);
  await app.close();
  app = makeApp(board);
  const sessionToken = await login("alice@caleo.com");

  const res = await app.inject({ method: "GET", url: "/api/kanban", headers: bearer(sessionToken) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), BOARD_SAMPLE);
  assert.equal(board.calls.length, 1, "the board must be produced by the scanner");
});

test("GET /api/kanban surfaces a scanner failure as 500", async () => {
  const failing = new FakeBoardScanner(new Error("disk read failed"));
  await app.close();
  app = makeApp(failing);
  const sessionToken = await login("alice@caleo.com");

  const res = await app.inject({ method: "GET", url: "/api/kanban", headers: bearer(sessionToken) });
  assert.equal(res.statusCode, 500);
  assert.match(res.json().error, /disk read failed/);
});

test("GET /api/kanban with the default scanner reads the real repo board", async () => {
  await app.close();
  app = makeApp();
  const sessionToken = await login("alice@caleo.com");

  const res = await app.inject({ method: "GET", url: "/api/kanban", headers: bearer(sessionToken) });
  assert.equal(res.statusCode, 200);
  const body = res.json() as KanbanBoard;
  assert.ok(body.goals.some((g) => g.ref === "G3"), "default scanner should surface G3");
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

test("GET /api/kanban?repo=owner/repo scans the selected repo via the user's credential", async () => {
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
  const body = res.json() as KanbanBoard;
  assert.equal(body.goals.length, 1);
  assert.equal(body.goals[0].ref, "G1");
  const ticket = body.goals[0].specs[0].tickets[0];
  assert.equal(ticket.ref, "G1.S1.T1");
  assert.equal(ticket.ticket.status, "in_progress");
  assert.equal(ticket.ticket.assignee, "opencode");
  assert.equal(ticket.ticket.session_id, "ses_remote");
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
