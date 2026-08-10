# athena-agent — Git-Driven Collaborative Kanban Design

> Core design: 3 employees + 3 Pis operate on the same git repo, coordinating "who should do what, and what to continue" via markdown file state in GitHub + git commit history.
> This is a pure git + markdown model (no local SQLite source of truth).

## 1. Core Principles

1. **Markdown is the sole source of truth** — `docs/kanban/*.md` stores all task state
2. **Git is the coordination mechanism** — commit history = activity log, push conflicts = mutual exclusion lock
3. **GitHub is the shared hub** — 3 employees + 3 Pis all push/pull the same repo
4. **Each person has an independent git identity** — git commits distinguish who performed the operation

## 2. Directory Structure = Gx.Sx.Tx Three Layers

```
docs/kanban/
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

### Naming Convention (Plan B: Directory Hierarchy + Frontmatter Numbering)

**File names are fixed; distinction comes from directory hierarchy**:

| Layer  | Directory       | File       | Where numbering lives |
|--------|-----------------|------------|-----------------------|
| Goal   | `G1/`, `G2/`... | `Goal.md`  | Directory name G1/G2  |
| Spec   | `S1/`, `S2/`... | `Spec.md`  | Subdirectory name S1/S2 |
| Ticket | Same spec dir   | `T1.md`, `T2.md` | Filename T1/T2 |

**Uniqueness via path, display via frontmatter**:
- Full identifier = path (`G1/S1/T1` is naturally unique)
- Display name = `title` in frontmatter: `"G1.S1.T1: ..."`
- `T1.md` under different specs have different paths (`G1/S1/T1` vs `G1/S2/T1`), no conflict

**Example**:
```
G1/S1/T1.md  → title: "G1.S1.T1: Implement login API"
G1/S2/T1.md  → title: "G1.S2.T1: Implement order API"  (same filename, distinguished by path)
```

## 3. G Number Assignment (Globally Incrementing, Git Atomic)

```
Any Pi launching a new Goal:
  1. git pull (sync latest)
  2. Scan docs/kanban/ to find current max G number (max G folder name)
  3. New G = max + 1 (e.g. current max is G5 → create G6)
  4. Create G<N>/ folder + Goal.md (owner = launching Pi)
  5. git commit + push
  6. If push conflict (someone else simultaneously created G6) → pull → recalculate (G7) → retry
```

**Uniqueness guarantee**: git push atomicity — two Pis simultaneously creating G6: only one push succeeds, the other retries with G7 after conflict.

## 4. Ticket Claim Lock (Worker Claim)

```
Any Worker claiming a ticket:
  1. git pull (latest board)
  2. Select ticket: status = backlog AND assignee = empty/self
     (Note: rejected tickets cannot be directly claimed — must first notify Eng Director to regenerate)
  3. Modify T1.md frontmatter:
     status: in_progress
     assignee: pi-a
     session_id: ses_xxxxxxxx   # OpenCode serve session handling this ticket (parallel workers)
     started_at: <timestamp>
  4. git commit -m "claim G1.S1.T1 (in_progress)" + push
  5. Push succeeds → locked, begin development
  6. Push conflicts → pull → see status already changed → give up, pick next
```

**Mutual exclusion guarantee**: git push atomicity — only the first successful push gets the ticket.

## 5. Ticket Markdown Format

```markdown
---
id: t_abc123
title: "G1.S1.T1: Implement login API"
layer: T
parent: G1.S1
owner: pi-a
status: in_progress        # backlog → in_progress → done → in_review → approved / rejected
assignee: pi-a
started_at: 2026-08-04
blocked_by: []
acceptance_criteria:
  - "POST /api/login returns 200"
pr: 0                       # GitHub PR number
branch: ""                  # feat/t1-login-api
---

## Task
Implementation details...

