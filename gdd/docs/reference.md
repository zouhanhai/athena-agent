# GDD Reference — concept index

A quick-reference index for the GDD protocol's concepts. For the full protocol see
[`design.md`](design.md); for setup see [`setup.md`](setup.md).

## Gx.Sx.Tx — the three-layer ref system

Every board item is identified by a dot-separated ref; uniqueness comes from the directory path, the
display title carries the ref.

| Layer | Ref | Directory / file | Built by | Meaning |
|---|---|---|---|---|
| **Goal** | `G4` | `docs/kanban/G4/Goal.md` | Consultant | Top-level completion unit (grill output) |
| **Spec** | `G4.S1` | `docs/kanban/G4/S1/Spec.md` | PM | Feature container; decomposition of a Goal |
| **Ticket** | `G4.S1.T3` | `docs/kanban/G4/S1/T3.md` | Eng Director | One testable feature change (implementation unit) |

- File-path convention: `docs/kanban/Gx/Sy/Tx.md` (the plugin parses refs from paths and dot-form).
- The **Milestone layer is removed** (M1–M5): Goal is the top-level completion granularity; a
  milestone may remain only as a semantic label on a Goal.
- Layer Definition of Done: Ticket approved → Spec complete → Goal complete (bottom-up).

## Ticket state machine

```
backlog ──claim(push)──▶ in_progress ──done──▶ in_review* ──approve──▶ approved
                                              (collab only)    └──reject──▶ rejected
   └──canceled (terminal)                                        rejected ──(ED re-decompose)──▶ new backlog ticket
```

| State | Meaning | Set by |
|---|---|---|
| `backlog` | Not started, claimable | Eng Director (creates ticket) |
| `in_progress` | Claimed, in development | Worker (git claim-lock) |
| `done` | Implementation complete | Worker |
| `in_review` | PR pending review (**collab mode only**) | Worker (after opening PR) |
| `approved` | Review passed (+ merged, collab) | Reviewer |
| `rejected` | Review found issues | Reviewer |
| `canceled` | Abandoned / no longer pursued | Eng Director |

- Single mode: `done` → reviewer reviews directly → `approved`/`rejected` (no `in_review` mid-state).
- `rejected` tickets have no outgoing transition on the same ticket — the fix enters the board as a
  new backlog ticket via re-decompose (small fixes may be handled directly by the user; the
  re-decompose path is for larger issues).
- Claim = git push atomicity (mutual-exclusion lock); `ClaimConflictError` backs the losing worker off.

## Spec state machine (T2 final — simplified)

```
backlog ──(first ticket claimed, auto)──▶ in_progress ──▶ done ──▶ in_review ──▶ approved / rejected
   ▲                                                                    └── rejected → backlog | in_progress (re-decompose)
   └── canceled (terminal)
```

| State | Meaning | Set by |
|---|---|---|
| `backlog` | Spec defined, tickets not started | Eng Director |
| `in_progress` | Tickets in development; **auto-advances from backlog when the FIRST ticket is claimed** | auto (first ticket claim) |
| `done` | Tickets complete + reviewed | Reviewer / Eng Director (review) |
| `in_review` | Submitted for acceptance | Eng Director |
| `approved` | Accepted | Reviewer |
| `rejected` | Not accepted → re-decompose | Reviewer |
| `canceled` | Terminal / abandoned | Eng Director |

T2 rules (G4.S6.T2 — the simplified, final spec lifecycle):

- **No `decomposed` state** — removed. The lifecycle is ticket-driven: the Spec auto-advances
  `backlog → in_progress` when its first ticket is claimed; there is no manual intermediate step.
- **`done` is NOT auto**: when all tickets are done the Spec stays `in_progress` awaiting **review**
  (the reviewer may add new tickets). `done` is reached only via review.
- **Workers never change a Spec status** — they only change their own ticket. The Eng Director (plan
  agent) drives start/report/re-decompose; the Reviewer approves/rejects.
- **Legacy `active`** maps to `in_progress` (backward compat).
- **GitHub sync**: the Spec main issue's open/closed mirrors the md Spec status — `done`/`approved`/
  `canceled` → closed; `backlog`/`in_progress`/`in_review`/`rejected` → open (so the Project Status
  column and the issue-list open/closed agree).

