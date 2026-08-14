import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { KanbanBoard } from "../src/kanban/scan.js";
import type {
  GithubCredential,
  GithubIssueComment,
  GithubProject,
  GithubProjectItem,
  GitHubApi,
} from "../src/github/types.js";
import {
  appendGitHubSyncNote,
  applyFeedbackDraft,
  buildEditDraft,
  buildFeedbackContext,
  buildFeedbackProposal,
  buildOriginMarker,
  buildPlanDraft,
  buildSpecDraft,
  buildTicketDraft,
  dedupeComments,
  markCommentsSeen,
  pullProjectStatusChanges,
  readFeedbackContext,
  readSyncState,
  syncStatePath,
  writeSyncState,
} from "../src/kanban/github-feedback.js";
import { writeTicketFile } from "../src/kanban/board.js";
import { parseBoardFile } from "../src/kanban/board.js";
import type { TicketDocument } from "../src/kanban/board.js";

const tokenCredential: GithubCredential = { type: "token", value: "ghp_testtoken" };

async function tempRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "kanban-feedback-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** A board fixture for G4.S5 with T1 (done) and T2 (in_progress). */
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
            },
          ],
        },
      ],
    },
  ],
};

/** A TicketDocument matching the board fixture for T1, carrying a Progress Log. */
function ticketDoc(ref: string, status: "done" | "in_progress"): TicketDocument {
  const ticket = board.goals[0].specs[0].tickets.find((t) => t.ref === ref)!.ticket;
  const progress = status === "done" ? "shipped" : "working";
  return {
    ref,
    frontmatter: { ...ticket, status },
    body: `# ${ref}: ${ticket.title}\n\n## Task\n\nBuild the sync.\n\n## Acceptance\n\nTests green.\n\n## Progress Log\n| Timestamp (UTC) | Status | Progress |\n|---|---|---|\n| 2026-08-13 09:00:00Z | ${status} | ${progress} |\n`,
  };
}

async function writeFixture(root: string): Promise<void> {
  for (const ref of ["G4.S5.T1", "G4.S5.T2"]) {
    const status = ref === "G4.S5.T1" ? "done" : "in_progress";
    await writeTicketFile(root, ticketDoc(ref, status));
  }
}

const project: GithubProject = { id: "PVT_1", title: "athena-agent", number: 5, url: "" };

function item(title: string, status: string | null, issueNumber: number): GithubProjectItem {
  return { id: `PVTI_${issueNumber}`, issueId: `I_${issueNumber}`, issueNumber, title, status };
}

/** Minimal GitHubApi stub: only the calls the feedback module makes. */
class StubGithub {
  items: GithubProjectItem[] = [];
  comments: GithubIssueComment[] = [];
  specIssue: { number: number } | null = { number: 1 };
  calls: string[] = [];

  asApi(): GitHubApi {
    const github: Partial<GitHubApi> = {
      getProjectItems: async () => {
        this.calls.push("getProjectItems");
        return this.items;
      },
      getIssueByTitle: async (_c, _o, _r, title) => {
        this.calls.push(`getIssueByTitle:${title}`);
        if (!this.specIssue) return null;
        return { id: 1, node_id: "I_1", number: this.specIssue.number, title, state: "open", html_url: "", user_login: "alice", body: null, labels: [], assignees: [] };
      },
      getIssueComments: async (_c, _o, _r, number) => {
        this.calls.push(`getIssueComments:${number}`);
        return this.comments;
      },
    };
    return github as GitHubApi;
  }
}

// ---------------------------------------------------------------------------
// Origin markers + GitHub sync note
// ---------------------------------------------------------------------------

test("buildOriginMarker renders the synced_from origin line", () => {
  assert.equal(
    buildOriginMarker("2026-08-13T12:00:00.000Z", "status", "in_progress", "done"),
    "synced_from: github 2026-08-13T12:00:00.000Z status in_progress→done",
  );
});