## Log
[2026-08-04] pi-a claimed and started
[2026-08-04] pi-a completed implementation
```

## 5bis. Three-Layer Definition of Done

Each layer must have a clear "what counts as done"; otherwise progress cannot be aligned or completion judged.

```
Milestone (M1-M5)  → acceptance criteria (project phase completion conditions)
  └─ Goal (G1-G5)  → acceptance criteria (top-level task completion conditions)
      └─ Spec (G1.S1) → acceptance criteria (feature container completion conditions)
          └─ Ticket (T1-TX) → acceptance_criteria ✅ already present
```

### Ticket Layer (existing)
- Frontmatter `acceptance_criteria` (e.g. "GET /api returns 200")
- Worker implements, Reviewer verifies against these

### Spec Layer
- Spec.md describes what "this feature container is complete" means
- Criterion: all Tickets under it are approved

### Goal Layer
- Goal.md contains `acceptance_criteria` (top-level task completion conditions)
- Criterion: all Specs under it are complete + overall goal achieved

### Milestone Layer
- Project README lists acceptance criteria for each Milestone
- Criterion: corresponding Goals are all complete

### Judgment Logic (Bottom-Up)

```
Ticket approved → Spec complete → Goal complete → Milestone complete
```

Each layer's `acceptance_criteria` defines "what must be achieved for this layer to be done."

## 6. State Machine

```
backlog ──claim(push)──▶ in_progress ──implementation done──▶ done
   ▲                        │                      │
   │                        │                      ├─ open PR → in_review
   │                        │                      │
   └──── reject ◀───────────┴──────────────────────┴→ approved (PR merged)
```

| State       | Meaning                    | Set by        |
|-------------|----------------------------|---------------|
| backlog     | Not started, claimable     | Planner       |
| in_progress | Claimed, in development    | Worker (claim lock) |
| done        | Implementation complete    | Worker        |
| in_review   | PR pending review          | Worker (after opening PR) |
| approved    | Review passed + merged     | Reviewer      |
| rejected    | Review found issues        | Reviewer      |

## 7. PR/Merge Integration

```
T1 done (branch feat/t1-login-api):
  → Open GitHub PR → update ticket: status=in_review, pr=<number>, branch=<name>
  → Reviewer reviews
  → Pass → merge → ticket: status=approved
  → Reject → PR updated → re-review
```

Automation option: GitHub Actions / webhook detect PR status → auto-update md frontmatter.

## 8. Multi-Person Collaboration Flow (Who Does What at Which Stage)

```
Goal launch (multiple Pis each launch, numbering increments):
  Pi-A launches G1, Pi-B launches G2, Pi-C launches G3

Single Goal lifecycle:
  First 3 stages (launching Pi plays multiple roles solo, not delegated to others):
    Consultant → PM → Eng Director
    (Same Pi plays all, producing Goal.md + specs + tickets)

  Worker stage (multi-person collaboration begins):
    Pi-A claims T1, Pi-B claims T2, Pi-C claims T3 (git claim lock)
    Coordinate division of work via team channel (pi-intercom)

  Review stage (another Pi):
    Pi-B reviews Pi-A's T1 → approve/reject
```

## 9. Inter-Pi Communication (Team Channel)

Use **pi-intercom** (installed) for inter-Pi-session coordination:
```
Pi-A → Pi-B: "Can you help with T2?"
Pi-B → Pi-A: "Sure, I'll claim it"
```

- Team conversation = real-time negotiation (who helps whom, who does what)
- Git board = persistent record (claim results written to md after negotiation)

## 9bis. Document Hierarchy (grill → spec input chain)

```
Project root CONTEXT.md (global glossary)     ← whole-project ubiquitous language
   ✗ NOT used as to-spec input (terminology, not a Goal objective)

G1/Goal.md (grill output)                     ← IS to-spec input!
   ✓ Describes G1 objective/context/decisions
   ✓ PM reads it → to-spec → G1/S1/Spec.md

Flow:
  grill G1 → G1/Goal.md (grill output; not named CONTEXT.md to avoid confusion with project root glossary)
    → PM reads G1/Goal.md → to-spec → G1.S1 spec
    → Eng Director reads spec → to-tickets → G1.S1.T1-TX
