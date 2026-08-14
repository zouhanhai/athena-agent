# GDD OpenCode Plugins

The `gdd/plugin/` package contains the **opencode worker plugins** that automate the per-ticket
mechanics of the GDD protocol on the user's local machine: **auto-claim** (git claim-lock on the
first tool call), **progress-log** (append Progress Log rows with real wall-clock timestamps), and
**auto-sync** (md → GitHub sync when a ticket is marked done).

> The done-commit plugin was removed (G4.S6.T4): completion commits stay with the worker (quality
> judgment) and there is no separate index commit — the local board stack that needed it was removed.
> The remaining plugins are auto-claim, progress-log, and auto-sync.

## Package layout

```
gdd/plugin/
├── package.json         # gdd-opencode-plugin; scripts: test / typecheck
├── src/
│   ├── index.ts         # createWorkerHooks + default export { id: "athena.worker", server }
│   ├── claim.ts         # claimTicketWithIndex — auto-claim orchestration
│   ├── progress-log.ts  # ProgressAppender + appendProgressRow
│   ├── auto-sync.ts     # syncSpecOnDone — md → GitHub sync on done
│   └── ticket-ref.ts    # parseTicketRef — extract the ref from the dispatch message
└── test/                # 18 node:test plugin tests (claim/progress-log/auto-sync/ticket-ref/concurrency)
```

Run the plugin tests: `cd gdd/plugin && npm test` (18 tests) or `npm run typecheck`.

## Plugin contract

The plugin is an opencode classic plugin: a default export `{ id, server }`. The hooks types are
declared structurally (no `@opencode-ai/plugin` dependency), keeping the package self-contained and
unit-testable. It is loaded at opencode serve startup from `.opencode/plugins/` (or a global plugin
dir) and is **resident** — shared by all worker sessions, distinguished per worker by `sessionID`.

State that must survive across a session's tool calls lives in module-level maps (`sessions`,
`appenders`), because opencode re-invokes `server()` per event/call.

## The three plugins

### 1. Auto-claim (`tool.execute.before`)

On the first tool call of a session the plugin claims the session's ticket through the git
claim-lock:

- Parses the ticket ref from the **first dispatch message** (`TICKET: G4.S3.T12` /
  `PATH: docs/kanban/G4/S3/T12.md`, see `ticket-ref.ts`).
- Appends the claim row to the ticket's `## Progress Log`, sets
  `status: in_progress` + `assignee` + `session_id`, and does ONE `add → commit → push` via
  `GitClaimLock` — **git push atomicity is the mutual-exclusion lock**.
- Concurrent tool calls in the same tick share one in-flight claim promise, so the claim runs
  **exactly once per session** (no duplicate claim commits).
- On a lost race (`ClaimConflictError` — another worker claimed first), the worker backs off; the
  plugin surfaces the conflict so the session stops.

### 2. Progress-log (`tool.execute.after`)

After each tool call the plugin appends a Progress Log row to the ticket md file:

- Stamped with the **REAL wall-clock UTC timestamp** (never LLM-fabricated — the stale last-row
  timestamp IS the stalled signal).
- Appended only on a real change (a tool ran), **rate-limited** (~1 row / 30 s per ticket) and
  callID-deduped, so one tool call appends at most one row.
- Local writes are NOT committed by the plugin — the git strategy keeps Progress Log rows in md only
  (never pushed to GitHub; the ticket's GitHub sub-issue carries the description/status/assignee,
  not the minute-level log).

### 3. Auto-sync (`session.idle` + `syncSpecOnDone`)

When a worker session goes idle and the claimed ticket is `done`, the plugin runs the md → GitHub
sync for the ticket's parent Spec (`G4.S5.T9` → `G4.S5`), so the GitHub Project board's Status
columns update automatically — no manual `sync-github sync <specRef>` after every done.

- Uses `createSpecIssue` from `gdd/src/kanban/github-sync.ts` (idempotent).
- Owner/repo: explicit options → `GITHUB_OWNER`/`GITHUB_REPO` env → the `origin` remote.
- Credential: **local-token-first** (`resolveGithubCredential` in `gdd/src/credential.ts`): explicit
  token → `gh auth token` → `GITHUB_TOKEN` → the athena employee store only as an optional fallback
  when running inside athena.
- **Best-effort**: a sync failure is logged and never blocks the idling session / done commit.

## Ticket-ref parsing (`ticket-ref.ts`)

`parseTicketRef(text)` extracts a ticket ref from a dispatch message or ticket body. Accepts both the
dot form (`G4.S3.T12`) and the file-path form (`docs/kanban/G4/S3/T12.md`); returns `null` for
Goal/Spec refs. The plugin stores the ref on the first `chat.message` so the claim/progress hooks
know which ticket a session handles.

## Deployment (global vs project)

The plugin is loaded at opencode serve startup from a plugin directory opencode scans. Two patterns:

| Pattern | How | When to use |
|---|---|---|
| **Thin wrapper (used in athena-agent)** | a small `athena-worker.ts` file in the plugin dir that imports the core by **absolute path** (`gdd/plugin/src/index.js`) and delegates to `createWorkerHooks` | core logic lives in one place (the `gdd/` package); fixes land in all projects/serve cwds immediately; the plugin only activates when the repo has a `docs/kanban` board |
| **Full copy** | copy `gdd/plugin/*` into the plugin dir | you want the plugin fully self-contained per project (no absolute-path coupling) |

**Project-scoped** (this repo only):

```bash
mkdir -p .opencode/plugins
cat > .opencode/plugins/athena-worker.ts <<'EOF'
const CORE = "/abs/path/to/athena-agent/gdd/plugin/src/index.js";
export default {
  id: "athena.worker",
  server: async (ctx, options = {}) => {
    const mod = await import(CORE);
    return mod.createWorkerHooks(ctx, options);
  },
};
EOF
```

**Global** (every project on the machine):

```bash
mkdir -p ~/.config/opencode/plugins
cp .opencode/plugins/athena-worker.ts ~/.config/opencode/plugins/
```

> The wrapper's `CORE` import is an **absolute path** — update it for your checkout. The gdd package
> runs its own tests/typecheck (`cd gdd/plugin && npm test`), so a "copy full package" deploy also
> needs `npm install` in the copied dir.

**Verify:** restart `opencode serve`, dispatch a worker on a backlog ticket, and watch the ticket
file: it is claimed on the first tool call (one claim commit pushed) and Progress Log rows appear as
tools run. Dispatch a second worker on the same ticket → it backs off with `ClaimConflictError`.

## Dependencies

- The plugin reuses the gdd package modules (`git-lock.ts`, `github-sync.ts`, `credential.ts`,
  `board.ts`) — no reimplementation.
- Runtime: the plugin package ships `tsx` + `typescript` in its own `node_modules`.
- GitHub access: local token (`gh auth token` / `GITHUB_TOKEN`); the athena employee store is only an
  optional fallback inside athena.
- Other agents implement the same integration points with their own hook systems (see
  [`design.md`](design.md) §18); the protocol is agent-agnostic, the plugin is opencode's automation.
