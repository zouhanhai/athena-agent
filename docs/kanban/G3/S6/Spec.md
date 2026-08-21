---
id: g3_s6
title: "G3.S6: Git-Driven Development (Platform Protocol + GitHub Integration)"
layer: S
parent: G3
owner: pm
status: approved
milestone: M3
acceptance_criteria:
  - "Worker-agnostic protocol: any code-capable agent (Pi/OpenCode/other) can join; platform standardizes md files + git coordination"
  - "G.S.T board structure (docs/kanban/Gx/Sx/Tx.md) defined and reusable"
  - "Planning-agent onboarding: grill→to-spec→to-ticket produces the three layers"
  - "Worker claim/report: worker claims via git claim-lock itself; planning agent notifies/dispatches"
  - "Full 6-role lifecycle: Consultant/PM/EngD/Worker/Reviewer/Writer, each with a soul"
  - "State machine with reject→re-decompose (new ticket T1.1 with parent_id/qa_feedback/reopen_reason)"
  - "GitHub FULL ops: browse (repo tree/PR/Issue) + open PR/edit file/merge, scoped to per-user credential"
  - "Backend can construct kanban view by scanning repo docs/ folder"
---

# G3.S6: Git-Driven Development (Platform Protocol + GitHub Integration)

## Task

Build the git-driven development platform protocol + GitHub integration — the backend core for G3. It standardizes how planning agents produce the G.S.T board, how code agents claim/report, the full 6-role lifecycle, and GitHub full operations. Worker-agnostic: any code-capable agent can join.

## Key Dependencies

- G3.S2 (per-user GitHub credential)
- gdd/docs/design.md (existing mechanism)
- matt pocock skills (grill / to-spec / to-ticket) for the planning flow

## Architecture

```
Planning agent (creates G.S.T md)
   │ notify "take G1.S1.T2"      (dispatch/scheduling)
   ▼
Worker agent → git claim lock    (worker pushes own claim; git = mutex)
   │ report done / in_review
   ▼
Planning agent (receives report)

Roles (each has a soul): Consultant→PM→EngDirector→Worker→Reviewer→Writer
State machine: backlog→in_progress→done→in_review→approved / ↘rejected→EngD re-decompose→T1.1→backlog

GitHub: per-user credential → browse (repo/PR/Issue) + open PR/edit/merge
Kanban: scan docs/kanban/*.md → board
```

## UI Placement (Decided)

- Backend-first. **G3.S4 (Workbench)** renders the GitHub tree + Kanban using these APIs. No separate git-driven admin page in G3.

## Implementation

### 1. G.S.T board structure (protocol)
- Standardize `docs/kanban/Gx/Sx/Tx.md` structure (dir naming, frontmatter, state machine) — already in gdd/docs/design.md
- Provide helpers/schema for reading/writing these md files

### 2. Planning-agent onboarding (grill→to-spec→to-ticket)
- Consultant: grill → Goal.md
- PM: to-spec → Spec.md
- Eng Director: to-ticket → T1..Tn
- Matt pocock skills define the flow; platform provides the md writers + validation

### 3. Worker claim/report protocol
- Worker claims via git claim-lock (push), session_id recorded
- Reports done/in_review, PR number, log
- Planning agent notifies/dispatches which ticket to take
- Worker-agnostic: any code agent

### 4. Full 6-role lifecycle + state machine
- Roles with souls: Consultant / PM / Eng Director / Worker / Reviewer / Writer
- State machine with reject→re-decompose (T1.1, parent_id, qa_feedback, reopen_reason)

### 5. GitHub integration (server/src/routes/github.ts)
- Per-user credential (from S2)
- Browse: list repos, repo tree, PR list, Issue list
- Ops: open PR, edit file (PUT contents), merge PR
- Scoped to the signed-in user's permission

### 6. Kanban docs-scan
- Scan repo docs/kanban/*.md → construct board (Goals/Specs/Tickets + status)
- Backend API: GET /api/kanban (board), consumed by S5

## Reference

- Spec: `docs/kanban/G3/Goal.md`
- Requirements: `docs/g3-requirements.md` §4.2 (git-driven platform protocol)
- Design: `gdd/docs/design.md` (full mechanism: G.S.T, claim lock, state machine, roles, reject flow)
- Matt pocock skills: grill-with-docs / to-spec / to-ticket
- GitHub REST API docs

## How to Locate Reference Docs

- `parent: G3` → `docs/kanban/G3/Goal.md`
- Requirements: `docs/g3-requirements.md` §4.2
- Kanban mechanism: `gdd/docs/design.md`

## Notes

- **Backend logic lives here (S6); frontend rendering in S5.**
- Worker-agnostic: the platform standardizes md + git, not the agent runtime.
- GitHub mutate ops (open PR/edit/merge) are high-risk → add confirm flow (employee watches).
- Use **implement** + tdd + code-review

## Dependencies

- G3.S2 (GitHub credential), gdd/docs/design.md, matt pocock skills

## Log
