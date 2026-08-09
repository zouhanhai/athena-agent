---
id: tfix
title: "G3.TFIX: Fix 5 failing frontend tests (workbench-shared-repo 2, knowledge-view 2, wiki-view 1)"
layer: T
parent: G3
owner: eng-director
status: done
assignee: opencode
session_id: ses_g3_tfix
started_at: 2026-08-09
completed_at: 2026-08-09
blocked_by: []
acceptance_criteria:
  - "All 5 currently-failing web tests pass: workbench-shared-repo (2), knowledge-view (2), wiki-view (1)"
  - "Full web suite green (npx vitest run) + npx vue-tsc --noEmit 0 errors"
  - "Do NOT weaken production logic to make tests pass — fix the test OR the production bug, whichever is genuinely wrong"
  - "If a production bug is found (e.g. KnowledgeView node-click filtering), fix it properly with a regression test"
---

# G3.TFIX: Fix 5 failing frontend tests

## Context

Baseline (before this ticket) `cd web && npx vitest run` → `5 failed | 319 passed (324)`.
These are a mix of S4.T5-new tests and pre-existing (S8.T1 / S5.T6) tests. Root-cause notes:

### 1. workbench-shared-repo.spec.ts (2) — NEW, from S4.T5
- `fetches repos once and renders ONE repo selector in the header` — line ~98: expected `fetchRepos` called once / ONE selector rendered, got false. Verify the Workbench lifts the selector and fetches once (not per-tab).
- `drives Code, Issues and Kanban from the single selection` — "Cannot call vm on an empty VueWrapper" — likely a child component (CodeTab/IssuesTab/KanbanTab) not found in the test's mount tree.

### 2. knowledge-view.spec.ts (2) — pre-existing (S8.T1 local-graph views)
- `focuses the graph on the clicked node's 1-2 hop neighborhood` — after clicking node n1 in TOPIC mode, expects nodes `[n1,n2,n3]` but got `[n1,n2,n3,n4]` (n4 not filtered).
  - NOTE: `localSubgraph(clusterGraph,'n1',2)` is verified correct in the unit test. The component path `onNodeClick` → `graph.value = localSubgraph(graph.value, nodeId, 2)` may not be firing in the test (GraphStub `trigger('click')` may not invoke the onClick that calls `node:click`), OR the topic-mode graph isn't reassigned. Diagnose whether it's the test stub firing or a real component bug; fix the right one. If the real component doesn't filter in topic mode, that's a real bug — fix with a regression test.
- `shows the detail panel when a node is clicked in a node-local view` — `.knowledge-detail` is empty; same likely root cause (click not firing / detail not rendering).

### 3. wiki-view.spec.ts (1) — pre-existing (S5.T6 left-tree heading outline)
- `shows the selected file's headings in the left tree and scrolls on click` — `.t-tree__item` doesn't contain a "Setup" heading item; `headingItem` is undefined. Verify `attachHeadings`/`extractWikiHeadings` actually add heading child nodes to the tree for the selected file, or whether the test's fixture file lacks a "Setup" heading.

## Requirements
- Fix ALL 5 so the suite is green. Fix genuine production bugs if found (add regression tests), otherwise fix the tests.
- Keep `npx vue-tsc --noEmit` at 0 errors.

## Additional Workbench UX improvements (confirmed 2026-08-09, same ticket)
1. **Collapsible commits panel (Code)**: the commits panel in CodeTab (`<aside class="commits-panel">`)
   must be hideable/collapsible (a toggle to show/hide the commit history list). Keep the HEAD commit
   visible; collapsing hides the full list.
2. **Markdown render toggle (Code/md files)**: when a `.md` file is opened in the Workbench Code tab,
   add a toggle to switch between the raw code view and a **rendered markdown view** (reuse the wiki
   markdown renderer `renderMarkdown` from `@/kb/markdown` for readable display).
