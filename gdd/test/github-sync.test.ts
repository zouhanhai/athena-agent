import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  GithubCredential,
  GithubIssue,
  GithubProject,
  GithubProjectItem,
  GitHubApi,
  ProjectV2StatusOptionInput,
} from "../src/github/types.js";
import {
  blockedByToDeps,
  buildIssueForSpec,
  buildIssueForTicket,
  createSpecIssue,
  goalToMilestoneAndLabel,
  specIssueState,
  statusToColumn,
  stripProgressLog,
  stripRefPrefix,
  syncBlockedBy,
  syncSpecStatus,
  syncTicketStatus,
  ticketState,
} from "../src/kanban/github-sync.js";
import type { KanbanBoard } from "../src/kanban/scan.js";

const tokenCredential: GithubCredential = { type: "token", value: "ghp_testtoken" };

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
        return this.issues.get(number)!;
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