test("appendGitHubSyncNote appends a ## GitHub sync section to a ticket body", () => {
  const body = "## Task\n\nBuild it.\n\n## Progress Log\n| Timestamp (UTC) | Status | Progress |\n|---|---|---|\n| x | done | y |\n";
  const out = appendGitHubSyncNote(body, "2026-08-13T12:00:00.000Z", "status", "in_progress", "done");
  assert.match(out, /## GitHub sync/);
  assert.match(out, /synced_from: github 2026-08-13T12:00:00\.000Z status in_progress→done/);
  assert.ok(out.indexOf("## GitHub sync") > out.indexOf("## Progress Log"));
});

// ---------------------------------------------------------------------------
// (a) status pull writes GitHub status to md with an origin marker
// ---------------------------------------------------------------------------

test("pullProjectStatusChanges writes a user-confirmed GitHub status back to md with an origin marker", async () => {
  const { root, cleanup } = await tempRoot();
  await writeFixture(root);
  const github = new StubGithub();
  github.items = [
    item("G4.S5.T1", "Backlog", 11), // done → Backlog (user dragged it back)
    item("G4.S5.T2", "In Progress", 12), // matches md → unchanged
  ];

  const result = await pullProjectStatusChanges(github.asApi(), tokenCredential, "caleo", "athena", board, project, {
    root,
    now: "2026-08-13T12:00:00.000Z",
  });

  assert.deepEqual(result.applied, [
    {
      ref: "G4.S5.T1",
      field: "status",
      oldStatus: "done",
      newStatus: "backlog",
      timestamp: "2026-08-13T12:00:00.000Z",
      origin: "synced_from: github 2026-08-13T12:00:00.000Z status done→backlog",
    },
  ]);
  assert.deepEqual(result.unchanged, ["G4.S5.T2"]);
  assert.deepEqual(result.conflicts, []);

  const t1 = parseBoardFile(await readFile(path.join(root, "G4", "S5", "T1.md"), "utf8"));
  assert.equal((t1.frontmatter as { status: string }).status, "backlog");
  assert.match(t1.body, /## GitHub sync/);
  assert.match(t1.body, /synced_from: github 2026-08-13T12:00:00\.000Z status done→backlog/);

  const t2 = parseBoardFile(await readFile(path.join(root, "G4", "S5", "T2.md"), "utf8"));
  assert.equal((t2.frontmatter as { status: string }).status, "in_progress");
  assert.ok(!/GitHub sync/.test(t2.body));
  await cleanup();
});

test("pullProjectStatusChanges is a no-op when every GitHub status matches md", async () => {
  const { root, cleanup } = await tempRoot();
  await writeFixture(root);
  const github = new StubGithub();
  github.items = [
    item("G4.S5.T1", "Done", 11),
    item("G4.S5.T2", "In Progress", 12),
  ];
  const result = await pullProjectStatusChanges(github.asApi(), tokenCredential, "caleo", "athena", board, project, { root });
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.unchanged, ["G4.S5.T1", "G4.S5.T2"]);
  await cleanup();
});

// ---------------------------------------------------------------------------
// (d) conflict handling: never silently overwrite md
// ---------------------------------------------------------------------------

test("pullProjectStatusChanges surfaces an unknown GitHub Status option as a conflict and leaves md untouched", async () => {
  const { root, cleanup } = await tempRoot();
  await writeFixture(root);
  const github = new StubGithub();
  github.items = [
    item("G4.S5.T1", "Todo", 11), // "Todo" is not a kanban status → ambiguous
    item("G4.S5.T2", "In Progress", 12),
  ];
  const result = await pullProjectStatusChanges(github.asApi(), tokenCredential, "caleo", "athena", board, project, { root });

  assert.equal(result.applied.length, 0);
  assert.equal(result.unchanged.length, 1);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].ref, "G4.S5.T1");
  assert.equal(result.conflicts[0].field, "status");
  assert.equal(result.conflicts[0].ghValue, "Todo");
  assert.equal(result.conflicts[0].mdValue, "done");
  assert.match(result.conflicts[0].reason, /unknown GitHub Status option "Todo"/);

  const t1 = parseBoardFile(await readFile(path.join(root, "G4", "S5", "T1.md"), "utf8"));
  assert.equal((t1.frontmatter as { status: string }).status, "done");
  assert.ok(!/GitHub sync/.test(t1.body));
  await cleanup();
});

