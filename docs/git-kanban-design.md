# athena-agent — Git-Driven Collaborative Kanban Design

> Core design: multiple agents operate on the same git repo, coordinating "who should do what, and
> what to continue" via markdown file state in GitHub + git commit history.
> This is a pure git + markdown model (no local SQLite source of truth).

> **Protocol vs implementation** (D4/D5): this is the athena platform's **recommended workflow
> protocol**, NOT tied to any one agent. Each user has their own local agent + own code-worker agent.
> opencode is the concrete example used here; other agents (Claude Code / Codex / Pi) implement the
> same integration points via their own hook systems (see §17). The plugin is opencode's automation;
> the protocol itself is agent-agnostic.

## 1. Core Principles

1. **Markdown is the sole source of truth** — `docs/kanban/*.md` stores all task state.
2. **Git is the coordination mechanism** — commit history = activity log, push conflicts = mutual
   exclusion lock.
3. **GitHub is the shared hub** — all agents push/pull the same repo.
4. **Each person/agent has an independent git identity** — git commits distinguish who did what.
5. **Protocol is agent-agnostic** — the workflow spec is defined here; each agent implements the
   integration points with its own tooling (D4/D5).

## 2. Directory Structure = Gx.Sx.Tx Three Layers

```
docs/kanban/
├── kanban-index.json             ← generated fast-read board index (see §10); MUST be committed
├── G1/                           ← Goal 1 folder (created on launch)
│   ├── Goal.md                   ← G1 grill output (owner: pi-a) — to-spec input
│   ├── S1/                       ← Spec 1
│   │   ├── Spec.md               ← G1.S1 spec
│   │   ├── T1.md                 ← Ticket card
│   │   ├── T2.md
│   │   └── ...
│   └── S2/
├── G2/                           ← Goal 2 (launched by another Pi)
│   └── ...
```

**Three layers only — the Milestone (M1-M5) layer is removed** (D25): it duplicated the Goal layer.
Goal is the top-level completion granularity. M4 (etc.) may stay as a semantic label on Goals, but
there is no separate milestone completion layer.

### Naming Convention (Directory Hierarchy + Frontmatter Numbering)

| Layer  | Directory | File | Where numbering lives |
|--------|-----------|------|------------------------|
| Goal   | `G1/`, `G2/`... | `Goal.md` | Directory name G1/G2 |
| Spec   | `S1/`, `S2/`... | `Spec.md` | Subdirectory name S1/S2 |
| Ticket | Same spec dir | `T1.md`, `T2.md` | Filename T1/T2 |

Uniqueness via path (`G1/S1/T1`), display via frontmatter `title` ("G1.S1.T1: ...").

## 3. G Number Assignment (Globally Incrementing, Git Atomic)

Any agent launching a new Goal:
1. git pull (sync latest)
2. Scan `docs/kanban/` for the current max G number
3. New G = max + 1
4. Create `G<N>/` folder + `Goal.md` (owner = launching agent)
5. git commit + push
6. On push conflict (two agents created G6 simultaneously) → pull → recalculate (G7) → retry

Uniqueness guaranteed by git push atomicity.

## 4. Ticket Claim Lock (Worker Claim)

```
Any Worker claiming a ticket:
  1. git pull (latest board)
  2. Select ticket: status = backlog AND assignee = empty/self
     (rejected tickets cannot be claimed directly — must notify Eng Director)
  3. Modify T1.md frontmatter:
     status: in_progress
     assignee: <agent>
     session_id: ses_xxxxxxxx
     started_at: <timestamp>
  4. git commit -m "claim G1.S1.T1 (in_progress)" + push
  5. Push succeeds → locked, begin development
  6. Push conflicts → pull → status already changed → give up, pick next
```

Mutual exclusion via git push atomicity.

**Auto-claim (S4 plugin / hook)** (D1/D21/D23): in opencode the claim is automated — the plugin
claims on the first `tool.execute` call (git lock takes effect immediately, before any work), parsing
the ticket ref from the structured dispatch prompt. The plugin also regenerates + commits the kanban
index on the claim (so the board reflects `in_progress` immediately). Other agents implement the same
via their hook systems or fall back to AGENTS.md instructions (D5).

## 5. Markdown Templates (Goal / Spec / Ticket)

> **Ready-to-copy templates live in `docs/kanban/templates/`** — `Goal.md.template`,
> `Spec.md.template`, `Ticket.md.template`. New repos copy these into their own `docs/kanban/` on setup.
> (The old `TICKET-WORKFLOW.md` is superseded by these templates; the Worker Workflow section is
> embedded in `Ticket.md.template`.)

## 5a. Goal Markdown Template

