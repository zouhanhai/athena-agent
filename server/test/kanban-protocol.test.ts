import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderBoardMd } from "../src/kanban/frontmatter.js";
import { refToPath, readBoardFile } from "../src/kanban/board.js";
import {
  claimTicket,
  reportTicket,
  claimableTickets,
  dispatchNotice,
  dispatchNext,
} from "../src/kanban/protocol.js";
import type { KanbanBoard, BoardGoal } from "../src/kanban/scan.js";
import type { TicketFrontmatter } from "../src/kanban/schema.js";

async function writeDoc(
  root: string,
  ref: string,
  frontmatter: Record<string, unknown>,
  body = "# body\n",
): Promise<void> {
  const filePath = refToPath(ref, root);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, renderBoardMd(frontmatter, body), "utf8");
}

function goalFm(ref: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ref.toLowerCase(),
    title: `${ref}: goal`,
    layer: "G",
    owner: "consultant",
    status: "active",
    milestone: "M3",
    acceptance_criteria: ["done"],
    ...over,
  };
}

function specFm(ref: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ref.toLowerCase(),
    title: `${ref}: spec`,
    layer: "S",
    parent: ref.split(".")[0],
    owner: "pm",
    status: "active",
    milestone: "M3",
    acceptance_criteria: ["done"],
    ...over,
  };
}

function ticketFm(ref: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ref.toLowerCase(),
    title: `${ref}: ticket`,
    layer: "T",
    parent: ref.split(".").slice(0, 2).join("."),
    owner: "eng-director",
    status: "backlog",
    assignee: "",
    blocked_by: [],
    acceptance_criteria: ["done"],
    ...over,
  };
}

async function tempBoard(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "kanban-protocol-"));
}

const CLAIM = { assignee: "opencode", sessionId: "ses_abc", now: "2026-08-08" };

