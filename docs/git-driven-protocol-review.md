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
