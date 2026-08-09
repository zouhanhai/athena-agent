# M4 Spec — Kanban ↔ GitHub Issues bidirectional sync with planning feedback loop

**Status**: Planned (2026-08-09) · **Milestone**: M4 · **Owner**: eng-director

## Model

**md files remain the single source of truth** for agent work (claiming, status, Progress Log —
agents read/write docs/kanban/*.md directly). **GitHub Issues are the team discussion/collaboration
surface**, projected from the md. The two are **bidirectional**, with planning feedback flowing back.

```
plan agent (grill → to-spec → to-ticket)  →  three-layer md (Goal/Spec/Ticket)
   │
   ▼
docs/kanban (md)  = SINGLE SOURCE OF TRUTH
   │  spec → create GitHub Issue (discussion place)
   │  ticket status / progress → sync to the issue (sub-tasks)
   ▼
GitHub Issue (per Spec)  = team discussion surface
   │  team comments / new ideas
   ▼
plan agent reads the issue's new info  →  new/updated tickets, even a new spec  →  back into md
```

## Bidirectional flow

### md → GitHub (projection)
- Each **Spec** → one GitHub Issue (title = spec title, body = description + `## Sub-tasks` checklist
  mirroring its tickets, linked back to `docs/kanban/<ref>.md`).
- Ticket **state-machine changes** (backlog → in_progress → done / in_review / …) and assignee/session
  sync to the issue (move sub-task checkbox / status).
- **Progress Log detail is NOT pushed** — GitHub shows current status only; the minute-level Progress
  Log stays in the md (avoids spamming GitHub on every tool call).
- A sync tool/CLI (like ABAPlorer's `board.js`) pushes md → GitHub on demand or on key transitions.

### GitHub → md (feedback loop → planning)
- Team discusses on the Issue (comments, new ideas, clarifications).
- The **plan agent** periodically reads issue comments / new info and turns them into md updates:
  new ticket, ticket edit, or even a new spec (grill → to-spec → to-ticket). These flow back into
  the md (source of truth) and the next sync projects them to GitHub.
- Human keeps final authority on spec/ticket changes (md is authoritative).

## Key decisions (to confirm in M4)

1. **Who syncs**: a CLI (`node scripts/board.js`-style) vs an automated service vs the plan agent.
2. **Sync trigger**: on demand, on state-machine transition, or periodic.
3. **Feedback reading**: plan agent scans issues on a schedule or on demand; how to dedupe/prioritize.
4. **Conflict**: md is authoritative — GitHub changes are never silently overwritten; differences are
   surfaced to the plan agent to reconcile.
5. **Issue granularity**: one Issue = one Spec (tickets as sub-task checklist) — confirmed by user.

## Reference

- ABAPlorer workflow (CALEO-Consulting/caleo.int.abaplorer, private): `WORKFLOW-PROPOSAL.md`,
  `scripts/board.js` (GitHub Projects v2 GraphQL, `list/show/start/tick/pr/done`, shared AI machine
  account `caleoki`, human-only PR merge, `ai:created`/`ai:assisted` labels).
- `docs/spec-m4-worker-progress.md` (Progress Log stays in md).
- GitHub Projects v2 GraphQL API (board.js pattern: `updateProjectV2ItemFieldValue`, issue sub-task ticks).