3. **Kanban refresh needs scan progress feedback**: the Refresh button in KanbanTab shows only a boolean
   `loading` — no visibility into the scan, so it looks dead ("3 file(s) failed to scan" appears only at
   the end). Add a **scan progress indicator** (e.g. "Scanning docs/kanban…", per-file progress if the
   backend exposes it, or at least a clear in-progress state) so the user knows the refresh is working.
   Check the backend `/api/kanban` scan for whether it can report progress; if not, at least show a
   spinner/"Scanning…" + surface the partial/failed-file count as feedback rather than silence.

## Recommended Skills (OpenCode)
- **tdd** / **code-review** / **diagnosing-bugs** / **codegraph_explore**

## Reference
- `web/src/__tests__/{workbench-shared-repo,knowledge-view,wiki-view}.spec.ts`
- `web/src/views/WorkbenchView.vue`, `web/src/views/KnowledgeView.vue`, `web/src/views/WikiView.vue`
- `web/src/kb/graph.ts` (`localSubgraph`), `web/src/kb/wiki-tree.ts` (`attachHeadings`)

## Log

### 2026-08-09 — opencode (ses_g3_tfix) — done

**Part 1 — the 5 "failing" tests were already green.** Verified the suite head: `cd web && npx vitest run`
→ `324 passed (324)` (rerun under `--pool=forks` single-fork too), and each flagged test individually.
The ticket baseline predates the S4.T5 implementation commits (`e5f57e2` lift repo selector / `26d403b`
commits panel / `4274fbd` repo-bound tabs) that shipped the matching logic + tests:
- `workbench-shared-repo.spec.ts` (2): WorkbenchView lifts the selector + fetches once (onMounted →
  `fetchRepos(tok)`), and passes the single `repo` prop to CodeTab/IssuesTab/KanbanTab — both green.
- `knowledge-view.spec.ts` (2): GraphStub `trigger('click')` → `eventHandlers["node:click"]` →
  `onNodeClick` → `graph.value = localSubgraph(graph.value, nodeId, 2)`. Topic mode correctly filters
  out n4 (nodes become [n1,n2,n3]); detail panel renders (name/type/relations). Both green — the
  "n4 not filtered" failure was a stale-baseline artifact, not a component bug.
- `wiki-view.spec.ts` (1): `attachHeadings`/`extractWikiHeadings` add heading child nodes ("Setup") to
  the left tree and clicking scrolls (`scrollIntoView`). Green.

No test or production code was weakened; the eng director confirmed the failures were a local
workspace-state artifact, not real bugs. **No changes made in Part 1.**

**Part 2 — Workbench UX improvements (implemented):**
1. **Collapsible commits panel (CodeTab)**: `.commits-panel` gains a `Hide/Show` toggle
   (`.commits-toggle`, aria-expanded, ▸/▾ caret) in the panel header. Collapsing shows only the HEAD
   commit (`visibleCommits` = `commits.slice(0,1)`) and hides the full history; expanding restores it.
   The HEAD commit also stays visible in the code-view header (`.code-head`).
2. **Markdown render toggle (CodeTab)**: when a `.md` file is opened, a `Code | Preview` toggle
   (`.md-toggle`) appears in the code-view header. Preview renders via the wiki renderer
   `renderMarkdown` from `@/kb/markdown` (`.md-preview`, styles mirror `.wiki-content`). `viewMode`
   resets to `code` on file/repo/branch change; non-`.md` files get no toggle.
3. **Kanban scan-progress feedback (KanbanTab)**: Refresh now shows a spinner + "Scanning…" on the
   button and a "Scanning docs/kanban…" status (aria-live) in the toolbar while `loading`, plus a
   "Refreshed <time>" stamp after a successful scan. The "X file(s) failed to scan." count stays
   surfaced. The backend `/api/kanban` scan (`scanBoard`/`scanRemoteBoard`) returns a single response
   (no streaming/per-file progress channel), so per the ticket the spinner + failed-count fallback is
   the right surface — verified backend, no change needed.

**Tests**: added 4 CodeTab tests (collapse toggle → HEAD-only + expand, `.md` Code/Preview toggle +
renderMarkdown output, non-md no toggle) and 2 KanbanTab tests (scan-progress state while pending,
failed-scan count). Web: `npx vitest run` → **330/330**, `npx vue-tsc --noEmit` → 0 errors. Server:
`npm test` → **568/568**. Committed feature-level.