```markdown
---
id: G1
title: "G1: <goal title>"
layer: G
owner: consultant          # Consultant builds the Goal (role-model; see D10)
status: active             # active → done
created_at: 2026-08-12
acceptance_criteria:
  - "<top-level goal criterion 1>"
  - "<top-level goal criterion 2>"
---

# G1: <goal title>

## Background / Context
Why this goal, what problem it solves...

## Goal
1. <sub-goal 1>
2. <sub-goal 2>
3. <sub-goal 3>

## Confirmed Decisions
- <decision 1>

## Completion Criteria
See frontmatter acceptance_criteria. All Specs under G1 and their Tickets must be approved.
```

> Note: the Goal is created **before** specs are decomposed, so it never references any spec (no
> `G1.S1` etc.) — spec numbering is assigned later by the PM at to-spec time.

## 5b. Spec Markdown Template

```markdown
---
id: G1.S1
title: "G1.S1: <spec title>"
layer: S
parent: G1
owner: pm                  # PM builds the Spec (role-model; see D10)
status: backlog            # backlog → active → done
acceptance_criteria:
  - "<criterion 1>"
  - "<criterion 2>"
---

# G1.S1: <spec title>

## Background
Why this spec exists, what problem it solves...

## Design / Approach
The design decisions, output contract, architecture notes, and any implementation specifics...
(May reference `docs/spec-<name>.md` for the full design; keep the key points inline.)

## Dependencies
- Other specs this depends on (may reference planned specs — the spec-level ordering is already
  known from the Goal analysis at to-spec time), e.g. `G1.S2` consumes this spec's output contract.

## Deliverables
- <deliverable 1>
- <deliverable 2>
```

## 5c. Ticket Markdown Template

```markdown
---
id: G1.S1.T1
title: "G1.S1.T1: Implement login API"
layer: T
parent: G1.S1
owner: eng-director       # Eng Director builds tickets (role-model; see D10)
status: backlog           # backlog → in_progress → done → in_review* → approved / rejected
assignee: ""              # set by the plugin on auto-claim
session_id: ""            # set by the plugin on auto-claim
priority: P1
depends_on: []
blocked_by: []
acceptance_criteria:
  - "POST /api/login returns 200"
pr: 0                     # collab mode only (PR number)
branch: ""                # collab mode only
---

# G1.S1.T1 — Implement login API

## Worker Workflow (REQUIRED — follow in order)

1. **Find context**: read this ticket's parent Spec (`docs/kanban/G1/S1/Spec.md`) + Goal
   (`docs/kanban/G1/Goal.md`).
2. **Use codegraph MCP**: `codegraph explore "<area>"` before editing.
3. **Use `implement` + `tdd` skills**: TDD (RED-GREEN-REFACTOR), write failing test first.
4. **Milestone report**: add a semantic Progress Log row when a milestone is complete (e.g.
   "implemented the shared repo selector") — not on every change. (REAL timestamps, do NOT fabricate.)
5. **Commit convention**: feature-level English commits; `codegraph sync` after.
6. **Verify + mark done**: tests green → set `status: done` → commit + push.

## Context
...

## Task
Implementation details...

## Acceptance
...

## Notes
...

## Progress Log
| UTC timestamp | status | progress |
|---|---|---|
| 2026-08-09 12:00:00Z | in_progress | Reading code, understood ticket |
```

**Auto-claim (S4 plugin / hook)** (D1/D21/D23): the plugin sets `status: in_progress` +
`assignee` + `session_id` and does the git commit/push on the first `tool.execute` call (parsing the
ticket ref from the structured dispatch prompt). The worker's Worker Workflow **starts after the
claim** — no manual status edit or claim commit. Other agents implement the same via their hook
systems or fall back to AGENTS.md instructions (D5).

**`## Log` vs `## Progress Log`** (D1):
- `## Log` = lifecycle audit (claim / complete / review / reject events), LLM-written.
- `## Progress Log` = real-time progress table, **plugin-written** (real wall-clock UTC timestamp +
  rate limit), with the worker occasionally adding a **semantic milestone** line (D19).
