import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  refToPath,
  parseRef,
  parseBoardFile,
  readBoardFile,
  writeTicketFile,
  type BoardFile,
  type TicketDocument,
} from "../src/kanban/board.js";
import { TICKET_STATUSES } from "../src/kanban/schema.js";

test("parseRef splits a goal ref", () => {
  assert.deepEqual(parseRef("G3"), { g: "G3" });
});

test("parseRef splits a spec ref", () => {
  assert.deepEqual(parseRef("G3.S6"), { g: "G3", s: "S6" });
});

test("parseRef splits a ticket ref", () => {
  assert.deepEqual(parseRef("G3.S6.T1"), { g: "G3", s: "S6", t: "T1" });
});

test("parseRef rejects malformed refs", () => {
  assert.throws(() => parseRef("G"), /G\d+/);
  assert.throws(() => parseRef("G3.S"), /S\d+/);
  assert.throws(() => parseRef("G3.S6.T"), /T\d+/);
  assert.throws(() => parseRef("G3.S6.T1.extra"), /T\d+/);
});

test("refToPath maps a Goal ref to docs/kanban/G{N}/Goal.md", () => {
  assert.equal(refToPath("G3"), "docs/kanban/G3/Goal.md");
});

test("refToPath maps a Spec ref to docs/kanban/G{N}/S{N}/Spec.md", () => {
  assert.equal(refToPath("G3.S6"), "docs/kanban/G3/S6/Spec.md");
});

test("refToPath maps a Ticket ref to docs/kanban/G{N}/S{N}/T{N}.md", () => {
  assert.equal(refToPath("G3.S6.T1"), "docs/kanban/G3/S6/T1.md");
});

test("refToPath accepts an explicit board root", () => {
  assert.equal(refToPath("G3", "/repo/board"), "/repo/board/G3/Goal.md");
});

const TICKET_MD = `---
id: t1
title: "G3.S6.T1: board structure + md helpers"
layer: T
parent: G3.S6
owner: eng-director
status: done
assignee: opencode
session_id: ses_44ab85fcdceaf106
started_at: 2026-08-08
blocked_by: []
acceptance_criteria:
  - "schema defined"
  - "md read/write helpers work"
---

# G3.S6.T1: board structure + md helpers

## Task

Standardize G.S.T md structure.

## Log

[2026-08-08] opencode completed.
`;

const GOAL_MD = `---
id: g3
title: "G3: Multi-Agent Federation & Team Workbench"
layer: G
owner: consultant
status: active
created_at: 2026-08-07
milestone: M3
acceptance_criteria:
  - "Global Chat panel"
  - "Agent Registry"
---

# G3: Multi-Agent Federation & Team Workbench

## Background

Corresponds to M3.
`;

