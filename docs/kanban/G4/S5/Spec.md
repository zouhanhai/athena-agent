---
id: s5
title: "G4.S5: Kanban ↔ GitHub Issues bidirectional sync + planning feedback loop"
layer: S
parent: G4
owner: consultant
status: done
milestone: M4
acceptance_criteria:
  - "Each Spec → a GitHub Issue (title 'Gx.Sx <spec title>', tickets as ## Sub-tasks checklist)"
  - "md is the single source of truth; md → GitHub projects spec as issue + syncs ticket status/assignee/session (not Progress Log detail)"
  - "GitHub → md feedback loop: plan agent reads issue discussion and creates/edits tickets or a new spec back into md"
  - "Sync CLI/tool (board.js-style); human keeps authority; md authoritative on conflict"
---

# G4.S5: Kanban ↔ GitHub Issues bidirectional sync + planning feedback loop

## Background

md files stay the single source of truth for agent work; GitHub Projects (v2) + Issues are the team
discussion surface for **multi-person projects** (single-person projects use only local md — no
GitHub). Bidirectional sync with a planning feedback loop.

## Confirmed mapping (2026-08-13)

| md kanban (source of truth) | GitHub Projects v2 |
|-----------------------------|--------------------|
| **Repo** (a multi-person project) | **One Project board** |
| **Goal** (G4) | **Milestone** + a **Label** (`G4`) |
| **Spec** (G4.S1) | **Main Issue** (title `G4.S1 <title>`; body = design doc; comments = team discussion) |
| **Ticket** (G4.S4.T1) | **Sub-issue** (title `G4.S4.T1`; status → Project Status column; blocked_by → issue dependency) |

## Team collaboration flow (Greenfield, 3 users + plan agent, collab mode)

```
1. 3 users + plan agent discuss the goal in Chat
2. plan agent (Consultant→PM→Eng Dir) builds md via planning.ts:
     grill → Goal.md · to-spec → Spec.md · to-ticket → T{n}.md   (Gx.Sy.Tz)
3. md → GitHub Project (sync-github CLI): Spec→main Issue, Ticket→sub-issue,
     status/blocked_by/milestone/label projected
4. Worker claims an md ticket (auto-claim plugin) → develops on a feature
     branch (feat/<ticket>) → tests green → status=done (md) → opens a PR
5. State machine (collab): done → in_review (PR open, pr=<n> branch=<name> on
     the ticket) → Reviewer reviews → Pass → merge → approved | Reject → PR
     updated → re-review
6. Worker's PR merge + status sync → GitHub Project Status column (in_review /
     approved reflect review state)
7. Team discusses on Issue comments → plan agent reads (deduped) → proposes md
     updates (new/edited ticket/spec) → feedback into md → next sync
```

**PR/Merge/Review (from docs/gdd/design.md §8-9, collab mode only):**
- **collab** (multi-person): each developer works on a feature branch → PR → reviewer
  approves/rejects → merge. `in_review` mid-state exists only here.
- **single** (solo/small team): no PR — push master directly; reviewer reviews the diff.
- S5 (Issues/Project sync) is **collab-only** — solo work needs no GitHub discussion surface.
- Review granularity: small team reviews each ticket (user + Hermes); large team reviews at
  Goal/Spec granularity (another user, batch).

md is authoritative; human keeps final authority. GitHub changes are advisory, never silently
overwrite md (conflicts surface as a report for the plan agent).

## Bidirectional flow

### md → GitHub (projection)
- Spec → main Issue; Ticket → sub-issue (see mapping). Title traces to the md file.
- Ticket status → Project Status column; blocked_by → issue dependency; Goal → milestone + label.
- **Progress Log is NOT synced to GitHub** (stays in md only — avoids GitHub noise). A GitHub sub-issue
  shows the ticket description + status + assignee + blocked_by, NOT the minute-level Progress Log.
- Sync CLI/tool (`sync-github.ts`, board.js-style) pushes on demand / key transitions; idempotent.

### GitHub → md (bidirectional, changes are user-confirmed)
- **GitHub Project changes are user-confirmed and authoritative → synced BACK to md** so both stay
  consistent. E.g. a user drags a card to a different Status column on GitHub → that status change is
  written to the md ticket.
- **Every GitHub-derived change is recorded in the md file** with its origin (an audit trail: which
  field changed, from GitHub, timestamp) — e.g. a `## GitHub sync` note or a `synced_from: github`
  marker in the Progress Log, so a human can tell where a change came from.
- **Comments/ideas** → plan agent reads (deduped) → proposes md updates (new/edited ticket/spec via
  planning.ts). Human keeps final authority.

### Conflict handling (md authoritative on ambiguity)
- md is authoritative. GitHub changes are user-confirmed and sync back, but where a sync would be
  ambiguous/conflicting it is surfaced as a report (never silently overwritten) for the plan agent to
  reconcile. A GitHub-derived change is always marked as such in md.

### Workbench view
- The Kanban tab gets a **view toggle: Local kanban vs GitHub Project** (the synced board). User picks
  which to see. Local view keeps Progress Log/stalled/goal tree; GitHub view shows the synced board
  (cards, status, discussion links).

## Dependencies

- G4.S4 (Progress Log, plugin auto-claim) — related; the plugin keeps writing to md.
- Existing `server/src/github/` (REST client + ops) — T1 adds GraphQL for Projects v2.
- Existing `server/src/kanban/planning.ts` (grill→to-spec→to-ticket) — reused for feedback.

## Deliverables

- T1: GitHub GraphQL client + Project v2 API layer (createIssue, sub-issues, milestone, label, status).
- T2: md→GitHub projection (Spec main Issue, Ticket sub-issue, status/blocked_by/milestone/label) + sync CLI.
- T3: GitHub→md sync (user-confirmed changes, origin audit) + feedback loop + md-authoritative conflict handling.
- T4: Workbench Kanban tab view toggle — Local kanban vs GitHub Project (the synced board); local keeps Progress Log/stalled/goal tree; GitHub view shows cards/status/discussion links.
- T5: Fix plugin done double-commit push races (3a index commit not pushed on push-failure; 3b duplicate index commit when worker also regens).
- T6: Project board shows only Spec cards — tickets stay as sub-issues (GitHub-native progress bar); spec status column = md Spec status.
- T7: Spec detail panel — show sub-issues list, embed panel inside Kanban (not overlay Chat), view-in-Issues nav + comment input.
- T8: Spec state machine — full lifecycle (backlog → in_progress → done → in_review → approved/rejected) matching tickets, plan-agent/reviewer triggered.
