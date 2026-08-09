---
id: tfix
title: "G3.TFIX: Fix 5 failing frontend tests (workbench-shared-repo 2, knowledge-view 2, wiki-view 1)"
layer: T
parent: G3
owner: eng-director
status: backlog
assignee: ""
started_at: ""
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

## Recommended Skills (OpenCode)
- **tdd** / **code-review** / **diagnosing-bugs** / **codegraph_explore**

## Reference
- `web/src/__tests__/{workbench-shared-repo,knowledge-view,wiki-view}.spec.ts`
- `web/src/views/WorkbenchView.vue`, `web/src/views/KnowledgeView.vue`, `web/src/views/WikiView.vue`
- `web/src/kb/graph.ts` (`localSubgraph`), `web/src/kb/wiki-tree.ts` (`attachHeadings`)

## Log
