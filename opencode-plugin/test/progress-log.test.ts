import { test } from "node:test";
import assert from "node:assert/strict";
import { appendProgressRow, ProgressAppender } from "../src/progress-log.js";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderBoardMd } from "../../server/src/kanban/frontmatter.js";
import { refToPath, readBoardFile } from "../../server/src/kanban/board.js";

function ticketFm(ref: string): Record<string, unknown> {
  return {
    id: ref.toLowerCase(),
    title: `${ref}: ticket`,
    layer: "T",
    parent: ref.split(".").slice(0, 2).join("."),
    owner: "eng-director",
    status: "in_progress",
    assignee: "opencode",
    session_id: "ses_x",
    blocked_by: [],
    acceptance_criteria: ["done"],
  };
}

async function writeDoc(root: string, ref: string, body: string): Promise<string> {
  const filePath = refToPath(ref, root);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, renderBoardMd(ticketFm(ref), body), "utf8");
  return filePath;
}

test("appendProgressRow creates the table when the section is missing", () => {
  const out = appendProgressRow("# body\n", {
    timestamp: "2026-08-13T08:00:00.000Z",
    status: "in_progress",
    progress: "claimed the ticket",
  });
  assert.match(out, /## Progress Log/);
  assert.match(out, /\| 2026-08-13T08:00:00\.000Z \| in_progress \| claimed the ticket \|/);
  assert.match(out, /# body\n/);
});

test("appendProgressRow appends a row to an existing Progress Log table", () => {
  const body = `## Progress Log
| UTC timestamp | status | progress |
|---|---|---|
| 2026-08-13T07:00:00.000Z | in_progress | started |
`;
  const out = appendProgressRow(body, {
    timestamp: "2026-08-13T08:00:00.000Z",
    status: "in_progress",
    progress: "edited server code",
  });
  assert.match(out, /started \|/);
  assert.match(out, /\| 2026-08-13T08:00:00\.000Z \| in_progress \| edited server code \|/);
  // table header/separator kept once
  assert.equal((out.match(/\| UTC timestamp/g) ?? []).length, 1);
  assert.equal((out.match(/\|\s*-+\s*\|\s*-+\s*\|\s*-+\s*\|/g) ?? []).length, 1);
});

test("appendProgressRow does not duplicate the heading when appended twice", () => {
  const first = appendProgressRow("# body\n", {
    timestamp: "2026-08-13T07:00:00.000Z",
    status: "in_progress",
    progress: "one",
  });
  const second = appendProgressRow(first, {
    timestamp: "2026-08-13T08:00:00.000Z",
    status: "in_progress",
    progress: "two",
  });
  assert.equal((second.match(/## Progress Log/g) ?? []).length, 1);
  assert.match(second, /one \|/);
  assert.match(second, /two \|/);
});

test("ProgressAppender appends a row with the injected real clock time", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "plugin-progress-"));
  try {
    const root = path.join(base, "docs", "kanban");
    await writeDoc(root, "G1.S1.T1", "# body\n");

    const appender = new ProgressAppender({
      boardRoot: root,
      now: () => new Date("2026-08-13T12:34:56.789Z"),
      minIntervalMs: 1000,
    });
    const appended = await appender.append("G1.S1.T1", "in_progress", "ran bash");
    assert.equal(appended, true);

    const doc = await readBoardFile(root, "G1.S1.T1");
    // the real wall-clock value injected (not fabricated)
    assert.match(doc.body, /\| 2026-08-13T12:34:56\.789Z \| in_progress \| ran bash \|/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("ProgressAppender rate-limits: a second append within the window is skipped", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "plugin-rate-"));
  try {
    const root = path.join(base, "docs", "kanban");
    await writeDoc(root, "G1.S1.T1", "# body\n");

    let t = new Date("2026-08-13T12:00:00.000Z");
    const appender = new ProgressAppender({
      boardRoot: root,
      now: () => t,
      minIntervalMs: 5000,
    });
    assert.equal(await appender.append("G1.S1.T1", "in_progress", "first"), true);
    t = new Date("2026-08-13T12:00:03.000Z"); // +3s < 5s
    assert.equal(await appender.append("G1.S1.T1", "in_progress", "second"), false);
    t = new Date("2026-08-13T12:00:06.000Z"); // +6s >= 5s
    assert.equal(await appender.append("G1.S1.T1", "in_progress", "third"), true);

    const body = await readFile(refToPath("G1.S1.T1", root), "utf8");
    assert.doesNotMatch(body, /second \|/);
    assert.match(body, /first \|/);
    assert.match(body, /third \|/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