test("claimTicket sets in_progress + assignee + session_id + started_at and logs", async () => {
  const root = await tempBoard();
  try {
    await writeDoc(root, "G1", goalFm("G1"));
    await writeDoc(root, "G1.S1", specFm("G1.S1"));
    await writeDoc(root, "G1.S1.T1", ticketFm("G1.S1.T1"));

    const result = await claimTicket(root, "G1.S1.T1", CLAIM);
    assert.equal(result.ref, "G1.S1.T1");
    assert.match(result.log, /\[2026-08-08\]/);

    const doc = await readBoardFile(root, "G1.S1.T1");
    assert.equal(doc.frontmatter.status, "in_progress");
    assert.equal(doc.frontmatter.assignee, "opencode");
    assert.equal(doc.frontmatter.session_id, "ses_abc");
    assert.equal(doc.frontmatter.started_at, "2026-08-08");
    assert.match(doc.body, /## Log/);
    assert.match(doc.body, /\[2026-08-08\] opencode claimed G1\.S1\.T1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("claimTicket refuses a ticket that is not backlog", async () => {
  const root = await tempBoard();
  try {
    await writeDoc(root, "G1", goalFm("G1"));
    await writeDoc(root, "G1.S1", specFm("G1.S1"));
    await writeDoc(root, "G1.S1.T1", ticketFm("G1.S1.T1", { status: "done" }));
    await writeDoc(root, "G1.S1.T2", ticketFm("G1.S1.T2", { status: "in_progress", assignee: "pi-a" }));
    await writeDoc(root, "G1.S1.T3", ticketFm("G1.S1.T3", { status: "approved" }));

    await assert.rejects(() => claimTicket(root, "G1.S1.T1", CLAIM), /backlog/i);
    await assert.rejects(() => claimTicket(root, "G1.S1.T2", CLAIM), /backlog/i);
    await assert.rejects(() => claimTicket(root, "G1.S1.T3", CLAIM), /backlog/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("claimTicket refuses a rejected ticket (must go through Eng Director)", async () => {
  const root = await tempBoard();
  try {
    await writeDoc(root, "G1", goalFm("G1"));
    await writeDoc(root, "G1.S1", specFm("G1.S1"));
    await writeDoc(root, "G1.S1.T1", ticketFm("G1.S1.T1", { status: "rejected" }));
    await assert.rejects(() => claimTicket(root, "G1.S1.T1", CLAIM), /Eng Director|reject/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("claimTicket refuses a backlog ticket pre-assigned to another worker", async () => {
  const root = await tempBoard();
  try {
    await writeDoc(root, "G1", goalFm("G1"));
    await writeDoc(root, "G1.S1", specFm("G1.S1"));
    await writeDoc(root, "G1.S1.T1", ticketFm("G1.S1.T1", { assignee: "pi-a" }));
    await assert.rejects(() => claimTicket(root, "G1.S1.T1", CLAIM), /assignee/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("claimTicket refuses a non-ticket ref", async () => {
  const root = await tempBoard();
  try {
    await writeDoc(root, "G1", goalFm("G1"));
    await writeDoc(root, "G1.S1", specFm("G1.S1"));
    await assert.rejects(() => claimTicket(root, "G1", CLAIM), /ticket/i);
    await assert.rejects(() => claimTicket(root, "G1.S1", CLAIM), /ticket/i);
    await assert.rejects(() => claimTicket(root, "G9.S9.T9", CLAIM), /no such file|not exist/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reportTicket marks done with completed_at and records pr + branch + log", async () => {
  const root = await tempBoard();
  try {
    await writeDoc(root, "G1", goalFm("G1"));
    await writeDoc(root, "G1.S1", specFm("G1.S1"));
    await writeDoc(root, "G1.S1.T1", ticketFm("G1.S1.T1"));
    await claimTicket(root, "G1.S1.T1", CLAIM);

    const result = await reportTicket(root, "G1.S1.T1", {
      status: "done",
      pr: 5,
      branch: "feat/t1",
      note: "impl complete",
      now: "2026-08-08",
    });
    assert.equal(result.ref, "G1.S1.T1");

    const doc = await readBoardFile(root, "G1.S1.T1");
    assert.equal(doc.frontmatter.status, "done");
    assert.equal(doc.frontmatter.completed_at, "2026-08-08");
    assert.equal(doc.frontmatter.pr, 5);
    assert.equal(doc.frontmatter.branch, "feat/t1");
    assert.match(doc.body, /\[2026-08-08\] opencode reported done/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reportTicket in_review requires a PR number", async () => {
  const root = await tempBoard();
  try {
    await writeDoc(root, "G1", goalFm("G1"));
    await writeDoc(root, "G1.S1", specFm("G1.S1"));
    await writeDoc(root, "G1.S1.T1", ticketFm("G1.S1.T1"));
    await claimTicket(root, "G1.S1.T1", CLAIM);

    await assert.rejects(() => reportTicket(root, "G1.S1.T1", { status: "in_review" }), /pr/i);

    const result = await reportTicket(root, "G1.S1.T1", {
      status: "in_review",
      pr: 7,
      branch: "feat/t1",
      now: "2026-08-08",
    });
    const doc = await readBoardFile(root, "G1.S1.T1");
    assert.equal(result.log.includes("in_review"), true);
    assert.equal(doc.frontmatter.status, "in_review");
    assert.equal(doc.frontmatter.pr, 7);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reportTicket requires the ticket to be claimed first", async () => {
  const root = await tempBoard();
  try {
    await writeDoc(root, "G1", goalFm("G1"));
    await writeDoc(root, "G1.S1", specFm("G1.S1"));
    await writeDoc(root, "G1.S1.T1", ticketFm("G1.S1.T1"));
    await assert.rejects(() => reportTicket(root, "G1.S1.T1", { status: "done" }), /claim|in_progress/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reportTicket in_review is allowed after done", async () => {
  const root = await tempBoard();
  try {
    await writeDoc(root, "G1", goalFm("G1"));
    await writeDoc(root, "G1.S1", specFm("G1.S1"));
    await writeDoc(root, "G1.S1.T1", ticketFm("G1.S1.T1"));
    await claimTicket(root, "G1.S1.T1", CLAIM);
    await reportTicket(root, "G1.S1.T1", { status: "done", now: "2026-08-08" });

    const result = await reportTicket(root, "G1.S1.T1", {
      status: "in_review",
      pr: 9,
      now: "2026-08-08",
    });
    const doc = await readBoardFile(root, "G1.S1.T1");
    assert.equal(result.ref, "G1.S1.T1");
    assert.equal(doc.frontmatter.status, "in_review");
    assert.equal(doc.frontmatter.pr, 9);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function ticketNode(ref: string, over: Record<string, unknown> = {}): {
  ref: string;
  ticket: TicketFrontmatter;
} {
  return {
    ref,
    ticket: ticketFm(ref, over) as unknown as TicketFrontmatter,
  };
}

function boardWith(goals: BoardGoal[]): KanbanBoard {
  return { goals, errors: [] };
}

test("claimableTickets returns only backlog + unassigned + unblocked + non-rejected tickets", () => {
  const board = boardWith([
    {
      ref: "G1",
      goal: goalFm("G1") as unknown as KanbanBoard["goals"][0]["goal"],
      specs: [
        {
          ref: "G1.S1",
          spec: specFm("G1.S1") as unknown as KanbanBoard["goals"][0]["specs"][0]["spec"],
          tickets: [
            ticketNode("G1.S1.T1"),
            ticketNode("G1.S1.T2", { blocked_by: ["G1.S1.T3"] }),
            ticketNode("G1.S1.T3", { status: "in_progress", assignee: "pi-a" }),
            ticketNode("G1.S1.T4", { status: "done" }),
            ticketNode("G1.S1.T5", { status: "rejected" }),
            ticketNode("G1.S1.T6", { blocked_by: ["G1.S1.T4"] }),
            ticketNode("G1.S1.T7", { assignee: "pi-a" }),
          ],
        },
      ],
    },
  ]);

  const refs = claimableTickets(board).map((t) => t.ref);
  assert.deepEqual(refs, ["G1.S1.T1", "G1.S1.T6"]);
});

test("dispatchNotice builds the take-it message for a claimable ticket", () => {
  const board = boardWith([
    {
      ref: "G1",
      goal: goalFm("G1") as unknown as KanbanBoard["goals"][0]["goal"],
      specs: [
        {
          ref: "G1.S1",
          spec: specFm("G1.S1") as unknown as KanbanBoard["goals"][0]["specs"][0]["spec"],
          tickets: [ticketNode("G1.S1.T1", { title: "G1.S1.T1: implement login" })],
        },
      ],
    },
  ]);

  const notice = dispatchNotice(board, "G1.S1.T1", "pi-a");
  assert.ok(notice, "a claimable ticket should dispatch");
  assert.equal(notice!.ref, "G1.S1.T1");
  assert.deepEqual(notice!.blockedBy, []);
  assert.match(notice!.message, /Take G1\.S1\.T1/);
  assert.match(notice!.message, /implement login/);
  assert.match(notice!.message, /pi-a/);
});

test("dispatchNotice reports blockers and does not dispatch a blocked ticket", () => {
  const board = boardWith([
    {
      ref: "G1",
      goal: goalFm("G1") as unknown as KanbanBoard["goals"][0]["goal"],
      specs: [
        {
          ref: "G1.S1",
          spec: specFm("G1.S1") as unknown as KanbanBoard["goals"][0]["specs"][0]["spec"],
          tickets: [
            ticketNode("G1.S1.T1", { blocked_by: ["G1.S1.T2"] }),
            ticketNode("G1.S1.T2", { status: "in_progress", assignee: "pi-a" }),
          ],
        },
      ],
    },
  ]);

  const notice = dispatchNotice(board, "G1.S1.T1");
  assert.ok(notice);
  assert.deepEqual(notice!.blockedBy, ["G1.S1.T2"]);
  assert.match(notice!.message, /blocked by G1\.S1\.T2/);
});

test("dispatchNotice returns null for an unknown or non-backlog ticket", () => {
  const board = boardWith([
    {
      ref: "G1",
      goal: goalFm("G1") as unknown as KanbanBoard["goals"][0]["goal"],
      specs: [
        {
          ref: "G1.S1",
          spec: specFm("G1.S1") as unknown as KanbanBoard["goals"][0]["specs"][0]["spec"],
          tickets: [
            ticketNode("G1.S1.T1"),
            ticketNode("G1.S1.T2", { status: "done" }),
          ],
        },
      ],
    },
  ]);

  assert.equal(dispatchNotice(board, "G9.S9.T9"), null);
  assert.equal(dispatchNotice(board, "G1.S1.T2"), null);
});

test("dispatchNext scans the board and returns the first claimable ticket", async () => {
  const root = await tempBoard();
  try {
    await writeDoc(root, "G1", goalFm("G1"));
    await writeDoc(root, "G1.S1", specFm("G1.S1"));
    await writeDoc(root, "G1.S1.T1", ticketFm("G1.S1.T1"));
    await writeDoc(root, "G1.S1.T2", ticketFm("G1.S1.T2", { blocked_by: ["G1.S1.T3"] }));
    await writeDoc(root, "G1.S1.T3", ticketFm("G1.S1.T3", { status: "in_progress", assignee: "pi-a" }));
    await writeDoc(root, "G1.S1.T4", ticketFm("G1.S1.T4"));

    const notice = await dispatchNext(root, "pi-a");
    assert.equal(notice!.ref, "G1.S1.T1");
    assert.match(notice!.message, /pi-a/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dispatchNext returns null when every ticket is claimed or blocked", async () => {
  const root = await tempBoard();
  try {
    await writeDoc(root, "G1", goalFm("G1"));
    await writeDoc(root, "G1.S1", specFm("G1.S1"));
    await writeDoc(root, "G1.S1.T1", ticketFm("G1.S1.T1", { blocked_by: ["G1.S1.T2"] }));
    await writeDoc(root, "G1.S1.T2", ticketFm("G1.S1.T2", { status: "in_progress", assignee: "pi-a" }));

    assert.equal(await dispatchNext(root, "pi-a"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
