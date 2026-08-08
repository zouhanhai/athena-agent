import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFrontmatter,
  parseBoardMd,
  renderFrontmatter,
  renderBoardMd,
} from "../src/kanban/frontmatter.js";

test("parseFrontmatter reads scalar key/value pairs", () => {
  const fm = parseFrontmatter(`---
id: t1
layer: T
parent: G3.S6
status: done
---
`);
  assert.deepEqual(fm, {
    id: "t1",
    layer: "T",
    parent: "G3.S6",
    status: "done",
  });
});

test("parseFrontmatter strips surrounding quotes", () => {
  const fm = parseFrontmatter(`---
title: "G3.S6.T1: board structure + md helpers"
assignee: ""
started_at: "2026-08-08"
---
`);
  assert.equal(fm.title, "G3.S6.T1: board structure + md helpers");
  assert.equal(fm.assignee, "");
  assert.equal(fm.started_at, "2026-08-08");
});

test("parseFrontmatter parses numeric values", () => {
  const fm = parseFrontmatter(`---
pr: 0
completed_at: 2026-08-08
---
`);
  assert.equal(fm.pr, 0);
  assert.equal(fm.completed_at, "2026-08-08");
});

test("parseFrontmatter parses an empty inline array", () => {
  const fm = parseFrontmatter(`---
blocked_by: []
---
`);
  assert.deepEqual(fm.blocked_by, []);
});

test("parseFrontmatter parses a non-empty inline array", () => {
  const fm = parseFrontmatter(`---
blocked_by: ["t3", "t4"]
---
`);
  assert.deepEqual(fm.blocked_by, ["t3", "t4"]);
});

test("parseFrontmatter parses a block list", () => {
  const fm = parseFrontmatter(`---
acceptance_criteria:
  - "schema defined"
  - "md read/write helpers work"
---
`);
  assert.deepEqual(fm.acceptance_criteria, ["schema defined", "md read/write helpers work"]);
});

test("parseFrontmatter keeps ':' inside a quoted value", () => {
  const fm = parseFrontmatter(`---
title: "G3.S6.T1: board structure + md helpers"
---
`);
  assert.equal(fm.title, "G3.S6.T1: board structure + md helpers");
});

test("parseFrontmatter returns an empty map when there is no frontmatter", () => {
  assert.deepEqual(parseFrontmatter("# No frontmatter here\n"), {});
});

test("parseFrontmatter handles CRLF line endings", () => {
  const fm = parseFrontmatter("---\r\nid: t1\r\nstatus: done\r\n---\r\n");
  assert.deepEqual(fm, { id: "t1", status: "done" });
});

test("renderFrontmatter writes scalars unquoted when simple", () => {
  const out = renderFrontmatter({ id: "t1", layer: "T", status: "done" });
  assert.equal(out, "id: t1\nlayer: T\nstatus: done");
});

test("renderFrontmatter quotes values that need it", () => {
  const out = renderFrontmatter({
    title: "G3.S6.T1: board structure + md helpers",
    assignee: "",
    completed_at: "2026-08-08",
  });
  assert.match(out, /title: "G3\.S6\.T1: board structure \+ md helpers"/);
  assert.match(out, /assignee: ""/);
  assert.match(out, /completed_at: 2026-08-08/);
});

test("renderFrontmatter renders an empty array inline", () => {
  const out = renderFrontmatter({ blocked_by: [] });
  assert.equal(out, "blocked_by: []");
});

test("renderFrontmatter renders a non-empty array as a block list", () => {
  const out = renderFrontmatter({
    blocked_by: ["t3"],
    acceptance_criteria: ["schema defined", "md read/write helpers work"],
  });
  assert.equal(out, `blocked_by:
  - "t3"
acceptance_criteria:
  - "schema defined"
  - "md read/write helpers work"`);
});

test("frontmatter round-trips: render(parse(x)) parses back to x", () => {
  const input: Record<string, unknown> = {
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
    blocked_by: ["t2"],
    acceptance_criteria: ["schema defined", "md read/write helpers work"],
    pr: 0,
  };
  const rendered = renderFrontmatter(input);
  const reparsed = parseFrontmatter(`---\n${rendered}\n---\n`);
  assert.deepEqual(reparsed, input);
});

test("parseBoardMd splits frontmatter from body", () => {
  const { frontmatter, body } = parseBoardMd(`---
id: t1
title: "G3.S6.T1: board structure + md helpers"
---
# G3.S6.T1: board structure + md helpers

## Task

Standardize G.S.T md structure.
`);
  assert.equal(frontmatter.id, "t1");
  assert.equal(frontmatter.title, "G3.S6.T1: board structure + md helpers");
  assert.equal(body, "# G3.S6.T1: board structure + md helpers\n\n## Task\n\nStandardize G.S.T md structure.\n");
});

test("renderBoardMd joins frontmatter and body with the --- delimiters", () => {
  const out = renderBoardMd({ id: "t1", status: "done" }, "## Task\n");
  assert.equal(out, "---\nid: t1\nstatus: done\n---\n\n## Task\n");
});

test("board md round-trips: renderBoardMd(parseBoardMd(x)) parses back to the same frontmatter", () => {
  const original = `---
id: t1
title: "G3.S6.T1: board structure + md helpers"
layer: T
parent: G3.S6
owner: eng-director
status: done
assignee: opencode
blocked_by:
  - "t2"
acceptance_criteria:
  - "schema defined"
  - "md read/write helpers work"
---
# G3.S6.T1: board structure + md helpers

## Task
Body text.
`;
  const { frontmatter, body } = parseBoardMd(original);
  const rendered = renderBoardMd(frontmatter, body);
  const reparsed = parseBoardMd(rendered);
  assert.deepEqual(reparsed.frontmatter, frontmatter);
  assert.equal(reparsed.body, body);
});
