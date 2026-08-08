import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderBoardMd } from "../src/kanban/frontmatter.js";
import { refToPath, readBoardFile } from "../src/kanban/board.js";
import {
  rejectTicket,
  approveTicket,
  reDecompose,
  claimTicket,
  reportTicket,
  claimableTickets,
  LifecycleError,
} from "../src/kanban/index.js";

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
  return mkdtemp(path.join(tmpdir(), "kanban-lifecycle-"));
}

const NOW = "2026-08-08";

test("rejectTicket marks an in_review ticket rejected with qa_feedback and logs the reviewer", async () => {
  const root = await tempBoard();
  try {
    await writeDoc(root, "G1", goalFm("G1"));
    await writeDoc(root, "G1.S1", specFm("G1.S1"));
    await writeDoc(root, "G1.S1.T1", ticketFm("G1.S1.T1", { status: "in_review", pr: 5 }));

    const result = await rejectTicket(root, "G1.S1.T1", {
      reviewer: "pi-b",
      qaFeedback: "acceptance_criteria 2 not met: login times out",
      now: NOW,
    });
    assert.equal(result.ref, "G1.S1.T1");

    const doc = await readBoardFile(root, "G1.S1.T1");
    assert.equal(doc.frontmatter.status, "rejected");
    assert.equal(doc.frontmatter.qa_feedback, "acceptance_criteria 2 not met: login times out");
    assert.equal(doc.frontmatter.pr, 5, "original PR number is preserved");
    assert.match(doc.body, /\[2026-08-08\] pi-b rejected G1\.S1\.T1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejectTicket only accepts an in_review ticket with reviewer + qa_feedback", async () => {
  const root = await tempBoard();
  try {
    await writeDoc(root, "G1", goalFm("G1"));
    await writeDoc(root, "G1.S1", specFm("G1.S1"));
    await writeDoc(root, "G1.S1.T1", ticketFm("G1.S1.T1", { status: "in_progress", assignee: "pi-a" }));
    await writeDoc(root, "G1.S1.T2", ticketFm("G1.S1.T2", { status: "done" }));
    await writeDoc(root, "G1.S1.T3", ticketFm("G1.S1.T3", { status: "in_review", pr: 3 }));

    await assert.rejects(() => rejectTicket(root, "G1.S1.T1", { reviewer: "pi-b", qaFeedback: "x" }), /in_review/);
    await assert.rejects(() => rejectTicket(root, "G1.S1.T2", { reviewer: "pi-b", qaFeedback: "x" }), /in_review/);
    await assert.rejects(() => rejectTicket(root, "G1.S1.T3", { reviewer: "", qaFeedback: "x" }), /reviewer/);
    await assert.rejects(() => rejectTicket(root, "G1.S1.T3", { reviewer: "pi-b", qaFeedback: "  " }), /qa_feedback/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("approveTicket marks an in_review ticket approved with completed_at and logs", async () => {
  const root = await tempBoard();
  try {
    await writeDoc(root, "G1", goalFm("G1"));
    await writeDoc(root, "G1.S1", specFm("G1.S1"));
    await writeDoc(root, "G1.S1.T1", ticketFm("G1.S1.T1", { status: "in_review", pr: 5 }));

    const result = await approveTicket(root, "G1.S1.T1", { reviewer: "pi-b", pr: 5, now: NOW });
    assert.equal(result.ref, "G1.S1.T1");

    const doc = await readBoardFile(root, "G1.S1.T1");
    assert.equal(doc.frontmatter.status, "approved");
    assert.equal(doc.frontmatter.completed_at, NOW);
    assert.equal(doc.frontmatter.pr, 5);
    assert.match(doc.body, /\[2026-08-08\] pi-b approved G1\.S1\.T1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("approveTicket requires an in_review ticket and a reviewer", async () => {
  const root = await tempBoard();
  try {
    await writeDoc(root, "G1", goalFm("G1"));
    await writeDoc(root, "G1.S1", specFm("G1.S1"));
    await writeDoc(root, "G1.S1.T1", ticketFm("G1.S1.T1", { status: "backlog" }));
    await assert.rejects(() => approveTicket(root, "G1.S1.T1", { reviewer: "pi-b" }), /in_review/);
    await writeDoc(root, "G1.S1.T2", ticketFm("G1.S1.T2", { status: "in_review", pr: 2 }));
    await assert.rejects(() => approveTicket(root, "G1.S1.T2", { reviewer: " " }), /reviewer/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reDecompose creates a new backlog ticket linked to the rejected original", async () => {
  const root = await tempBoard();
  try {
    await writeDoc(root, "G1", goalFm("G1"));
    await writeDoc(root, "G1.S1", specFm("G1.S1"));
    await writeDoc(root, "G1.S1.T1", ticketFm("G1.S1.T1", {
      status: "rejected",
      qa_feedback: "flaky login test",
    }));

    const result = await reDecompose(root, "G1.S1.T1", {
      title: "fix flaky login test",
      acceptanceCriteria: ["login tests stable across 3 runs"],
      reopenReason: "login test flakiness surfaced by qa_feedback",
      task: "stabilize the login e2e test",
      now: NOW,
    });
    assert.equal(result.originalRef, "G1.S1.T1");
    assert.equal(result.ref, "G1.S1.T2");

    const rework = await readBoardFile(root, "G1.S1.T2");
    assert.equal(rework.frontmatter.status, "backlog");
    assert.equal(rework.frontmatter.assignee, "");
    assert.equal(rework.frontmatter.parent_id, "G1.S1.T1");
    assert.equal(rework.frontmatter.qa_feedback, "flaky login test", "qa_feedback carried from original");
    assert.equal(rework.frontmatter.reopen_reason, "login test flakiness surfaced by qa_feedback");
    assert.equal(rework.frontmatter.owner, "eng-director");
    assert.deepEqual(rework.frontmatter.acceptance_criteria, ["login tests stable across 3 runs"]);
    assert.match(rework.frontmatter.title, /G1\.S1\.T2: fix flaky login test/);

    const original = await readBoardFile(root, "G1.S1.T1");
    assert.equal(original.frontmatter.status, "rejected", "original preserved as rejected");
    assert.match(original.body, /re-decomposed G1\.S1\.T1 into G1\.S1\.T2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reDecompose only runs for rejected originals and validates the rework input", async () => {
  const root = await tempBoard();
  try {
    await writeDoc(root, "G1", goalFm("G1"));
    await writeDoc(root, "G1.S1", specFm("G1.S1"));
    await writeDoc(root, "G1.S1.T1", ticketFm("G1.S1.T1", { status: "in_review", pr: 4 }));
    await writeDoc(root, "G1.S1.T2", ticketFm("G1.S1.T2", { status: "rejected" }));

    const good = { title: "rework", acceptanceCriteria: ["done"], reopenReason: "rework needed" };
    await assert.rejects(() => reDecompose(root, "G1.S1.T1", good), /rejected/);
    await assert.rejects(() => reDecompose(root, "G1.S1.T2", { ...good, reopenReason: " " }), /reopen_reason/);
    await assert.rejects(() => reDecompose(root, "G1.S1.T2", { ...good, title: "" }), /title/);
    await assert.rejects(() => reDecompose(root, "G1.S1.T2", { ...good, acceptanceCriteria: [] }), /acceptance_criteria/);
    await assert.rejects(() => reDecompose(root, "G9.S9.T9", good), LifecycleError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a re-decomposed ticket is claimable again by any worker (reject→rework→backlog)", async () => {
  const root = await tempBoard();
  try {
    await writeDoc(root, "G1", goalFm("G1"));
    await writeDoc(root, "G1.S1", specFm("G1.S1"));
    await writeDoc(root, "G1.S1.T1", ticketFm("G1.S1.T1", {
      status: "rejected",
      qa_feedback: "missing error handling",
    }));

    const { ref } = await reDecompose(root, "G1.S1.T1", {
      title: "add error handling",
      acceptanceCriteria: ["errors handled"],
      reopenReason: "review found unhandled errors",
      now: NOW,
    });

    const { scanBoard } = await import("../src/kanban/scan.js");
    const board = await scanBoard(root);
    const claimable = claimableTickets(board).map((t) => t.ref);
    assert.ok(claimable.includes(ref), `${ref} is claimable`);

    const claimed = await claimTicket(root, ref, {
      assignee: "opencode",
      sessionId: "ses_abc",
      now: NOW,
    });
    assert.equal(claimed.ref, ref);
    const doc = await readBoardFile(root, ref);
    assert.equal(doc.frontmatter.status, "in_progress");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("full 6-role lifecycle: claim → done → in_review → reject → re-decompose → re-claim → approve", async () => {
  const root = await tempBoard();
  try {
    await writeDoc(root, "G1", goalFm("G1"));
    await writeDoc(root, "G1.S1", specFm("G1.S1"));
    await writeDoc(root, "G1.S1.T1", ticketFm("G1.S1.T1"));

    // Worker (opencode) claims T1
    await claimTicket(root, "G1.S1.T1", { assignee: "opencode", sessionId: "ses_1", now: NOW });
    // Worker reports implementation done, then opens a PR
    await reportTicket(root, "G1.S1.T1", { status: "done", now: NOW });
    await reportTicket(root, "G1.S1.T1", { status: "in_review", pr: 3, branch: "feat/t1", now: NOW });

    // Reviewer rejects with qa_feedback
    await rejectTicket(root, "G1.S1.T1", {
      reviewer: "pi-b",
      qaFeedback: "login edge case unhandled",
      now: NOW,
    });

    // Eng Director re-decomposes into a new ticket linked to T1
    const { ref } = await reDecompose(root, "G1.S1.T1", {
      title: "handle login edge case",
      acceptanceCriteria: ["edge case handled"],
      reopenReason: "review found an unhandled login edge case",
      now: NOW,
    });
    const rework = await readBoardFile(root, ref);
    assert.equal(rework.frontmatter.status, "backlog");
    assert.equal(rework.frontmatter.parent_id, "G1.S1.T1");

    // Another worker (pi-c) claims the rework ticket directly (no Eng Director needed)
    await claimTicket(root, ref, { assignee: "pi-c", sessionId: "ses_2", now: NOW });
    await reportTicket(root, ref, { status: "done", now: NOW });
    await reportTicket(root, ref, { status: "in_review", pr: 6, now: NOW });

    // Reviewer approves the rework
    await approveTicket(root, ref, { reviewer: "pi-b", pr: 6, now: NOW });
    const approved = await readBoardFile(root, ref);
    assert.equal(approved.frontmatter.status, "approved");

    // Original stays rejected (history preserved)
    const original = await readBoardFile(root, "G1.S1.T1");
    assert.equal(original.frontmatter.status, "rejected");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
