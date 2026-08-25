# athena-agent — Git-Driven Collaborative Kanban Design

> Core design: multiple agents operate on the same git repo, coordinating "who should do what, and
> what to continue" via markdown file state in GitHub + git commit history.
> This is a pure git + markdown model (no local SQLite source of truth).

> **Protocol vs implementation**: this is the athena platform's **recommended workflow
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
   integration points with its own tooling.

## 2. Directory Structure = Gx.Sx.Tx Three Layers

```
docs/kanban/
├── G1/                           ← Goal 1 folder (created on launch)
│   ├── Goal.md                   ← G1 grill output (owner: consultant) — to-spec input
│   ├── S1/                       ← Spec 1
│   │   ├── Spec.md               ← G1.S1 spec
│   │   ├── T1.md                 ← Ticket card
│   │   ├── T2.md
│   │   └── ...
│   └── S2/
├── G2/                           ← Goal 2 (launched by another agent)
│   └── ...
└── templates/                    ← Goal/Spec/Ticket .md.template (copy on new-repo setup)

> No kanban-index.json: the local board index was removed (G4.S6.T4); the GitHub Project panel is the
> only board view and the md files themselves are the source of truth.

docs/                              ← design documents (see §3)
├── G1-design.md                  ← whole-Goal design (mapped to Goal)
├── G1.S1-design.md               ← Spec design (mapped to a spec)
├── <topic>-design.md             ← exploratory design (no Goal/Spec yet)
└── ...
```

**Three layers only — the Milestone (M1-M5) layer is removed**: it duplicated the Goal layer.
Goal is the top-level completion granularity. M4 (etc.) may stay as a semantic label on Goals, but
there is no separate milestone completion layer.

### Naming Convention (Directory Hierarchy + Frontmatter Numbering)

| Layer  | Directory | File | Where numbering lives |
|--------|-----------|------|------------------------|
| Goal   | `G1/`, `G2/`... | `Goal.md` | Directory name G1/G2 |
| Spec   | `S1/`, `S2/`... | `Spec.md` | Subdirectory name S1/S2 |
| Ticket | Same spec dir | `T1.md`, `T2.md` | Filename T1/T2 |

Uniqueness via path (`G1/S1/T1`), display via frontmatter `title` ("G1.S1.T1: ...").

> Design docs live under `docs/` (see §3), referenced by name from Goal/Spec templates.

## 3. Design Documents

Design documents (`.md` in `docs/`) hold the detailed design behind a Goal or Spec before/while it's
implemented. Naming follows whether the design is already mapped to a board item:

- **Mapped to a specific spec** → `docs/Gx.Sx-design.md` (e.g. `docs/G4.S1-design.md`).
- **Mapped to a Goal** (spec-level not yet assigned) → `docs/Gx-design.md` (e.g. `docs/G4-design.md`).
- **Still exploratory** (predates any Goal/Spec assignment) → semantic name
  `docs/<topic>-design.md` (e.g. `docs/knowledge-rag-design.md`).

There is no milestone prefix (M4 etc.) — the Milestone layer was removed, so design docs are
named by Goal/Spec or topic, not by milestone.

The board templates (§6) reference these: a Spec's `## Design / Approach` points to its
`Gx.Sx-design.md`; a Goal may point to a `Gx-design.md` for the whole-goal design.

## 4. G Number Assignment (Globally Incrementing, Git Atomic)

Any agent launching a new Goal:
1. git pull (sync latest)
2. Scan `docs/kanban/` for the current max G number
3. New G = max + 1
4. Create `G<N>/` folder + `Goal.md` (owner = launching agent)
5. git commit + push
6. On push conflict (two agents created G6 simultaneously) → pull → recalculate (G7) → retry

Uniqueness guaranteed by git push atomicity.

## 5. Ticket Claim Lock (Worker Claim)

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

**Auto-claim (S4 plugin / hook)**: in opencode the claim is automated — the plugin
claims on the first `tool.execute` call (git lock takes effect immediately, before any work), parsing
the ticket ref from the structured dispatch prompt. The plugin also regenerates + commits the kanban
index on the claim (so the board reflects `in_progress` immediately). Other agents implement the same
via their hook systems or fall back to AGENTS.md instructions.