```

**Key points**:
- **Project root CONTEXT.md** = glossary; if grill surfaces new global terms they may be added, **NOT used as to-spec input**
- **G1/Goal.md** = grill output (the goal document produced by grill), **IS the input to to-spec**
- **ADR library** (`docs/adr/`) accumulates across Goals; each grill may add new entries (only when all three conditions are met)

## 10. "Who Should Do What, What to Continue" Judgment Logic

```
Each employee/Pi on startup:
  git pull → read all T-layer md
  status=backlog + assignee=empty → candidate for claiming
  status=in_progress + assignee=me → I continue working on it
  status=done + has PR → awaiting review
  status=in_review + I am reviewer → I review
  blocked_by not done → waiting on dependency
```

## 11. Reject Flow (Reviewer Rejects → Eng Director Regenerates)

```
Reviewer (Pi-B) reviews Pi-A's T1 → finds issues:
  1. T1 marked rejected (history preserved, original ticket unchanged; qa_feedback records comments)
  2. Notify Eng Director (the Pi that launched this G)
  3. Eng Director analyzes qa_feedback → re-decomposes → creates new ticket(s)
     ├─ Minor rework → T1.1 (parent_id=T1, reopen_reason, qa_feedback)
     └─ Major issue → re-examine spec, may split into multiple new tickets
  4. New ticket enters backlog, awaits Worker claim (claim lock)
```

**Key rules**:
- **New tickets are generated by the Eng Director** (the Pi that launched the G), not the Reviewer
- **Original ticket marked rejected is preserved**, not modified (history is not lost)
- New ticket carries `parent_id` linking to old ticket + `qa_feedback` + `reopen_reason`
- Any Worker can claim the new ticket (keeping collaboration open), but the source is annotated

**Rationale**: The Eng Director (planner) best understands the spec holistically; review findings often mean the decomposition itself needs re-examination, not just simple rework. Planning authority is centralized with the planner.

## 12. Exception Handling

- **Worker crash leaves ticket stuck in_progress**: check git log timestamps; if timeout with no update → another Worker can take over (revert to backlog or take over)
- **md conflicts**: different Workers modifying different ticket files won't conflict; two workers racing for the same ticket — the conflict IS the mutual exclusion lock
- **main concurrency**: multiple PRs merging simultaneously may conflict → resolve via rebase

## 13. Eng-Director Ticket Monitoring (auto-wake stalled workers)

OpenCode workers can stall silently (long reasoning loops, session `updated` stops advancing while the
ticket stays `in_progress` — or even `backlog` before claiming). The Eng Director side has an automatic
monitor so you don't poll sessions by hand.

**Two complementary directions**:
- **Eng Director → Worker**: `monitor-ticket.sh` polls a ticket's status + the session's `updated` epoch
  ms; if `in_progress` with no update for > threshold it POSTs a wake message
  (`/session/{sid}/prompt_async`) that breaks the loop, and exits automatically on
  done/approved/failed/rejected. One monitor per ticket, started on dispatch.
- **Worker → Eng Director**: the G4.S4 plugin appends a Progress Log row (real wall-clock timestamp) on
  each tool call, so the Eng Director can read progress from the ticket file.

**Usage** (on 6900XT):
```bash
ssh hh@192.168.178.30 "nohup /home/hh/scripts/monitor-ticket.sh \
  /home/hh/athena-agent/docs/kanban/G4/S1/T6.md <session-id> 60 300 \
  > /tmp/monitor-run.log 2>&1 &"
# args: <ticket-path> <session-id> [interval-secs=60] [stall-threshold-secs=300]
# check: tail -f /tmp/monitor-<spec>-<ticket>.log
```
Script is also saved in the Hermes `monitor-ticket` skill. A worker may stall before claiming (still
`backlog`) — the wake message tells it to claim and proceed.
