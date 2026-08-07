---
id: g3_s5
title: "G3.S5: Workbench 3-Panel"
layer: S
parent: G3
owner: pm
status: active
milestone: M3
acceptance_criteria:
  - "Workbench conversation renders 3-panel layout: Chat | GitHub repo tree | Kanban"
  - "Chat panel reuses S3/S4 conversation"
  - "GitHub repo tree panel consumes S6 GitHub API, expandable to files, scoped to user credential"
  - "Kanban panel consumes S6 docs scan, shows G.S.T board"
  - "Panels are resizable / collapsible"
---

# G3.S5: Workbench 3-Panel

## Task

Build the Workbench 3-panel page (frontend shell): Chat | GitHub repo tree | Kanban. This is a Workbench-type conversation (S3) rendered with the 3-panel layout. All data comes from S6 (GitHub API, docs scan) + S3/S4 (chat).

## Key Dependencies

- G3.S3 (conversation — Workbench type)
- G3.S4 (agent-card chat — left panel)
- G3.S6 (GitHub API, kanban/docs scan — middle + right panels)

## Architecture

```
Workbench conversation (type=workbench, from S3)
  ┌─────────────┬─────────────────────┬─────────────┐
  │ Chat (S3/S4)│ GitHub repo tree    │ Kanban (S6) │
  │   left      │   middle (S6 API)   │   right      │
  └─────────────┴─────────────────────┴─────────────┘
  resizable / collapsible panels
```

## UI Placement (Decided)

- A Workbench conversation (S3) renders the 3-panel layout instead of a plain message stream.
- Panels: Chat (left), GitHub repo tree (middle), Kanban (right).

## Implementation

### 1. 3-panel layout (frontend)
- Resizable/collapsible panels (Vue3 + TDesign split-pane or custom)
- Workbench conversation type triggers this layout

### 2. GitHub repo tree panel (middle)
- Consumes S6 GitHub API: list repos (scoped to user credential), expand tree to files
- File tree: repo → dirs → files (recursive)

### 3. Kanban panel (right)
- Consumes S6 docs-scan: parse docs/kanban/*.md → board (Goals/Specs/Tickets + status)
- Display: columns by status (backlog/in_progress/done/...) or tree by G.S.T

### 4. Chat panel (left)
- Reuses S3 conversation + S4 agent cards

## Reference

- Spec: `docs/kanban/G3/Goal.md`
- Requirements: `docs/g3-requirements.md` §B (Workbench 3-panel) + §4.1 (GitHub)
- Design: `docs/git-kanban-design.md` (kanban structure)

## How to Locate Reference Docs

- `parent: G3` → `docs/kanban/G3/Goal.md`
- Requirements: `docs/g3-requirements.md` §B
- Kanban structure: `docs/git-kanban-design.md`

## Notes

- S5 is the **frontend shell**; all logic (GitHub API, docs scan) lives in S6
- Use **implement** + tdd + code-review

## Dependencies

- G3.S3 (conversation), G3.S4 (chat), G3.S6 (GitHub API + kanban scan)

## Log
