# Kanban Ticket Worker Workflow (REQUIRED)

This is the standard workflow every OpenCode worker must follow for ANY ticket in this repo.
Each ticket file should embed a copy of this (see the "Worker Workflow" section template below).
If a ticket file lacks it, follow this file.

## Worker Workflow (per ticket)

1. **Git claim-lock (FIRST — before any code)**: edit the ticket file's frontmatter to claim it:
   - `status: in_progress`
   - `assignee: opencode`
   - `session_id: <your actual session id>`
   - Then **commit the claim in ONE commit** (one logical change: "claim ticket X"), then push. This is the
     claim lock so no other worker takes it, and the board reflects `in_progress` immediately.
   (The resident opencode plugin also auto-claims on the first tool call — the md claim commit + git push
   is the mutual-exclusion lock; do not manually re-claim.)

2. **Find context**: read this ticket's **parent Spec** (`docs/kanban/G<S>/S<#>/Spec.md`) and **Goal**
   (`docs/kanban/G<S>/Goal.md`) for the full design + acceptance criteria. The ticket is a task within
   the Spec's design — understand the design before coding.

3. **Use codegraph MCP**: run `codegraph explore "<symbols/area>"` (or the `codegraph_explore` MCP tool)
   FIRST to understand the relevant code and its callers before editing.

4. **Use the `implement` + `tdd` skills**: follow the repo's `implement` skill (spec → tickets → code)
   and test-driven development (RED-GREEN-REFACTOR — write a failing test first).

5. **Report progress**: append a row to the **Progress Log** table at the bottom of this ticket file
   (`| UTC timestamp | status | one-line progress |`) on each real change (a tool ran / status moved).
   The plan agent reads this to monitor you; a stale last row = you're stuck.

6. **Commit convention**: feature-level commits, English descriptions, meaningful grouping (not per-file).
   After changes run `codegraph sync` so OpenCode sees the updated codebase.

7. **Verify + mark done**: run the relevant tests (server/web) and keep them green, then set
   `status: done` + update the Progress Log, then commit + push. The md→GitHub auto-sync
   (hook + sync-github CLI) updates the GitHub Project board.

## Template section (embed at top of each ticket body)

```markdown
## Worker Workflow (REQUIRED — follow in order)

1. **Git claim-lock (FIRST)**: set `status: in_progress`, `assignee: opencode`,
   `session_id: <your session id>` in the frontmatter, commit the claim in ONE commit, push.
2. **Find context**: read this ticket's parent Spec (`docs/kanban/<G>/<S>/Spec.md`) + Goal
   (`docs/kanban/<G>/Goal.md`).
3. **Use codegraph MCP**: `codegraph explore "<area>"` before editing.
4. **Use `implement` + `tdd` skills**: TDD (RED-GREEN-REFACTOR), write failing test first.
5. **Report progress**: append a row to the Progress Log table at the bottom on each real change.
6. **Commit convention**: feature-level English commits; `codegraph sync` after.
7. **Verify + mark done**: tests green → `status: done` + Progress Log update → commit + push.

Full: `docs/kanban/TICKET-WORKFLOW.md`
```

## Why

- **Claim lock** prevents two workers doing the same ticket (abandoned tickets / wasted work).
- **Spec/Goal context** stops workers implementing without the full design.
- **codegraph MCP** gives accurate code understanding, fewer wrong edits.
- **implement + tdd** enforce spec-driven + test-first quality.
- **Progress Log** lets the plan agent monitor progress and detect stalls without polling sessions.
- **codegraph sync** keeps the code index fresh so every worker sees the latest code.
