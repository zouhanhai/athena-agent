---
id: g3_s4
title: "G3.S4: Workbench (GitHub-Style Content Area)"
layer: S
parent: G3
owner: pm
status: approved
milestone: M3
acceptance_criteria:
  - "Workbench page shows 3 tabs: Code | Issues | Kanban"
  - "Code tab: GitHub-style file tree (left) + code view (right) with line numbers + syntax highlighting + branch selector, scoped to per-user credential"
  - "Issues tab: GitHub-style issue list"
  - "Kanban tab: board from S6 docs-scan"
  - "Global Chat panel (S3) present on the Workbench page (right side)"
---

# G3.S4: Workbench (GitHub-Style Content Area)

## Task

Build the Workbench page — a GitHub-style content area with 3 tabs (Code / Issues / Kanban), scoped to the per-user GitHub credential. The global Chat panel (S3) is present on the right.

## Key Dependencies

- G3.S2 (per-user GitHub credential)
- G3.S6 (GitHub API + kanban docs-scan backend)
- G3.S3 (global chat panel on the page)

## Architecture

```
Workbench page (center content area)
┌──────────────────────────────────────────────┐
│ [Code] [Issues] [Kanban]   ← 3 tabs          │
├──────────────────────────────────────────────┤
│ Code tab (GitHub-style):                     │
│  ┌──────────────┬─────────────────────────┐  │
│  │ repo tree    │ code view              │  │
│  │ + branch     │ line numbers + syntax  │  │
│  │ selector     │ highlight              │  │
│  └──────────────┴─────────────────────────┘  │
│ Issues tab: GitHub-style issue list          │
│ Kanban tab: board from S6 docs-scan          │
└──────────────────────────────────────────────┘
(Global Chat panel S3 on the right)
```

## UI Placement (Decided)

- Workbench is a sidebar nav item (page). Center content = 3 GitHub-style tabs.
- Global Chat (S3) on the right, same as every other page.

## Implementation

### 1. Workbench page with 3 tabs (frontend)
- [Code] [Issues] [Kanban] tab bar (TDesign tabs)
- Global Chat panel (S3) on the right

### 2. Code tab (GitHub-style)
- Left: repo tree (folders/files, expandable to leaf) + branch selector
- Right: code view with line numbers + syntax highlighting (per-language colors)
- Scoped to per-user credential (S2)
- Consumes S6 GitHub API

### 3. Issues tab (GitHub-style)
- Issue list (open/closed, labels, assignees)
- Consumes S6 GitHub API

### 4. Kanban tab
- Board from S6 docs-scan (Goals/Specs/Tickets + status)
- Consumes S6 /api/kanban

## Reference

- Spec: `docs/kanban/G3/Goal.md`
- Requirements: `docs/g3-requirements.md` §4.1 (GitHub) + SUPERSEDED layout
- GitHub UI reference (the attached screenshot / repo UI)

## How to Locate Reference Docs

- `parent: G3` → `docs/kanban/G3/Goal.md`
- Requirements: `docs/g3-requirements.md` §4.1

## Notes

- S4 is the **frontend shell**; all logic (GitHub API, docs scan) lives in S6.
- Per-user credential scoping is essential (each user sees only their repos).
- Use **implement** + tdd + code-review

## Dependencies

- G3.S2 (GitHub credential), G3.S6 (GitHub API + kanban scan), G3.S3 (chat)

## Log
