---
id: G4.S4
title: "G4.S4: Worker progress tracking + auto-claim via OpenCode plugin"
layer: S
parent: G4
owner: pm
status: done
acceptance_criteria:
  - "OpenCode plugin appends a Progress Log row to the ticket md file on a real change (tool ran / status moved), with a REAL wall-clock UTC timestamp"
  - "OpenCode plugin auto-claims a ticket on the first tool call (status=in_progress + assignee + session_id + git commit/push) so the git push is the mutual-exclusion lock; ClaimConflictError surfaces on a lost race"
  - "Completion commit stays manual — the worker decides done and does the status=done commit + push; the plugin never auto-commits the final state"
  - "KanbanTab shows the last Progress Log row + 'updated Xs ago' and flags stalled (old timestamp while in_progress)"
  - "Eng director reads the ticket file for progress; deep-queries the OpenCode session API only when stalled"
---

# G4.S4: Worker progress tracking + auto-claim via OpenCode plugin

## Background

OpenCode workers don't update their ticket file during work, so nobody can see progress/stuck without
manually polling the OpenCode session. Make progress readable directly from the ticket md file, and
make the git claim-lock reliable (auto-claim) so two workers can't claim the same ticket.

## Full design

See `docs/spec-m4-worker-progress.md` + `gdd/docs/design.md` (§4/§5/§6c/§10-§13). Key points:

### Auto-claim (plugin owns the claim + git lock)
- On the first `tool.execute` of a session, the plugin detects the ticket ref (from the structured
  dispatch prompt) and calls `claimTicket` — writes status=in_progress + assignee + session_id and
  does git add/commit/push. The git push IS the mutual-exclusion lock, effective immediately.
- On a lost race (another worker already claimed), surface `ClaimConflictError` so the worker backs off.
- **Claim = one commit** (the plugin does the claim + kanban-index regen together).

### Progress Log (plugin-owned, real timestamps)
- **Critical (2026-08-09 observed)**: LLM workers writing the Progress Log by hand **fabricate
  timestamps** — T1/T2 logs show regular 5-10-min whole-hour stamps that don't match actual commit
  times (T2 done commit 22:44 vs log "21:05"). So the plugin MUST stamp the actual wall-clock time.
- Append a row ONLY on a real change (a tool ran / status moved / milestone) — not a fixed tick; a
  stale last-row timestamp IS the stalled signal. Rate-limit (~1 row / N sec).
- Content is mixed: plugin records tool actions ("edited X / ran Y"); the worker adds a **semantic
  milestone** row when a milestone is complete. Claim/complete rows also go in (plugin writes them).
- **Git strategy**: Progress Log is written locally during work, NOT committed (keeps history clean);
  it's pushed together with the ticket on completion. (The claim row is committed with the claim.)

### Completion (worker owns the final state)
- The worker decides when done (code quality, tests green) and does the status=done commit + push.
- The plugin never auto-commits the final state.
- **Done = two commits**: the worker's done commit + the plugin's separate kanban-index commit
  (reliability over a single commit — the plugin guarantees the index updates even if the worker forgets).

### Kanban reads it
- `KanbanTab` shows the last Progress Log row + updated-ago + stalled flag.
- Eng-director workflow: read file first; deep-query session API only when stalled.

## Dependencies

- G3.S6.T3 (`GitClaimLock` + `claimTicket`) — reused by the plugin for auto-claim.
- The plugin is a **global/resident** OpenCode plugin (loaded at serve startup from
  `.opencode/plugins/`), distinguishing workers by sessionID, parsing the ticket ref from the first
  dispatch message.
- Other agents (Claude Code / Codex / Pi) implement the same integration points via their own hooks or
  fall back to AGENTS.md instructions (§18 of gdd/docs/design.md).

## Deliverables

- OpenCode plugin: auto-claim (git lock + index) + Progress Log appender (real timestamp, rate-limited).
- Kanban parser reads the Progress Log; KanbanTab shows last row + stalled.
- Plugin deployed to the 6900XT opencode serve.