## 6. Markdown Templates (Goal / Spec / Ticket)

> **Ready-to-copy templates live in `docs/kanban/templates/`** — `Goal.md.template`,
> `Spec.md.template`, `Ticket.md.template`. New repos copy these into their own `docs/kanban/` on setup.
> (The old `TICKET-WORKFLOW.md` is superseded by these templates; the Worker Workflow section is
> embedded in `Ticket.md.template`.)

## 6a. Goal Markdown Template

```markdown
---
id: G1
title: "G1: <goal title>"
layer: G
owner: consultant          # Consultant builds the Goal (role-model)
status: active             # active → done
created_at: <YYYY-MM-DD>
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

## 6b. Spec Markdown Template

```markdown
---
id: G1.S1
title: "G1.S1: <spec title>"
layer: S
parent: G1
owner: pm                  # PM builds the Spec (role-model)
status: backlog            # backlog → in_progress (ticket-driven) → done → in_review → approved / rejected
acceptance_criteria:
  - "<criterion 1>"
  - "<criterion 2>"
---

# G1.S1: <spec title>

## Background
Why this spec exists, what problem it solves...

## Design / Approach
The design decisions, output contract, architecture notes, and any implementation specifics...
(May reference a design doc in `docs/` — if the design maps to this spec, name it
`docs/Gx.Sx-design.md`; if it predates spec assignment (still exploratory), use a semantic name
`docs/<topic>-design.md`. Keep the key points inline.)

## Dependencies
- Other specs this depends on (may reference planned specs — the spec-level ordering is already
  known from the Goal analysis at to-spec time), e.g. `G1.S2` consumes this spec's output contract.

## Deliverables
- <deliverable 1>
- <deliverable 2>
```

## 6c. Ticket Markdown Template

```markdown
---
id: G1.S1.T1
title: "G1.S1.T1: Implement login API"
layer: T
parent: G1.S1
owner: eng-director       # Eng Director builds tickets (role-model)
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

**Auto-claim (S4 plugin / hook)**: the plugin sets `status: in_progress` +
`assignee` + `session_id` and does the git commit/push on the first `tool.execute` call (parsing the
ticket ref from the structured dispatch prompt). The worker's Worker Workflow **starts after the
claim** — no manual status edit or claim commit. Other agents implement the same via their hook
systems or fall back to AGENTS.md instructions.

**`## Log` vs `## Progress Log`**:
- `## Log` = lifecycle audit (claim / complete / review / reject events), LLM-written.
- `## Progress Log` = real-time progress table, **plugin-written** (real wall-clock UTC timestamp +
  rate limit), with the worker occasionally adding a **semantic milestone** line.