test("pullProjectStatusChanges reports a GitHub card with no md ticket as a conflict", async () => {
  const { root, cleanup } = await tempRoot();
  await writeFixture(root);
  const github = new StubGithub();
  github.items = [
    item("G4.S5.T1", "Done", 11),
    item("G4.S5.T9", "Done", 99), // ticket-pattern title but no md ticket
  ];
  const result = await pullProjectStatusChanges(github.asApi(), tokenCredential, "caleo", "athena", board, project, { root });

  assert.equal(result.applied.length, 0);
  assert.deepEqual(result.conflicts.map((c) => c.ref), ["G4.S5.T9"]);
  assert.match(result.conflicts[0].reason, /no md ticket/);
  await cleanup();
});

test("pullProjectStatusChanges skips draft cards and the spec main issue", async () => {
  const { root, cleanup } = await tempRoot();
  await writeFixture(root);
  const github = new StubGithub();
  github.items = [
    item("G4.S5.T1", "Done", 11),
    item("G4.S5.T2", "In Progress", 12),
    item("G4.S5 Kanban ↔ GitHub Issues bidirectional sync + planning feedback loop", "In Progress", 1),
    { id: "PVTI_DRAFT", issueId: null, issueNumber: null, title: "draft idea", status: "Todo" },
  ];
  const result = await pullProjectStatusChanges(github.asApi(), tokenCredential, "caleo", "athena", board, project, { root });
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.unchanged, ["G4.S5.T1", "G4.S5.T2"]);
  await cleanup();
});

// ---------------------------------------------------------------------------
// (b) comment dedup via sync-state
// ---------------------------------------------------------------------------

test("syncStatePath points at the spec dir's sync-state.json", () => {
  assert.equal(syncStatePath("/b", "G4.S5"), path.join("/b", "G4", "S5", "sync-state.json"));
});

test("writeSyncState + readSyncState round-trip the seen markers", async () => {
  const { root, cleanup } = await tempRoot();
  const state = { version: 1 as const, specRef: "G4.S5", seen: [{ issueNumber: 1, commentId: 100, at: "2026-08-13T10:00:00.000Z" }] };
  await writeSyncState(root, "G4.S5", state);
  const read = await readSyncState(root, "G4.S5");
  assert.deepEqual(read, state);
  assert.equal(await readSyncState(root, "G4.S6"), null);
  await cleanup();
});

test("dedupeComments returns only unseen comments as fresh", () => {
  const seen = { version: 1 as const, specRef: "G4.S5", seen: [{ issueNumber: 1, commentId: 100, at: "2026-08-13T10:00:00.000Z" }] };
  const comments: GithubIssueComment[] = [
    { id: 100, user_login: "alice", body: "old", created_at: "2026-08-13T09:00:00Z", html_url: "" },
    { id: 101, user_login: "bob", body: "new idea", created_at: "2026-08-13T11:00:00Z", html_url: "" },
  ];
  const { fresh, seen: seenList } = dedupeComments(comments, seen);
  assert.deepEqual(fresh.map((c) => c.id), [101]);
  assert.deepEqual(seenList.map((c) => c.id), [100]);
});

test("markCommentsSeen records fresh comment ids", () => {
  const state = { version: 1 as const, specRef: "G4.S5", seen: [] };
  const comments: GithubIssueComment[] = [
    { id: 100, user_login: "alice", body: "old", created_at: "", html_url: "" },
    { id: 101, user_login: "bob", body: "new", created_at: "", html_url: "" },
  ];
  const next = markCommentsSeen(state, comments, 1, "2026-08-13T12:00:00.000Z");
  assert.deepEqual(next.seen, [
    { issueNumber: 1, commentId: 100, at: "2026-08-13T12:00:00.000Z" },
    { issueNumber: 1, commentId: 101, at: "2026-08-13T12:00:00.000Z" },
  ]);
});

