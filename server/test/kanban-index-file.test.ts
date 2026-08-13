import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderBoardMd } from "../src/kanban/frontmatter.js";
import { refToPath } from "../src/kanban/board.js";
import {
  scanBoard,
  type KanbanBoard,
} from "../src/kanban/scan.js";
import {
  toIndex,
  buildIndexFile,
  readIndexFile,
  FileKanbanIndex,
  INDEX_VERSION,
  INDEX_FILENAME,
  type KanbanIndex,
} from "../src/kanban/index-file.js";

const PROGRESS_BODY = [
  "# Body\n",
  "Implementation notes.\n",
  "## Progress Log\n",
  "| Timestamp (UTC) | Status | Progress |\n",
  "|-----------------|--------|----------|\n",
  "| 2026-08-09 12:00:00Z | in_progress | Reading code, understood ticket |\n",
  "| 2026-08-09 12:30:00Z | in_progress | Implementing shared repo selector |\n",
].join("");

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

function goalFm(ref: string): Record<string, unknown> {
  return {
    id: ref.toLowerCase(),
    title: `${ref}: goal`,
    layer: "G",
    owner: "consultant",
    status: "active",
    created_at: "2026-08-01",
    milestone: "M3",
    acceptance_criteria: ["done"],
  };
}

function specFm(ref: string): Record<string, unknown> {
  return {
    id: ref.toLowerCase(),
    title: `${ref}: spec`,
    layer: "S",
    parent: ref.split(".")[0],
    owner: "pm",
    status: "active",
    milestone: "M3",
    acceptance_criteria: ["done"],
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
  return mkdtemp(path.join(tmpdir(), "kanban-index-"));
}

/** A two-layer board (G1 → G1.S1 → T1 with a Progress Log) in a temp dir. */
async function sampleBoard(root: string): Promise<void> {
  await writeDoc(root, "G1", goalFm("G1"));
  await writeDoc(root, "G1.S1", specFm("G1.S1"));
  await writeDoc(root, "G1.S1.T1", ticketFm("G1.S1.T1", { status: "in_progress", assignee: "opencode", session_id: "ses_x" }), PROGRESS_BODY);
}

test("toIndex flattens the scanned board and carries the Progress Log last row", async () => {
  const root = await tempBoard();
  try {
    await sampleBoard(root);
    const board: KanbanBoard = await scanBoard(root, { includeBody: true });
    const index = toIndex(board, "2026-08-09T16:00:00Z");

    assert.equal(index.version, INDEX_VERSION);
    assert.equal(index.generated_at, "2026-08-09T16:00:00Z");
    assert.equal(index.errors.length, 0);

    const goal = index.goals[0];
    assert.deepEqual(
      { ref: goal.ref, id: goal.id, title: goal.title, owner: goal.owner, status: goal.status },
      { ref: "G1", id: "g1", title: "G1: goal", owner: "consultant", status: "active" },
    );
    assert.equal(goal.created_at, "2026-08-01");
    assert.equal(goal.milestone, "M3");

    const spec = goal.specs[0];
    assert.deepEqual(
      { ref: spec.ref, id: spec.id, title: spec.title, status: spec.status },
      { ref: "G1.S1", id: "g1.s1", title: "G1.S1: spec", status: "active" },
    );
    assert.equal(spec.milestone, "M3");

    const ticket = spec.tickets[0];
    assert.deepEqual(
      { ref: ticket.ref, id: ticket.id, title: ticket.title, status: ticket.status, assignee: ticket.assignee, session_id: ticket.session_id },
      { ref: "G1.S1.T1", id: "g1.s1.t1", title: "G1.S1.T1: ticket", status: "in_progress", assignee: "opencode", session_id: "ses_x" },
    );
    assert.equal(ticket.progress_last_row, "Implementing shared repo selector");
    assert.equal(ticket.progress_updated_at, "2026-08-09 12:30:00Z");
    assert.equal(ticket.progress_status, "in_progress");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("toIndex without ticket bodies carries no progress fields", async () => {
  const root = await tempBoard();
  try {
    await sampleBoard(root);
    const board: KanbanBoard = await scanBoard(root);
    const index = toIndex(board);
    assert.equal(index.goals[0].specs[0].tickets[0].progress_last_row, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildIndexFile writes docs/kanban/kanban-index.json and returns the board", async () => {
  const root = await tempBoard();
  try {
    await sampleBoard(root);
    const index = await buildIndexFile(root);
    const indexPath = path.join(root, INDEX_FILENAME);

    const raw = JSON.parse(await readFile(indexPath, "utf8")) as KanbanIndex;
    assert.deepEqual(raw, JSON.parse(JSON.stringify(index)));
    assert.equal(raw.version, INDEX_VERSION);
    assert.ok(typeof raw.generated_at === "string" && raw.generated_at.length > 0);
    assert.equal(raw.goals[0].ref, "G1");
    assert.equal(raw.goals[0].specs[0].tickets[0].progress_last_row, "Implementing shared repo selector");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FileKanbanIndex.read returns the committed index without re-scanning", async () => {
  const root = await tempBoard();
  try {
    const committed: KanbanIndex = {
      version: INDEX_VERSION,
      generated_at: "2026-08-09T00:00:00Z",
      goals: [
        {
          ref: "G9",
          id: "g9",
          title: "G9: from index",
          owner: "consultant",
          status: "active",
          specs: [],
        },
      ],
      errors: [],
    };
    await writeFile(path.join(root, INDEX_FILENAME), JSON.stringify(committed), "utf8");

    const index = new FileKanbanIndex(root);
    const result = await index.read();
    assert.deepEqual(result, committed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FileKanbanIndex.read rescans + writes when the index is missing", async () => {
  const root = await tempBoard();
  try {
    await sampleBoard(root);
    const index = new FileKanbanIndex(root);
    const result = await index.read();

    assert.equal(result.goals[0].ref, "G1");
    assert.equal(result.version, INDEX_VERSION);
    const onDisk = await readIndexFile(root);
    assert.deepEqual(onDisk, JSON.parse(JSON.stringify(result)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FileKanbanIndex.read rescans when the index version is stale", async () => {
  const root = await tempBoard();
  try {
    await sampleBoard(root);
    await writeFile(path.join(root, INDEX_FILENAME), JSON.stringify({ version: 0, generated_at: "", goals: [], errors: [] }), "utf8");

    const result = await new FileKanbanIndex(root).read();
    assert.equal(result.version, INDEX_VERSION);
    assert.equal(result.goals[0].ref, "G1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FileKanbanIndex.rescan rebuilds the index from the md board", async () => {
  const root = await tempBoard();
  try {
    await sampleBoard(root);
    const index = new FileKanbanIndex(root);
    const result = await index.rescan();

    assert.equal(result.goals[0].specs[0].tickets[0].progress_updated_at, "2026-08-09 12:30:00Z");
    const onDisk = JSON.parse(await readFile(path.join(root, INDEX_FILENAME), "utf8")) as KanbanIndex;
    assert.deepEqual(onDisk, JSON.parse(JSON.stringify(result)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readIndexFile returns null for a corrupt or missing index file", async () => {
  const root = await tempBoard();
  try {
    await writeFile(path.join(root, INDEX_FILENAME), "not json {", "utf8");
    assert.equal(await readIndexFile(root), null);

    await rm(path.join(root, INDEX_FILENAME));
    assert.equal(await readIndexFile(root), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