- Claim/complete also go into the Progress Log (plugin writes them so the LLM can't forget).
- Progress Log is kept in full (history audit / crash recovery) — never cleaned on completion.

## 6bis. Layer Definition of Done (three layers, no milestone)

```
Goal → acceptance criteria (top-level completion)
  └─ Spec → acceptance criteria (feature container completion; all its tickets approved)
      └─ Ticket → acceptance_criteria (each ticket's completion conditions)
```

Ticket approved → Spec complete → Goal complete. Bottom-up judgment.

## 7. State Machine (branches by workflow mode)

### Ticket state machine

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
| backlog | Not started, claimable | Eng Director (creates ticket) |
| in_progress | Claimed, in development | Worker (claim lock) |
| done | Implementation complete | Worker |
| in_review | PR pending review (**collab only**) | Worker (after opening PR) |
| approved | Review passed (+ merged, collab) | Reviewer |
| rejected | Review found issues | Reviewer |
| canceled | Abandoned / no longer pursued | Eng Director |

- **single mode**: done → reviewer reviews directly → approved/rejected (no `in_review` mid-state).
- **collab mode**: keep `in_review` (PR pending).
- `rejected` may be re-decomposed by Eng Director into new tickets (reject flow, §17).

### Spec state machine

Specs have their own lifecycle (distinct from tickets — a Spec is a planning container, not an
implementation unit). `decomposed` was removed (G4.S6.T2) — the lifecycle is **ticket-driven**:

```
backlog ──(first ticket claimed)──▶ in_progress ──▶ done ──▶ in_review ──▶ approved / rejected
   ▲                                                      └────── rejected → backlog | in_progress (re-decompose)
   └────── canceled (terminal)
```

| State | Meaning | Set by |
|-------|---------|--------|
| backlog | Spec defined, tickets not yet started | Eng Director |
| in_progress | Tickets in development; auto-advances from backlog when the FIRST ticket is claimed | auto (first ticket claim) |
| done | Tickets complete + reviewed | Reviewer/Eng Director (review) |
| in_review | Submitted for acceptance | Eng Director |
| approved | Accepted | Reviewer |
| rejected | Not accepted → re-decompose | Reviewer |
| canceled | Terminal / abandoned | Eng Director |

**Ticket-driven auto-advance**: when a Spec's first ticket becomes `in_progress` (claimed), the Spec
auto-advances `backlog → in_progress` (no manual `decomposed` step). When ALL tickets are done, the Spec
does **NOT** auto-advance to done — it stays `in_progress` awaiting **review** (the reviewer may decide
to add new tickets), and done is reached only via review.

**Workers never change a Spec status** — they only change their own ticket. The Eng Director (plan
agent) drives start/report-done/report-in_review/re-decompose; the Reviewer approves or rejects.
Backward-compat: legacy `active` → `in_progress`.

**GitHub sync**: the Spec's MAIN ISSUE open/closed is synced to its md status — `done`/`approved`/
`canceled` → closed; `backlog`/`in_progress`/`in_review`/`rejected` → open (so the Project Status column
and the issue-list open/closed agree).

## 8. PR/Merge Integration (collab mode only)

```
T1 done (branch feat/t1-login-api):
  → Open GitHub PR → update ticket: status=in_review, pr=<number>, branch=<name>
  → Reviewer reviews → Pass → merge → approved → Reject → PR updated → re-review
```

**single mode**: no PR — direct master, reviewer reviews commits/diff.

## 9. Workflow Modes (single vs collab)

The protocol supports **two modes, selected per project** (a project config / flag):

- **single** (solo / small team — e.g. current athena: user + Hermes + opencode workers all pushing
  master directly): PR is useless; reviewer reviews commits/diff on master.
- **collab** (multiple people): each person forks + develops independently + merges via PR.

Mode-dependent behavior:
- State machine: `in_review` only in collab.
- Issues sync (§19): **optional** — primarily for collab (shared discussion surface), but a solo user
  may also enable it (e.g. to get the GitHub Project board as a visual/remote view). It is a per-project
  flag, not strictly collab-only.
- Review granularity: small team reviews each ticket (user + Hermes, tests green); large team
  reviews at Goal/Spec granularity (another user, batch).

## 10. Progress Log + Real-Time Monitoring (S4)

**Goal**: make worker progress readable directly from the ticket md file, so Kanban/humans can see at
a glance who's progressing / stuck / done — without polling the opencode session API routinely.

- **Written by an OpenCode plugin** (`tool.execute.after` + `session.status`), NOT an AGENTS.md
  instruction (LLM may forget). opencode exposes `tool.execute.before/after`, `session.*`,
  `message.*`, `command.*`; plugin context has `project/directory/worktree/client/$`.
- **REAL wall-clock timestamps** — critical (2026-08-09): LLM-written logs fabricate timestamps. The
  plugin stamps the actual time at each tool execute.
- **Append a row ONLY on a real change** (a tool ran / status moved / milestone) — not a fixed tick.
  A stale last-row timestamp IS the stalled signal.
- Rate-limit (~1 row / N sec) to avoid spam.

**Progress row content**: mixed — plugin records tool actions ("edited X / ran Y") +
worker occasionally writes a semantic milestone ("implemented the shared repo selector").

## 11. Board View (GitHub Project)

Since G4.S6.T4 the local board stack (kanban-index.json, write-index.ts, the local /api/kanban route,
and the Workbench Kanban tab) is **removed**. The **GitHub Project panel is the only board view**:
- GDD's source of truth stays the **md files** (`docs/kanban/Gx/Sx/Tx.md`); they are synced to GitHub
  (Spec main issue + Ticket sub-issues + Status columns) by the md → GitHub sync (sync-github CLI +
  auto-sync plugin on done).
- The GitHub Project panel (Workbench Project tab) reads the repo's Project v2 board (any repo, GDD not
  required) and shows spec cards + sub-issue progress + status columns.