## Roles (the six souls)

Responsibility model, not strict role-play (real value only when roles are spread across distinct
agents; solo/small teams just swap prompts).

| Role | Duty | Stage | Builds |
|---|---|---|---|
| **Consultant** | grill requirements into a Goal | pre-plan | `Goal.md` |
| **PM** | to-spec: decompose the Goal into Specs | planning | `Spec.md` |
| **Eng Director** | to-ticket: decompose specs into tickets; re-decompose rejected tickets; dispatch workers | planning, rework | `T{n}.md` tickets + rework tickets |
| **Worker** | claim a ticket (git), implement, report done/in_review | execution | implementation + status report |
| **Reviewer** | review done/in_review tickets; approve or reject with qa_feedback | review | verdict (approved / rejected) |
| **Writer** | project report / summary at completion (only) | wrap-up | docs + PR description |

Layer → planner owner: **Goal = Consultant**, **Spec = PM**, **Ticket = Eng Director**.

## Progress Log

The `## Progress Log` table at the bottom of each ticket md file — the real-time progress + stalled
signal (design.md §10).

| Column | Meaning |
|---|---|
| `UTC timestamp` | REAL wall-clock UTC time (ISO-8601), stamped by the plugin — never LLM-fabricated |
| `status` | mirrors the ticket state machine |
| `progress` | one line: what the worker is doing |

- Written by the opencode plugin (`tool.execute.after`): one row per tool call, rate-limited
  (~1 row / 30 s) + callID-deduped. The worker occasionally adds a **semantic milestone** line
  ("implemented the shared repo selector").
- **Stalled signal**: a stale last-row timestamp (no row for ~3 min) means the worker is stalled —
  the Eng Director wakes it or restarts + re-dispatches.
- Retention: the full log is kept (history audit / worker takeover / crash recovery).
- **md-only**: the Progress Log is never pushed to GitHub (sub-issues carry description/status/
  assignee/blocked_by only).
- The `## Log` section is the LLM-written lifecycle audit (claim/complete/review events), distinct
  from the plugin-written Progress Log.

## Glossary

| Term | Meaning |
|---|---|
| **GDD** | Git-Driven Development — the generic, agent-agnostic dev-flow protocol (this handbook) |
| **Board** | The `docs/kanban/` tree + its GitHub Project v2 projection |
| **GST** | Goal / Spec / Ticket templates (`gdd/templates/` → `docs/kanban/templates/`) |
| **Ref** | The `Gx` / `Gx.Sy` / `Gx.Sy.Tz` identifier |
| **Claim lock** | Git push atomicity as mutual exclusion — the first push wins the ticket |
| **Sync** | md → GitHub projection (CLI / hook / auto-sync plugin) and GitHub → md feedback (`pull`) |
| **Feedback loop** | GitHub issue comments read back into DRAFT md proposals (`sync-github feedback`) |
| **sync-state.json** | `docs/kanban/Gx/Sy/sync-state.json` — per-spec seen-comment-id tracking |
| **Kanban status** | a `TicketStatus` / `SpecStatus` value from the schema |
| **Status column** | the GitHub Project v2 Status single-select option a card maps to |
| **Dispatch** | the Eng Director telling a Worker which ticket to take (structured prompt: `TICKET:`/`PATH:`) |
| **Stalled** | worker not progressing (Progress Log timestamp stale) — an ED observation, not a status |
| **Single mode** | solo/small team, direct master, no PR / no `in_review` |
| **Collab mode** | multi-person, fork + branch + PR, `in_review` used, Issues as discussion surface |
| **done-commit** | (removed in G4.S6.T4) completion commits stay with the worker; no separate index commit |
| **local board stack** | (removed in G4.S6.T4) kanban-index/scan/local Kanban tab; the GitHub Project panel is the only board view |
| **athena** | the KB/chat product — an OPTIONAL GitHub-project viewer; the boundary is ADR 0009 |
| **Credential** | the LOCAL GitHub token (`gh auth token` → `GITHUB_TOKEN`) the gdd package uses; the athena employee store is only an optional in-athena fallback |
