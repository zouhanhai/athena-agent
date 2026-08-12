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

### D13. Parallel workers (confirmed by user)
- **Unlimited parallel** (multiple workers can be opened in YOLO mode), rely on **git claim-lock**
  (prevents same-ticket concurrency) + **file isolation** (different workers editing different files
  don't conflict).

### D14. Ticket granularity (confirmed by user)
- **Keep the current granularity**: one ticket = one testable feature change (feature-level commit).
- Spec discussion splits tickets by feature size; two tickets that are too tightly coupled get merged
  into one larger ticket.

### D15. S4 plugin vs monitor (confirmed by user)
- **Complementary + tiered**:
  - **Normal**: read the Progress Log (plugin-written, real-time).
  - **Stall signal (no log for ~3 min)**: the monitor script (uses opencode server API) probes the
    session (stuck / waiting / long test) + wakes the worker.
- The monitor uses the opencode server API (same API used to dispatch workers), so it's not deleted;
  it's only needed when Progress Log stalls.

### D16. Reviewer ownership + granularity (confirmed by user)
- **Small team (current)**: user + Hermes review together — tests pass before moving on (no formal
  approved status used in practice, but the gate is "tests green + analysis ok").
- **Large team**: review at **Goal/Spec granularity** — another user reviews the completion of a Goal
  or Spec (batch), NOT every ticket. Reduces review load.

### D17. Testing ownership (confirmed by user)
- **Worker runs tests (on 6900XT)** + reviewer (Hermes/user) independently verifies tests green before
  approved.
- The 6900XT environment is authoritative for verification.

### D18. Plugin residency + ticket detection (confirmed by user)
- **Plugin is global/resident** (loaded at opencode serve startup from `.opencode/plugins/`, shared by
  all workers/sessions), distinguished per worker by **sessionID**.
- **Ticket detection**: the plugin parses the current ticket ref from the **session's first message**
  (the dispatch prompt, which names the ticket ref).
- Implication: dispatch prompt must carry the ticket ref in a stable, parseable position.

### D19. Progress row content granularity (confirmed by user)
- **Mixed**:
  - **Plugin records tool actions** (automatic, real — "edited X / ran Y command").
  - **Worker occasionally writes a semantic milestone** ("implemented the shared repo selector").
- Balances automatic real-time truth + meaningful semantic updates.

### D20. Progress Log retention (confirmed by user)
- **Keep the full Progress Log** (history audit; useful for worker takeover / crash recovery).
- No cleanup on completion — the full log stays.

### D22. Plugin reads dispatch message (confirmed by user)
- The plugin CAN read session messages (`GET /api/session/{sessionID}/message` or SDK
  `session.messages` / `client.message.list`) → parse the ticket ref from the dispatch prompt
  (session's first user message).

### D23. Structured dispatch prompt (confirmed by user)
- **Dispatch prompt must be structured** so the plugin can easily find the ticket ref:
  ```
  TICKET: G4.S3.T12
  PATH: docs/kanban/G4/S3/T12.md

  <rest of the dispatch instructions>
  ```
- Also standardize the ticket file path convention (`docs/kanban/Gx/Sx/Tx.md`) so the plugin can
  locate the file reliably.
- All future dispatches follow this format.

### D24. done → approved flow (confirmed by user)
- **Should formally mark `approved`**, but Hermes + user often forget — make it a protocol step.
- Testing is hard to standardize (each ticket differs); approve is a contextual "user + Hermes agree
  tests pass" judgment in manual mode.
- **Dual-track**:
  - **Manual (interactive) mode**: at the next dispatch, check that prior tickets are `approved`
    (gate before dispatching dependent work).
  - **YOLO mode**: auto-approve when tests green + dependencies pass (risk accepted); the user
    re-tests the auto-completed work after returning.
- So `approved` is formally tracked; YOLO auto-marks it, manual mode gates dispatch on it.
