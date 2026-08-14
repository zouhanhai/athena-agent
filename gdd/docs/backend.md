# GDD Backend — the `gdd/` package modules + `sync-github` CLI

The separated, independently-runnable **`gdd/` package** (G4.S6.T3) is the runnable core of GDD. It
runs standalone on the user's local machine: no athena server, no database, no employee store. The
only external dependency is a **local GitHub token** (`gh auth token` → `GITHUB_TOKEN`).

```
gdd/
├── bin/sync-github          # CLI wrapper — runs from any cwd
├── hooks/                   # install-kanban-hook.sh + post-commit (md → GitHub auto-sync)
├── plugin/                  # the opencode worker plugins (auto-claim / progress-log / auto-sync)
├── templates/               # Goal / Spec / Ticket .md.template (GST)
├── src/
│   ├── credential.ts        # LOCAL-token-first credential resolution
│   ├── athena-employee.ts   # optional athena employee-store fallback (in-athena only)
│   ├── index.ts             # public barrel export
│   ├── sync-github.ts       # the sync-github CLI entry point
│   ├── github/              # self-contained GitHub API client (client.ts, types.ts)
│   └── kanban/              # the protocol/sync modules (see below)
├── test/                    # 199 node:test tests
├── package.json             # scripts: test / typecheck / sync:github
└── tsconfig.json
```

## Running the package

```bash
cd gdd && npm install          # once, per clone
npm test                       # 199 protocol/sync tests (node --import tsx --test)
npm run typecheck              # tsc --noEmit
npm run sync:github -- <cmd> … # the CLI via npm script (needs --owner/--repo)
```

or the bin wrapper from anywhere in the repo:

```bash
gdd/bin/sync-github create G1.S1 --owner <owner> --repo <repo>
```

The bin wrapper resolves `tsx` from `gdd/`'s own `node_modules`, so the CLI works from any cwd.

## Credential (`src/credential.ts`)

Local-token-first credential resolution, so the package runs standalone:

1. explicit `token` override (CLI `--token` / plugin option)
2. `gh auth token` — the gh CLI's authenticated token (`gh auth login`, hosts.yml)
3. `GITHUB_TOKEN` env
4. the **athena employee store** — only as an injected optional fallback
   (`src/athena-employee.ts`), used solely when running inside athena (`DATABASE_URL` set)

Key API: `resolveGithubCredential({ token?, ghToken?, ghEnabled?, employeeReader? })` →
`{ type: "token", value, source }` where `source` is `"env"` | `"gh"` | `"athena-employee"`.

## Optional athena fallback (`src/athena-employee.ts`)

Keeps GDD statically decoupled from athena. `athenaEmployeeReader()` lazily dynamic-imports athena's
employee module (`server/src/employees/…`) and returns a reader that resolves a stored credential via
athena's Postgres employee registry — **only** when `DATABASE_URL` is set and the import resolves. On a
fresh machine (no athena code / DB) it returns `undefined` and GDD never touches the employee store.

## GitHub client (`src/github/`)

- **`github/client.ts`** — `GithubClient`, a self-contained GitHub API client (Projects v2 / GraphQL
  for project items, status fields, dependencies; REST for issues/milestones/labels). Throws
  `GithubAuthError` (bad token) and `GithubCredentialUnsupportedError`. No athena dependency.
- **`github/types.ts`** — shared GitHub API types (`GithubCredential`, `GithubProject`,
  `GithubIssue`, `GithubProjectItem`, `GithubIssueComment`, …).

## Kanban protocol/sync modules (`src/kanban/`)

### Board model