test("readFeedbackContext surfaces only new comments against the seen marker", async () => {
  const { root, cleanup } = await tempRoot();
  await writeSyncState(root, "G4.S5", {
    version: 1,
    specRef: "G4.S5",
    seen: [{ issueNumber: 1, commentId: 100, at: "2026-08-13T10:00:00.000Z" }],
  });
  const github = new StubGithub();
  github.comments = [
    { id: 100, user_login: "alice", body: "old", created_at: "2026-08-13T09:00:00Z", html_url: "" },
    { id: 101, user_login: "bob", body: "please add a T5", created_at: "2026-08-13T11:00:00Z", html_url: "" },
  ];
  const result = await readFeedbackContext(github.asApi(), tokenCredential, "caleo", "athena", root, board, "G4.S5", "2026-08-13T12:00:00.000Z");
  assert.equal(result.issueNumber, 1);
  assert.deepEqual(result.newComments.map((c) => c.id), [101]);
  assert.equal(result.context.specRef, "G4.S5");
  assert.equal(result.context.spec.id, "s5");
  assert.deepEqual(result.context.tickets.map((t) => t.ref), ["G4.S5.T1", "G4.S5.T2"]);
  assert.equal(result.context.generatedAt, "2026-08-13T12:00:00.000Z");
  assert.ok(github.calls.includes("getIssueByTitle:G4.S5 Kanban ↔ GitHub Issues bidirectional sync + planning feedback loop"));
  assert.ok(github.calls.includes("getIssueComments:1"));
  await cleanup();
});

// ---------------------------------------------------------------------------
// (c) plan-agent proposal generation via planning.ts (DRAFT, never applied)
// ---------------------------------------------------------------------------

test("buildPlanDraft builds a full goal/spec/ticket plan via planning.ts without writing anything", async () => {
  const { root, cleanup } = await tempRoot();
  const draft = await buildPlanDraft(root, {
    goal: { title: "Feedback Goal", context: "from a comment", acceptance_criteria: ["goal is clear"] },
    specs: [
      {
        spec: { title: "Feedback Spec", task: "to-spec", acceptance_criteria: ["spec is clear"] },
        tickets: [{ title: "Feedback Ticket", task: "to-ticket", acceptance_criteria: ["ticket is clear"] }],
      },
    ],
  });

  assert.equal(draft.goalRef, "G1");
  assert.deepEqual(draft.specs, [{ specRef: "G1.S1", ticketRefs: ["G1.S1.T1"] }]);
  assert.deepEqual(draft.drafts.map((d) => d.kind), ["create_goal", "create_spec", "create_ticket"]);

  const goal = draft.drafts.find((d) => d.kind === "create_goal")!.doc;
  assert.equal(goal.ref, "G1");
  assert.equal(goal.frontmatter.title, "G1: Feedback Goal");
  assert.equal(goal.frontmatter.status, "active");
  assert.equal(goal.status, "draft");

  const spec = draft.drafts.find((d) => d.kind === "create_spec")!.doc;
  assert.equal(spec.ref, "G1.S1");
  assert.equal(spec.frontmatter.title, "G1.S1: Feedback Spec");
  assert.equal(spec.frontmatter.parent, "G1");

  const ticket = draft.drafts.find((d) => d.kind === "create_ticket")!.doc;
  assert.equal(ticket.ref, "G1.S1.T1");
  assert.equal(ticket.frontmatter.title, "G1.S1.T1: Feedback Ticket");
  assert.equal(ticket.frontmatter.status, "backlog");

  // DRAFT only — nothing written to disk.
  assert.deepEqual(await readdir(root), []);
  await cleanup();
});

test("buildPlanDraft rejects an invalid plan like planGoal", async () => {
  const { root, cleanup } = await tempRoot();
  await assert.rejects(
    buildPlanDraft(root, { goal: { title: "", acceptance_criteria: [] }, specs: [] }),
    /plan is invalid/,
  );
  await cleanup();
});

test("buildTicketDraft proposes a new ticket under an existing spec (next ref, DRAFT)", async () => {
  const { root, cleanup } = await tempRoot();
  await writeFixture(root); // G4.S5 has T1, T2 on disk
  const draft = await buildTicketDraft(root, "G4.S5", {
    title: "Feedback T3",
    task: "from a comment",
    acceptance_criteria: ["t3 is clear"],
  });
  assert.equal(draft.kind, "create_ticket");
  assert.equal(draft.doc.ref, "G4.S5.T3");
  assert.equal(draft.doc.frontmatter.status, "backlog");
  assert.equal(draft.doc.frontmatter.parent, "G4.S5");
  assert.deepEqual(await readdir(path.join(root, "G4", "S5")), ["T1.md", "T2.md"]);
  await cleanup();
});