- **No local index**: the board is read live from GitHub, so there is nothing to regenerate/commit. GDD
  commits are just the md changes themselves.

## 12. Stalled Workers

- **stalled is an ED observation signal** (board shows it from the Progress Log last-row timestamp
  going stale) — it does NOT change the ticket frontmatter status.
- Handling: **ED wakes the worker** (monitor posts a wake message to break the reasoning loop) → if
  wake fails → **restart opencode serve + re-dispatch a new worker**.
- **Complementary + tiered with monitor**:
  - Normal: read the Progress Log (plugin-written, real-time).
  - Stall signal (no log for ~3 min): the monitor script (uses opencode server API — the same API
    used to dispatch workers) probes the session (stuck / waiting / long test) + wakes.
- The monitor is not deleted; it's only needed when Progress Log stalls.

## 13. Dispatch

Two modes:
- **Interactive (default)**: one ticket at a time. Each ticket ends → test + feedback → possibly
  revise later-ticket designs → **user + planning agent discuss the next dispatch together**.
  Feedback shapes later tickets.
- **YOLO mode** (user-triggered, e.g. user asleep): the planning agent **auto-dispatches**
  continuously — scans claimable tickets + dispatches them in sequence (`claimableTickets` +
  `dispatchNext`).

**Structured dispatch prompt** — so the plugin can reliably parse the ticket ref:
```
TICKET: G4.S3.T12
PATH: docs/kanban/G4/S3/T12.md

<rest of the dispatch instructions>
```
Standard ticket file path convention: `docs/kanban/Gx/Sx/Tx.md`.

> The plugin's ref parser (`gdd/plugin/src/ticket-ref.ts`) is deliberately lenient: any dispatch
> message containing either a `Gx.Sy.Tz` ref or a `…/Gx/Sy/Tz.md` path is recognized. The structured
> format above is the convention (grep-friendly, unambiguous), not a hard requirement.

## 14. Ticket Granularity + Parallel Workers

- **Ticket granularity**: one ticket = one testable feature change (feature-level commit).
  Spec discussion splits by feature size; two tightly-coupled tickets get merged into one.