| Module | What it does |
|---|---|
| **`board.ts`** | Ref/path helpers + read/write for the kanban md files. `parseRef` splits `G3.S6.T1` → `{g,s,t}`; `refToPath` maps a ref to `docs/kanban/Gx/Sy/Tx.md`; `readBoardFile`/`writeBoardFile`/`writeTicketFile` parse+render md. |
| **`scan.ts`** | `scanBoard(boardRoot)` walks `docs/kanban/*.md` and builds the typed board tree `Goals → Specs → Tickets` (each node with parsed frontmatter + status; optionally the body). `defaultBoardRoot()` locates `docs/kanban` from cwd. |
| **`schema.ts`** | The G.S.T schema: three `LAYERS` (G/S/T), `TICKET_STATUSES` (backlog → in_progress → done → in_review → approved/rejected/canceled), `SPEC_STATUSES` (backlog → in_progress → done → in_review → approved/rejected/canceled; **`decomposed` removed**, legacy `active` maps to `in_progress`), plus typed parse/validate (`parseGoal`/`parseSpec`/`parseTicket`, `BoardSchemaError`). |
| **`frontmatter.ts`** | A minimal YAML-subset frontmatter parser/renderer (scalars, inline arrays, block lists) — no full YAML dependency. `parseFrontmatter`/`renderFrontmatter`, `parseBoardMd`/`renderBoardMd`. |

### State machines

| Module | What it does |
|---|---|
| **`state-machine.ts`** | The two state machines + named transitions + actor mapping. `STATE_MACHINE` (ticket: backlog→in_progress→done→in_review→approved, or →rejected/canceled), `SPEC_STATE_MACHINE` (spec: backlog→in_progress→done→in_review→approved/rejected; rejected→backlog/in_progress). `canTransition`/`transitionsFrom`/`transitionsTo`/`transitionId`/`specTransitionId`/`actorFor`, with `TRANSITION_ACTOR` (worker claims/reports, reviewer approves/rejects) and `SPEC_TRANSITION_ACTOR` (eng-director starts/reports/re-decomposes, reviewer approves/rejects). |
| **`status-map.ts`** | md status ↔ GitHub Project v2 Status option names. `kanbanStatusToProjectStatus`, `projectStatusToKanbanStatus`, `kanbanSpecStatusToProjectStatus` (Specs map to a coarser lifecycle; legacy `active` ≡ `in_progress`). |

### Worker protocol

| Module | What it does |
|---|---|
| **`protocol.ts`** | The md-level worker protocol: `claimTicket` (sets status/assignee/session_id, auto-advances the parent Spec `backlog → in_progress` on the first claim), `reportTicket` (done/in_review + PR), `claimableTickets`/`dispatchNext` (YOLO dispatch), `dispatchNotice` (structured dispatch prompt), `appendLog`. Throws `ClaimError`/`ReportError`. Mutates md only — the git push lock lives in `git-lock.ts`. |
| **`git-lock.ts`** | `GitClaimLock` — the **git claim-lock**: wraps the md-level claim/report with add → commit → push. A rejected push (non-fast-forward) means another worker won the race: resync to the remote, re-read the ticket, re-claim if still claimable or throw `ClaimConflictError`. |
| **`lifecycle.ts`** | Review + rework: `approveTicket`, `rejectTicket` (records qa_feedback), `reDecompose` (rejected ticket → a new backlog ticket linked via parent_id/qa_feedback/reopen_reason). Throws `LifecycleError`. |
| **`roles.ts`** | The six soul roles — Consultant / PM / Eng Director / Worker / Reviewer / Writer — each with duty, lifecycle stage and output (`ROLES`, `roleSoul`, `PLANNING_OWNER`). Responsibility model, not strict role-play (design.md §16). |
| **`progress.ts`** | `parseProgressLog(body)` — reads the **last** data row of a ticket's `## Progress Log` table → `{ progress_updated_at, status, progress_last_row }` (the stalled-detection signal). |

### md → GitHub sync