test("parseBoardFile parses a ticket file", () => {
  const doc = parseBoardFile(TICKET_MD);
  assert.equal(doc.frontmatter.layer, "T");
  assert.equal(doc.frontmatter.status, "done");
  assert.equal(doc.frontmatter.assignee, "opencode");
  assert.deepEqual(doc.frontmatter.acceptance_criteria, ["schema defined", "md read/write helpers work"]);
  assert.match(doc.body, /# G3\.S6\.T1: board structure \+ md helpers/);
  assert.match(doc.body, /## Log/);
});

test("parseBoardFile parses a goal file", () => {
  const doc = parseBoardFile(GOAL_MD);
  assert.equal(doc.frontmatter.layer, "G");
  assert.equal(doc.frontmatter.milestone, "M3");
});

test("parseBoardFile throws on a body that is not a G.S.T document", () => {
  assert.throws(() => parseBoardFile("# Not a board doc\n"), /layer/);
});

test("readBoardFile reads a ticket by ref", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kanban-"));
  try {
    const filePath = refToPath("G3.S6.T1", root);
    await import("node:fs/promises").then((fs) => fs.mkdir(path.dirname(filePath), { recursive: true }));
    await import("node:fs/promises").then((fs) => fs.writeFile(filePath, TICKET_MD));

    const doc = await readBoardFile(root, "G3.S6.T1");
    assert.equal(doc.ref, "G3.S6.T1");
    assert.equal(doc.path, filePath);
    assert.equal(doc.frontmatter.layer, "T");
    assert.equal(doc.frontmatter.status, "done");
    assert.equal(doc.body, TICKET_MD.split("---\n\n").slice(1).join("---\n\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readBoardFile throws when the file does not exist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kanban-"));
  try {
    await assert.rejects(() => readBoardFile(root, "G9.S9.T9"), /no such file/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeTicketFile writes a ticket to the right path and creates parent dirs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kanban-"));
  try {
    const doc: BoardFile = {
      ref: "G3.S6.T1",
      path: path.join(root, refToPath("G3.S6.T1", root)),
      frontmatter: {
        id: "t1",
        title: "G3.S6.T1: board structure + md helpers",
        layer: "T",
        parent: "G3.S6",
        owner: "eng-director",
        status: "in_progress",
        assignee: "opencode",
        session_id: "ses_44ab85fcdceaf106",
        started_at: "2026-08-08",
        blocked_by: [],
        acceptance_criteria: ["schema defined", "md read/write helpers work"],
      },
      body: "# G3.S6.T1: board structure + md helpers\n\n## Task\n\nWrite the board.\n",
    };

    const writtenPath = await writeTicketFile(root, doc);
    assert.equal(writtenPath, path.join(root, refToPath("G3.S6.T1", root)));

    const onDisk = await readFile(writtenPath, "utf8");
    assert.match(onDisk, /^---\n/);
    assert.match(onDisk, /status: in_progress/);
    assert.match(onDisk, /session_id: ses_44ab85fcdceaf106/);
    assert.match(onDisk, /- "schema defined"/);
    assert.match(onDisk, /---\n\n# G3\.S6\.T1: board structure \+ md helpers/);

    const reparsed = parseBoardFile(onDisk);
    assert.equal(reparsed.frontmatter.status, "in_progress");
    assert.equal(reparsed.frontmatter.assignee, "opencode");
    assert.deepEqual(reparsed.frontmatter.acceptance_criteria, ["schema defined", "md read/write helpers work"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeTicketFile accepts a ticket document by ref and re-reads it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kanban-"));
  try {
    const ticket: TicketDocument = {
      ref: "G3.S6.T1",
      frontmatter: {
        id: "t1",
        title: "G3.S6.T1: board structure + md helpers",
        layer: "T",
        parent: "G3.S6",
        owner: "eng-director",
        status: "done",
        assignee: "opencode",
        session_id: "ses_44ab85fcdceaf106",
        started_at: "2026-08-08",
        completed_at: "2026-08-08",
        blocked_by: [],
        acceptance_criteria: ["schema defined", "md read/write helpers work"],
        pr: 5,
        branch: "feat/t1-board",
      },
      body: "# G3.S6.T1\n\n## Log\n\ndone.\n",
    };

    await writeTicketFile(root, ticket);

    const read = await readBoardFile(root, "G3.S6.T1");
    assert.equal(read.frontmatter.status, "done");
    assert.equal(read.frontmatter.pr, 5);
    assert.equal(read.frontmatter.branch, "feat/t1-board");
    assert.equal(read.frontmatter.completed_at, "2026-08-08");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseBoardFile produces documents whose status is a valid ticket status", () => {
  const doc = parseBoardFile(TICKET_MD);
  assert.ok((TICKET_STATUSES as readonly string[]).includes(doc.frontmatter.status));
});

test("readBoardFile can read a Goal file too", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kanban-"));
  try {
    const filePath = refToPath("G3", root);
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(path.dirname(filePath), { recursive: true }),
    );
    await import("node:fs/promises").then((fs) => fs.writeFile(filePath, GOAL_MD));
    const doc = await readBoardFile(root, "G3");
    assert.equal(doc.frontmatter.layer, "G");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