- **Parallel workers**: unlimited (multiple in YOLO mode), rely on git claim-lock (prevents
  same-ticket concurrency) + file isolation (different files don't conflict).

## 15. Verification + Review

- **Testing**: worker runs tests (on 6900XT) + reviewer (Hermes/user) independently verifies
  tests green before approved. The 6900XT environment is authoritative.
- **done → approved**: formally mark `approved` (make it a protocol step — Hermes + user often
  forget). Testing is hard to standardize; approve is a contextual "user + Hermes agree tests pass"
  judgment. **Dual-track**:
  - Manual mode: at the next dispatch, check prior tickets are `approved` (gate before dependent work).
  - YOLO mode: auto-approve when tests green + deps pass (risk accepted); user re-tests after returning.
- **Reviewer granularity**: small team reviews each ticket (user + Hermes); large team reviews
  at Goal/Spec granularity (another user), not every ticket.

## 16. Roles (souls) — responsibility model, not strict role-play

Six soul roles (Consultant / PM / Eng Director / Worker / Reviewer / Writer), each with duty /
stages / output + state-machine bindings. Source of truth: `gdd/src/kanban/roles.ts`.

| Role | Duty | Stage | Output | Builds |
|------|------|-------|--------|--------|
| Consultant | grill requirements into a Goal | pre-plan | `Goal.md` | Goal |
| PM | to-spec: decompose the Goal into Specs | planning | `Spec.md` | Spec |
| Eng Director | to-ticket: decompose specs into tickets; re-decompose a rejected ticket | planning, rework | `T{n}.md` tickets + rework tickets | Ticket |
| Worker | implement a ticket: claim via git, develop, report done/in_review | execution | implementation + status report | — |
| Reviewer | review done/in_review tickets; approve or reject with qa_feedback | review | review verdict (approved / rejected) | — |
| Writer | write the docs, PR description and wrap-up deliverables | wrap-up | docs + PR description | — |

**Workers only change their own TICKET status** — they never touch a Spec or Goal status (those are the
Eng Director's / Reviewer's, see §7 Spec state machine).

**Layer → planner owner** (who builds each layer's planning output):

| Layer | Owner |
|-------|-------|
| Goal | Consultant |
| Spec | PM |
| Ticket | Eng Director |

- **Role definitions stay** (as a responsibility model).
- **Do NOT force soul-switching in solo/small-team mode** — one LLM (Hermes) playing all roles:
  switching souls is just prompt swapping (same model, no real change of perspective).
- Soul role-playing has real value only in **multi-person / multi-agent collaboration** (distinct
  agents each own a role).
- **Writer**: only produces the project report / summary at project completion. Mid-project md
  files do NOT use the Writer role.

## 17. Reject Flow

Flexible, **decided by the user based on fix size** — not a fixed single flow:
- Small fix → user (or Hermes) fixes directly, or returns to the same worker.
- Larger issue → create a new ticket + re-dispatch.

Not mandated as "always EngD re-decompose"; the user chooses per size. (The EngD re-decompose path
with parent_id / qa_feedback / reopen_reason remains available for larger issues.)

## 18. Other Agent Onboarding

**The protocol is the contract; each agent implements the integration points with its own tooling.**

- **opencode** (current example): S4 plugin (`tool.execute.before` auto-claim + `tool.execute.after`
  progress + `session.*`). Plugin is global/resident (loaded at serve startup from
  `.opencode/plugins/`), distinguishes workers by sessionID, parses ticket from the first dispatch
  message.
- **Claude Code** → hooks; **Codex** → custom tool; **Pi** → extensions.
- With no hook capability → **fall back to AGENTS.md instructions** (LLM manually claims / writes
  progress, best-effort).
- **Federation agents**: remote agents registering via federation (G4.S7) see the full
  git-driven flow on onboarding, then internally analyze how to apply it to their own local setup +
  their local code agent. The protocol is complementary to federation (a platform feature).

## 19. Issues Sync (S5) — collab mode only

- GitHub Issues are the **shared discussion surface** — only meaningful in collab mode. solo work
  needs no Issues.
- **md is the single source of truth**; md → GitHub projects spec as an issue + syncs ticket
  status/assignee/session (NOT Progress Log detail).
- GitHub → md feedback loop: plan agent reads issue discussion → creates/edits tickets or a new spec
  back into md. Human keeps authority; md authoritative on conflict.

### 19a. Mapping (md kanban → GitHub Projects v2)

| md kanban (source of truth) | GitHub Projects v2 |
|---|---|
| Repo (a multi-person project) | One Project board (linked to the repo) |
| Goal (G4) | Milestone + a Label (`G4`) |
| Spec (G4.S1) | Main Issue (title `G4.S1 <title>`; body = design doc; comments = discussion) |
| Ticket (G4.S4.T1) | Sub-issue (title `G4.S4.T1 <title>`; status → Project Status column; blocked_by → issue dependency) |

- The Project is resolved via `repository.projectsV2` (the repo-linked board), not by title-guessing —
  works for any repo whose project title differs from the repo name.
- Spec cards on the board get an aggregated segmented progress bar + a Spec-card accent; ticket
  sub-issue cards are plain and spread across their Status columns (GitHub-native).
- **Universal progress**: ANY issue that is a parent of sub-issues shows the sub-task progress + the
  Spec-card accent — not only Gx.Sy-named Specs. A repo like abaplorer whose parent issue is titled
  "ABAP Object Import" (9 sub-issues) gets the progress bar too. A plain issue (no sub-issues) stays
  white. Gx.Sy Specs keep working identically.
- Status badges on board cards are colored (In Progress yellow, Done green, Backlog gray, etc.),
  matching the Local kanban / GitHub status colors.
- A repo can have multiple linked Projects; the Workbench GitHub view has a Project selector and shows
  only open Projects.

### 19b. Trigger: when does md → GitHub sync run?

1. **git hook (post-commit)** — `gdd/hooks/post-commit` detects new/modified
   `docs/kanban/**/Goal.md|Spec.md|T*.md` files in a commit and runs
   `sync-github create <specRef>` for each affected spec, so new tickets get their GitHub Issue
   immediately (submit-and-sync). Best-effort — a failure never blocks the commit. Install once per
   clone: `bash gdd/hooks/install-kanban-hook.sh` (sets `git config core.hooksPath gdd/hooks`).
2. **Worker done (auto-sync)** — when a worker marks a ticket done, the OpenCode plugin auto-runs the
   sync for the parent spec so the board's Status columns move (no manual sync after every done).
3. **Manual** — the Eng Director can run `sync-github create|sync <specRef>` anytime (e.g. right after
   decomposing new tickets, "create-on-decompose", so the board reflects the full kanban incl. backlog).

### 19c. Credential & machine notes

- The hook/CLI resolve the GitHub credential **LOCAL-token-first** (`gdd/src/credential.ts`): an
  explicit token → `gh auth token` (gh CLI) → `GITHUB_TOKEN` env → the athena employee store ONLY as
  an optional last-resort fallback when running inside athena (`DATABASE_URL`). So the flow works on
  any machine with just `gh` logged in — no athena server / DB required.
- `sync-github` runs standalone: the separated `gdd/` package has no athena dependency (no Neo4j/KB,
  no employee store on a fresh machine).
- New-ticket Issues first appear under "No Status" briefly (GitHub consistency delay — the board items
  snapshot right after `addIssueToProject` may not include the new item); the next sync moves it to its
  Status column. Cosmetic and self-healing.

### 19d. Progress Log is md-only

The Progress Log (per-tool rows) stays in the md ticket only and is NEVER pushed to GitHub — a GitHub
sub-issue shows the description/status/assignee/blocked_by, not the minute-level Progress Log. Frontend
issue detail panels read the GitHub issue body (not local md), so Progress Log is not shown in the UI
either; it is a backend/dev signal (stalled detection lives in the local-desktop app tier, G7).

## 20. Exception Handling

- Worker crash leaves ticket stuck in_progress → check git log / Progress Log timestamps; if stalled
  → another worker takes over (revert to backlog or take over).
- md conflicts: different workers editing different files won't conflict; two workers racing the same
  ticket — the conflict IS the mutual exclusion lock.
- main concurrency (collab): multiple PRs merging may conflict → resolve via rebase.

## Reference

- `gdd/docs/protocol-review.md` — the grill record (all decisions, formerly D1-D28) behind this design.
- `gdd/src/kanban/` — the separated protocol/sync modules: `protocol.ts` + `git-lock.ts` + `roles.ts`
  + `state-machine.ts` implement claim/report/dispatch, git lock, role souls, state transitions;
  `github-sync.ts` / `github-feedback.ts` implement the md → GitHub projection and the GitHub → md
  feedback loop (see `gdd/docs/backend.md`).
- `gdd/src/sync-github.ts` — the `sync-github` CLI (create/sync/status/pull/feedback/list).
- `gdd/README.md` + `gdd/docs/setup.md` + `gdd/docs/plugins.md` + `gdd/docs/reference.md` — the
  handbook (adoption guide, module docs, plugin docs, concept index).
- OpenCode plugins: https://opencode.ai/v2/docs/build/plugins