| Module | What it does |
|---|---|
| **`github-sync.ts`** | The **md → GitHub projection** (the GDD-owned sync half; the read half lives in athena's `server/src/github/project-board.ts`). `createSpecIssue` creates/updates the Spec main Issue (`Gx.Sy <title>`, body = spec description + `## Sub-tasks` checklist + board-file link) + each Ticket sub-issue (`Gx.Sy.Tz <title>`, body = status/assignee/blocked_by + description, **Progress Log stripped**), applies the Goal milestone/label, syncs the Spec card's Status column to the md Spec status, each ticket card to its own Status column, and `blocked_by` → issue dependencies. Also: `buildIssueForSpec`/`buildIssueForTicket`/`findSpecInBoard`/`findExistingTicketIssue`/`stripRefPrefix`/`stripProgressLog`/`specIssueTitle`/`specIssueState`/`ticketState`/`statusToColumn`/`blockedByToDeps`/`goalToMilestoneAndLabel`/`syncSpecStatus`/`syncTicketStatus`/`syncBlockedBy`/`statusFieldOptions`. Spec main-issue open/closed mirrors the Spec status (done/approved/canceled → closed). |
| **`github-feedback.ts`** | The **GitHub → md feedback loop**. `pullProjectStatusChanges` reads a Project's cards and writes user-confirmed GitHub Status changes back into md (every change recorded with a `## GitHub sync` origin note; ambiguous cases surface as `conflicts`, never silently overwrite). Comment dedup (`dedupeComments`/`markCommentsSeen`) tracks seen comment ids in `docs/kanban/Gx/Sy/sync-state.json`. Plan-agent reconcile path: `readFeedbackContext` bundles new comments + current md state; `buildPlanDraft`/`buildTicketDraft`/`buildSpecDraft`/`buildEditDraft`/`buildFeedbackProposal` build **DRAFT** md updates (human approves, then `applyFeedbackDraft`). |
| **`status-map.ts`** | (see above) — the status-name mapping used by both sync directions. |

## The `sync-github` CLI (`src/sync-github.ts`)

Entry: `gdd/bin/sync-github <command> [args] [--owner O --repo R --project P --token T --board-root PATH]`

| Command | Arguments | What it does |
|---|---|---|
| `create` | `<specRef>` | Create/update the Spec main Issue + ticket sub-issues on the Project board (idempotent; resolves the Project by title, creates if missing). |
| `sync` | `<specRef>` | Re-sync an existing spec: update the Spec issue body/status, each ticket sub-issue body/status, Status columns, and blocked_by dependencies. |
| `status` | `<ticketRef> <column>` | Set a ticket's md status (validated against `TICKET_STATUSES`) and move its GitHub card to the matching Status column. |
| `pull` | `<specRef>` | Pull user-confirmed GitHub Status column changes back into md (`github-feedback.ts`). Prints applied/conflicts/unchanged. |
| `feedback` | `<specRef> [--plan-input F] [--mark-seen]` | Read new issue comments into a DRAFT md proposal (via `--plan-input` PlanInput JSON) or acknowledge them (`--mark-seen`). Never applies silently. |
| `list` | — | List the Project board's cards (issue number, title, status). |

Common flags: `--owner`, `--repo` (or `GITHUB_OWNER`/`GITHUB_REPO` env), `--project <title>`
(or `GITHUB_PROJECT`), `--token` (explicit credential override), `--board-root <path>`.

The credential is resolved **local-token-first** (`--token` → `gh auth token` → `GITHUB_TOKEN` → the
optional athena employee store when running inside athena). The Progress Log is never pushed — GitHub
sub-issues carry the description/status/assignee/blocked_by only.

## Git hooks (`gdd/hooks/`)

- **`install-kanban-hook.sh`** — installs the md → GitHub auto-sync hook on a repo: sets
  `git config core.hooksPath gdd/hooks` (relative, clone-safe), makes `post-commit` executable,
  prints verification.
- **`post-commit`** — on commits touching `docs/kanban/**` Goal/Spec/Ticket files, runs
  `sync-github create <spec>` for each affected spec (best-effort; logs to
  `~/.athena-tmp/kanban-hook.log`, never blocks the commit). Derives owner/repo from the primary
  remote (`caleo` → `origin`), HTTPS or SSH. Uses the local credential like the CLI.

## Dependencies

- Runtime: Node 24+; dev: `tsx`, `typescript`, `@types/node` (all in `gdd/`'s own `node_modules`).
- GitHub access: a **local token** (`gh auth token` / `GITHUB_TOKEN`). The athena employee store is an
  optional fallback **only** when running inside athena — a standalone setup never needs it.
- **No athena dependency**: the package never statically imports athena server code, and the shared
  `github-sync` was split (G4.S6.T3) so GDD owns the sync half while athena owns the read half
  (`server/src/github/project-board.ts` → the Workbench Project view).
