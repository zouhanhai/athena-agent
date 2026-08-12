# Git-Driven Development — Protocol Review (WIP, 2026-08-12)

> Full review requested by the user (grill): goals / roles / protocol interfaces / state machine /
> worker lifecycle (claim-progress-complete) / review / per-agent onboarding.
> This file records **confirmed decisions** from the grill; the full protocol rewrite lives in
> `docs/git-kanban-design.md` (to be updated).

## Core premise (confirmed by user)

- **Protocol vs implementation separation**: git-driven development is the athena platform's
  **recommended workflow protocol**, not tied to any one agent. Each user has their own local agent
  and their own code-worker agent (opencode is just the one currently in use). athena only needs to
  tell each agent "**how to plug into our workflow**" — it must not mandate a toolchain.
- **Progress Log table** lives at the bottom of the ticket md file
  (`docs/kanban/Gx/Sx/Tx.md` `## Progress Log` section), not in the kanban index.
- **S4 plugin extension**: the plugin auto-claims (git lock) + logs progress; the **completion
  commit stays with the worker** (quality judgment).

## Confirmed decisions

### D1. `## Log` vs `## Progress Log` (after discussion)
- Keep them separate: `## Log` stays (lifecycle audit: claim/complete/review events, LLM-written),
  `## Progress Log` is added (real-time progress table, **plugin-written**, real wall-clock timestamp
  + rate limit).
- But claim/complete **should also go into the Progress Log** (plugin-written) so the LLM can't
  forget them.
- (This point is still being pinned down — see later grill; merge vs separate not fully settled.)

### D2. kanban index update ownership (confirmed by user)
- **The index file MUST be committed**: the repo lives remote (GitHub); the athena server only sees
  remote changes by git pull. If the index is not committed, the server can't read the remote repo's
  progress.
- **The index commits on every board change**: creating G/S/T, claiming, completing all commit; in
  these commits **also run `write-index.ts` to update kanban-index.json** (no extra commits — those
  changes were going to be committed anyway).
- Trigger: the S4 plugin runs it on claim; the worker runs it on completion; the planner runs it when
  creating G/S/T.
- Frontend board Refresh → `rescan=1` rebuilds automatically (runtime speed), but the committed index
  file keeps the remote repo fresh.

### D3. stalled handling (confirmed by user)
- **stalled is an ED (Eng Director) observation signal** (board UI shows it, based on the Progress Log
  last-row timestamp going stale), **it does NOT change the ticket frontmatter status**.
- Handling: **ED wakes the worker** (monitor posts a wake message to break the reasoning loop) → if
  wake fails → **restart opencode serve + re-dispatch a new worker** (existing §13 monitor-ticket
  mechanism + the S4 progress table as the stalled signal).
- Related to existing `monitor-ticket.sh` + the `monitor-ticket` skill.

### D4. Protocol abstraction granularity (confirmed by user)
- **Keep the status quo (opencode as the example)**: the protocol body keeps using opencode as the
  concrete example (`assignee: opencode`, `codegraph MCP`, `implement` + `tdd` skills).
- **Add a "Other agent onboarding" section**: how Claude Code / Codex / Pi map to the equivalent
  integration points.

### D5. Other agent onboarding (confirmed by user)
- Other code agents use **their own hook system** for claim + progress:
  - Claude Code → hooks; Codex → custom tool; Pi → extensions.
- With no hook capability, **fall back to AGENTS.md instructions** (LLM manually claims/writes
  progress, best-effort).
- The plugin is just opencode's automation implementation; the protocol itself is agent-agnostic.

### D6. opencode plugin API capabilities (confirmed)
- `tool.execute.before` (claim trigger, fires on the first tool call) + `tool.execute.after`
  (progress trigger).
- `session.created/updated/idle/status`, `message.*`, `command.*`.
- Plugin context includes `project / directory / worktree / client / $` (can run git + `npx tsx
  write-index.ts` via `$`).
- Source: https://opencode.ai/v2/docs/build/plugins

### D7. done verification ownership (confirmed by user)
- **Trust worker `done`** + **reviewer runs tests to verify before `approved`** (reviewer is the gate).
- Matches existing §7: worker done → reviewer review → approved/rejected; reviewer actually verifies.

### D8. Single vs collab workflow mode (confirmed by user)
- Depends on whether the project is **collaborative or solo**:
  - **Single** (solo / small team, e.g. current athena: user + Hermes + opencode workers, all pushing
    master directly): PR is useless — reviewer reviews commits/diff on master.
  - **Collab** (multiple people): each person forks + develops independently + merges via PR.
- **The protocol supports BOTH modes, selected per project** (a project config / flag):
  - `single`: direct master, reviewer reviews commit.
  - `collab`: fork + branch + PR merge.

### D9. State machine branches by mode (confirmed by user)
- **single mode**: done → directly reviewer reviews → approved/rejected (**no `in_review` mid-state**).
- **collab mode**: keep `in_review` (PR pending).
- So the state machine branches by workflow mode.

### D10. soul role-playing value (confirmed by user)
- **Keep the role definitions (as a responsibility model)** — Consultant/PM/EngD/Worker/Reviewer/Writer
  each with duty/stages/output + state-machine bindings (roles.ts).
- **Do NOT force soul switching in solo/small-team mode**: when one LLM (Hermes) plays all roles,
  switching souls is just prompt swapping — same model, no real change of perspective.
- Soul role-playing has real value only in **multi-person / multi-agent collaboration** (different
  agents each own a role). So: role definitions stay; strict soul-switching is only meaningful when
  roles are distributed across distinct agents.

### D11. rejected handling (confirmed by user)
- **Flexible, decided by the user based on fix size** — not a fixed single flow:
  - Small fix → user (or Hermes) fixes directly, or returns to the same worker.
  - Larger issue → create a new ticket + re-dispatch.
- So the reject path is not mandated as "always EngD re-decompose"; the user chooses per size.

### D12. Dispatch modes (confirmed by user)
- Two modes:
  - **Interactive (default)**: one ticket at a time. Each ticket ends → test + feedback → possibly
    revise later-ticket designs → **user + planning agent discuss the next dispatch together**.
    Feedback can shape later tickets. This is the default.
  - **YOLO mode** (user-triggered, e.g. user asleep/away): the planning agent **auto-dispatches**
    continuously — scans claimable tickets + dispatches them in sequence (existing `claimableTickets`
    + `dispatchNext`).
- So dispatch is not fully automated by default; it becomes automatic only in YOLO mode.