test("buildSpecDraft proposes a new spec under an existing goal (next ref, DRAFT)", async () => {
  const { root, cleanup } = await tempRoot();
  await writeFixture(root); // G4 has S5
  const draft = await buildSpecDraft(root, "G4", {
    title: "Feedback S6",
    task: "new spec from comments",
    acceptance_criteria: ["s6 is clear"],
  });
  assert.equal(draft.kind, "create_spec");
  assert.equal(draft.doc.ref, "G4.S6");
  assert.equal(draft.doc.frontmatter.parent, "G4");
  assert.equal(draft.doc.frontmatter.status, "backlog");
  await cleanup();
});

test("buildEditDraft proposes an edit to an existing ticket without writing it", async () => {
  const { root, cleanup } = await tempRoot();
  await writeFixture(root);
  const draft = await buildEditDraft(root, "G4.S5.T2", {
    title: "md→GitHub Project projection + sync CLI (edited)",
    acceptance_criteria: ["Each Spec → a main Issue", "edited acceptance"],
  });
  assert.equal(draft.kind, "edit");
  assert.equal(draft.ref, "G4.S5.T2");
  assert.equal(draft.doc.frontmatter.title, "G4.S5.T2: md→GitHub Project projection + sync CLI (edited)");
  assert.deepEqual(draft.doc.frontmatter.acceptance_criteria, ["Each Spec → a main Issue", "edited acceptance"]);
  assert.equal(draft.doc.frontmatter.status, "in_progress"); // preserved
  assert.match(draft.doc.body, /# G4\.S5\.T2: md→GitHub Project projection \+ sync CLI \(edited\)/);

  // md untouched until applied.
  const onDisk = parseBoardFile(await readFile(path.join(root, "G4", "S5", "T2.md"), "utf8"));
  assert.equal(onDisk.frontmatter.title, "G4.S5.T2: md→GitHub Project projection + sync CLI");
  await cleanup();
});

test("buildFeedbackProposal bundles the context + drafts as a draft proposal", () => {
  const ctx = {
    specRef: "G4.S5",
    issueNumber: 1,
    spec: board.goals[0].specs[0].spec,
    tickets: board.goals[0].specs[0].tickets,
    newComments: [],
    generatedAt: "2026-08-13T12:00:00.000Z",
  };
  const proposal = buildFeedbackProposal("G4.S5", ctx, [], "2026-08-13T12:00:00.000Z");
  assert.equal(proposal.specRef, "G4.S5");
  assert.equal(proposal.generatedAt, "2026-08-13T12:00:00.000Z");
  assert.equal(proposal.context, ctx);
  assert.deepEqual(proposal.drafts, []);
});

test("applyFeedbackDraft writes an approved draft into the board (human-approved apply)", async () => {
  const { root, cleanup } = await tempRoot();
  const { drafts } = await buildPlanDraft(root, {
    goal: { title: "Applied Goal", acceptance_criteria: ["a"] },
    specs: [
      {
        spec: { title: "Applied Spec", acceptance_criteria: ["a"] },
        tickets: [{ title: "Applied Ticket", acceptance_criteria: ["a"] }],
      },
    ],
  });
  const goalPath = await applyFeedbackDraft(root, drafts[0]);
  assert.equal(goalPath, path.join(root, "G1", "Goal.md"));
  const content = parseBoardFile(await readFile(goalPath, "utf8"));
  assert.equal(content.frontmatter.title, "G1: Applied Goal");
  await cleanup();
});

// ---------------------------------------------------------------------------
// feedback context builder
// ---------------------------------------------------------------------------

test("buildFeedbackContext assembles spec md state + new comments for the plan agent", async () => {
  const { root, cleanup } = await tempRoot();
  await writeFixture(root);
  const newComments: GithubIssueComment[] = [{ id: 1, user_login: "bob", body: "add a T5", created_at: "", html_url: "" }];
  const ctx = await buildFeedbackContext(root, board, "G4.S5", 1, newComments, "2026-08-13T12:00:00.000Z");
  assert.equal(ctx.specRef, "G4.S5");
  assert.equal(ctx.issueNumber, 1);
  assert.equal(ctx.spec.id, "s5");
  assert.equal(ctx.tickets.length, 2);
  assert.deepEqual(ctx.newComments, newComments);
  await cleanup();
});