- Claim/complete also go into the Progress Log (plugin writes them so the LLM can't forget).
- Progress Log is kept in full (history audit / crash recovery) — never cleaned on completion (D20).

## 5bis. Layer Definition of Done (three layers, no milestone)

```
Goal → acceptance criteria (top-level completion)
  └─ Spec → acceptance criteria (feature container completion; all its tickets approved)
      └─ Ticket → acceptance_criteria (each ticket's completion conditions)
```

Ticket approved → Spec complete → Goal complete. Bottom-up judgment.

## 6. State Machine (branches by workflow mode, D9)

```
single mode (solo / small team):
backlog ──claim(push)──▶ in_progress ──done──▶ (reviewer reviews) ──▶ approved
                                                       └──reject──▶ rejected

collab mode (multi-person):
backlog ──claim(push)──▶ in_progress ──done──▶ in_review (PR open) ──▶ approved
                                                 └──reject──▶ rejected
```

| State | Meaning | Set by |
|-------|---------|--------|
| backlog | Not started, claimable | Planner |
| in_progress | Claimed, in development | Worker (claim lock) |
| done | Implementation complete | Worker |
| in_review | PR pending review (**collab only**) | Worker (after opening PR) |
| approved | Review passed (+ merged, collab) | Reviewer |
| rejected | Review found issues | Reviewer |

- **single mode**: done → reviewer reviews directly → approved/rejected (no `in_review` mid-state).
- **collab mode**: keep `in_review` (PR pending).

## 7. PR/Merge Integration (collab mode only)

```
T1 done (branch feat/t1-login-api):
  → Open GitHub PR → update ticket: status=in_review, pr=<number>, branch=<name>
  → Reviewer reviews → Pass → merge → approved → Reject → PR updated → re-review
```

**single mode**: no PR — direct master, reviewer reviews commits/diff (D8).

## 8. Workflow Modes (single vs collab, D8)

The protocol supports **two modes, selected per project** (a project config / flag):

- **single** (solo / small team — e.g. current athena: user + Hermes + opencode workers all pushing
  master directly): PR is useless; reviewer reviews commits/diff on master.
- **collab** (multiple people): each person forks + develops independently + merges via PR.

Mode-dependent behavior:
- State machine (D9): `in_review` only in collab.
- Issues sync (D27): S5 only enabled in collab (solo work needs no Issues).
- Review granularity (D16): small team reviews each ticket (user + Hermes, tests green); large team
  reviews at Goal/Spec granularity (another user, batch).

## 9. Progress Log + Real-Time Monitoring (S4)

**Goal**: make worker progress readable directly from the ticket md file, so Kanban/humans can see at
a glance who's progressing / stuck / done — without polling the opencode session API routinely.

- **Written by an OpenCode plugin** (`tool.execute.after` + `session.status`), NOT an AGENTS.md
  instruction (LLM may forget). (D6 confirms opencode exposes `tool.execute.before/after`,
  `session.*`, `message.*`, `command.*`; plugin context has `project/directory/worktree/client/$`.)
- **REAL wall-clock timestamps** — critical (2026-08-09): LLM-written logs fabricate timestamps. The
  plugin stamps the actual time at each tool execute.
- **Append a row ONLY on a real change** (a tool ran / status moved / milestone) — not a fixed tick.
  A stale last-row timestamp IS the stalled signal.
- Rate-limit (~1 row / N sec) to avoid spam.

**Progress row content (D19)**: mixed — plugin records tool actions ("edited X / ran Y") +
worker occasionally writes a semantic milestone ("implemented the shared repo selector").

## 10. Kanban Index (D2)

- `docs/kanban/kanban-index.json` (generated by `server/scripts/write-index.ts`) is the fast-read
  view served by `GET /api/kanban`.
- **The index file MUST be committed**: the repo lives remote (GitHub); the server only sees remote
  changes by git pull. Without a committed index, the server can't read a remote repo's progress.
- **The index commits on every board change**: creating G/S/T, claiming, completing — in those commits
  also run `write-index.ts` to update kanban-index.json (no extra commits; those changes were going to
  be committed anyway).
- Triggers: S4 plugin on claim (one commit with the claim) and on completion (a separate index
  commit after the worker's done commit — D29); planner on G/S/T creation.
- Frontend Refresh → `rescan=1` rebuilds at runtime; the committed index keeps the remote repo fresh.

## 11. Stalled Workers (D3)

- **stalled is an ED observation signal** (board shows it from the Progress Log last-row timestamp
  going stale) — it does NOT change the ticket frontmatter status.
- Handling: **ED wakes the worker** (monitor posts a wake message to break the reasoning loop) → if
  wake fails → **restart opencode serve + re-dispatch a new worker**.
- **Complementary + tiered with monitor (D15)**:
  - Normal: read the Progress Log (plugin-written, real-time).
  - Stall signal (no log for ~3 min): the monitor script (uses opencode server API — the same API
    used to dispatch workers) probes the session (stuck / waiting / long test) + wakes.
- The monitor is not deleted; it's only needed when Progress Log stalls.

## 12. Dispatch (D12)

Two modes:
- **Interactive (default)**: one ticket at a time. Each ticket ends → test + feedback → possibly
  revise later-ticket designs → **user + planning agent discuss the next dispatch together**.
  Feedback shapes later tickets.
- **YOLO mode** (user-triggered, e.g. user asleep): the planning agent **auto-dispatches**
  continuously — scans claimable tickets + dispatches them in sequence (`claimableTickets` +
  `dispatchNext`).

**Structured dispatch prompt (D23)** — so the plugin can reliably parse the ticket ref:
```
TICKET: G4.S3.T12
PATH: docs/kanban/G4/S3/T12.md

<rest of the dispatch instructions>
```
Standard ticket file path convention: `docs/kanban/Gx/Sx/Tx.md`.

## 13. Ticket Granularity + Parallel Workers

- **Ticket granularity (D14)**: one ticket = one testable feature change (feature-level commit).
  Spec discussion splits by feature size; two tightly-coupled tickets get merged into one.
- **Parallel workers (D13)**: unlimited (multiple in YOLO mode), rely on git claim-lock (prevents
  same-ticket concurrency) + file isolation (different files don't conflict).

## 14. Verification + Review (D7 / D16 / D17)

- **Testing (D17)**: worker runs tests (on 6900XT) + reviewer (Hermes/user) independently verifies
  tests green before approved. The 6900XT environment is authoritative.
- **done → approved (D24)**: formally mark `approved` (make it a protocol step — Hermes + user often
  forget). Testing is hard to standardize; approve is a contextual "user + Hermes agree tests pass"
  judgment. **Dual-track**:
  - Manual mode: at the next dispatch, check prior tickets are `approved` (gate before dependent work).
  - YOLO mode: auto-approve when tests green + deps pass (risk accepted); user re-tests after returning.
- **Reviewer granularity (D16)**: small team reviews each ticket (user + Hermes); large team reviews
  at Goal/Spec granularity (another user), not every ticket.

## 15. Roles (souls) — responsibility model, not strict role-play (D10/D26)

Six soul roles (Consultant / PM / Eng Director / Worker / Reviewer / Writer), each with duty /
stages / output + state-machine bindings (`server/src/kanban/roles.ts`).

- **Role definitions stay** (as a responsibility model).
- **Do NOT force soul-switching in solo/small-team mode** — one LLM (Hermes) playing all roles:
  switching souls is just prompt swapping (same model, no real change of perspective).
- Soul role-playing has real value only in **multi-person / multi-agent collaboration** (distinct
  agents each own a role).
- **Writer (D26)**: only produces the project report / summary at project completion. Mid-project md
  files do NOT use the Writer role.

## 16. Reject Flow (D11)

Flexible, **decided by the user based on fix size** — not a fixed single flow:
- Small fix → user (or Hermes) fixes directly, or returns to the same worker.
- Larger issue → create a new ticket + re-dispatch.

Not mandated as "always EngD re-decompose"; the user chooses per size. (The EngD re-decompose path
with parent_id / qa_feedback / reopen_reason remains available for larger issues.)

## 17. Other Agent Onboarding (D4 / D5 / D28)

**The protocol is the contract; each agent implements the integration points with its own tooling.**

- **opencode** (current example): S4 plugin (`tool.execute.before` auto-claim + `tool.execute.after`
  progress + `session.*`). Plugin is global/resident (loaded at serve startup from
  `.opencode/plugins/`), distinguishes workers by sessionID, parses ticket from the first dispatch
  message (D18/D22).
- **Claude Code** → hooks; **Codex** → custom tool; **Pi** → extensions.
- With no hook capability → **fall back to AGENTS.md instructions** (LLM manually claims / writes
  progress, best-effort).
- **Federation agents (D28)**: remote agents registering via federation (G4.S6) see the full
  git-driven flow on onboarding, then internally analyze how to apply it to their own local setup +
  their local code agent. The protocol is complementary to federation (a platform feature).

## 18. Issues Sync (S5) — collab mode only (D27)

- GitHub Issues are the **shared discussion surface** — only meaningful in collab mode. solo work
  needs no Issues.
- **md is the single source of truth**; md → GitHub projects spec as an issue + syncs ticket
  status/assignee/session (NOT Progress Log detail).
- GitHub → md feedback loop: plan agent reads issue discussion → creates/edits tickets or a new spec
  back into md. Human keeps authority; md authoritative on conflict.

## 19. Exception Handling

- Worker crash leaves ticket stuck in_progress → check git log / Progress Log timestamps; if stalled
  → another worker takes over (revert to backlog or take over).
- md conflicts: different workers editing different files won't conflict; two workers racing the same
  ticket — the conflict IS the mutual exclusion lock.
- main concurrency (collab): multiple PRs merging may conflict → resolve via rebase.

## Reference

- `docs/git-driven-protocol-review.md` — the grill record (D1-D28) behind this design.
- `server/src/kanban/protocol.ts` + `git-lock.ts` + `roles.ts` + `state-machine.ts` — the backend
  implementations of claim/report/dispatch, git lock, role souls, state transitions.
- `server/scripts/write-index.ts` — kanban index builder.
- `docs/kanban/TICKET-WORKFLOW.md` — per-ticket worker workflow (opencode example).
- OpenCode plugins: https://opencode.ai/v2/docs/build/plugins
