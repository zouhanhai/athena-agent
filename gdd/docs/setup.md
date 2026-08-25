# GDD Setup — enable Git-Driven Development on a new project

This guide enables GDD on **any** project repo, standalone on your own machine — no athena server, no
database, no employee store. The only external dependency is a GitHub token for the md → GitHub sync.

The `gdd/` package ships everything: GST templates, the sync-github CLI, the md → GitHub git hook,
and the opencode plugins. You copy templates, install the hook, sync specs, and deploy the plugins —
then your agents drive the kanban.

## Prerequisites

- **Node 24+** (the `gdd` package and its CLI run on tsx).
- **git** with a remote on **github.com** (the sync derives `owner/repo` from the `origin` remote, or
  from `GITHUB_OWNER` / `GITHUB_REPO` env).
- **The `gdd/` package** in your repo (this repo already has it; for a fresh project copy it in, or
  reference it from this repo).
- **(Recommended) the `gh` CLI** — the sync uses `gh auth token` first. No `gh`? Set `GITHUB_TOKEN`.
- **(Recommended) opencode** — to get the auto-claim / progress-log / auto-sync plugins.

> The `gdd` package has its own `node_modules` and test suite. After copying it in, run
> `cd gdd && npm install` once so the CLI and plugin tests work.

## Credential: LOCAL token first

GDD runs on **your** machine, so its GitHub credential is resolved **locally**, in this order
(`gdd/src/credential.ts`):

1. An explicit `--token <TOKEN>` (CLI / plugin option).
2. `gh auth token` — the token of your logged-in `gh` CLI (`gh auth login`, hosts.yml).
3. `GITHUB_TOKEN` env var.
4. The **athena employee store** — ONLY as an optional last-resort fallback, and only when running
   inside athena (`DATABASE_URL` set). A standalone GDD setup never touches it.

**Verify the credential resolves** before syncing:

```bash
gh auth status          # "Logged in to github.com" — the CLI can return a token
# or
gh auth token           # prints a token (use carefully; do not commit it)
```

If you are not using `gh`, export the token for your shell (or put it in `.env` that your agent
loads):

```bash
export GITHUB_TOKEN=github_pat_xxx
```

If neither is set, `sync-github` fails with a clear message pointing at these two options — it never
falls back to athena's employee store on a standalone machine.

## Step 1 — Copy the GST templates into `docs/kanban/templates/`

```bash
mkdir -p docs/kanban/templates
cp gdd/templates/*.template docs/kanban/templates/
ls docs/kanban/templates/
# Goal.md.template  Spec.md.template  Ticket.md.template
```

**Verify:** the three template files are present. These are the canonical Goal / Spec / Ticket
structures ([`design.md`](design.md) §6). The `gdd/templates/` copies are the package's canonical
sources; copy them into each new repo.

## Step 2 — Create the first board content

Create a Goal, then specs and tickets under it. You can write them by hand following the templates,
or have your planning agent (Eng Director) create them. The directory layout:

```
docs/kanban/
├── templates/          ← the templates from step 1
├── G1/
│   ├── Goal.md         ← layer G: the goal (owner: consultant)
│   └── S1/
│       ├── Spec.md     ← layer S: the spec (owner: pm)
│       ├── T1.md       ← layer T: a ticket (owner: eng-director)
│       └── T2.md
```

**Verify:** each file parses as valid frontmatter with the right `id`/`layer`/`parent` fields (see
[`reference.md`](reference.md) for the schema). Commit them:

```bash
git add docs/kanban && git commit -m "docs(kanban): bootstrap G1/S1 with Goal, Spec, tickets"
```

> Tickets start `status: backlog`. They are claimed by workers (or by the opencode plugin
> automatically) via the git claim-lock — never edit `status`/`assignee`/`session_id` by hand once
> workers are running.

## Step 3 — Install the md → GitHub auto-sync git hook

The `post-commit` hook (`gdd/hooks/post-commit`) detects new/modified `docs/kanban/**` files in a
commit and runs `sync-github create <spec>` for each affected spec, so new tickets get their GitHub
Issues immediately. It is **best-effort** — a sync failure never blocks the commit (logged to
`~/.athena-tmp/kanban-hook.log`).

```bash
bash gdd/hooks/install-kanban-hook.sh
```

The installer sets `git config core.hooksPath gdd/hooks` (relative, so it survives clones) and makes
the hook executable.

**Verify:**

```bash
git config core.hooksPath        # → gdd/hooks
ls -l gdd/hooks/post-commit      # → executable
```

Then commit a change to a board file and check the log:

```bash
git add docs/kanban/G1/S1/T2.md && git commit -m "docs(kanban): T2 done"
cat ~/.athena-tmp/kanban-hook.log   # → "kanban-hook: sync G1.S1 (<owner>/<repo>)"
```

> The hook derives `owner/repo` from the repo's **primary remote** (`caleo` preferred, then `origin`) —
> supporting both HTTPS and SSH github.com URLs. If owner/repo cannot be derived from any remote, the
> hook logs a skip message to the log file and exits without syncing.

## Split deployment — plan agent and worker on different machines

The standard topology is one machine / one clone: Hermes (planning) and OpenCode (worker) share the
repo, so commits, hooks and credentials are all local. GDD also works **split** (plan agent on
machine A, worker on machine B), with three rules:

- **Install the post-commit hook in EVERY clone that commits board files** (`bash
  gdd/hooks/install-kanban-hook.sh` per clone). A clone without the hook silently produces no sync.
- **Every machine that should SYNC needs its own local credential.** Preferred: `gh auth login`
  (or `GITHUB_TOKEN`). Inside-athena machines may instead provide `DATABASE_URL` (+ optional
  `GITHUB_EMPLOYEE`) via **`gdd/hooks/sync.env`** (gitignored — never commit tokens); the shipped
  hook contains no credentials.
- **Dispatch goes over the network**: point the dispatch flow at the worker's `opencode serve`
  endpoint (SSH or tunnel) instead of localhost. Keep helper scripts (e.g. `monitor-ticket.sh`)
  in the repo's `scripts/` so every clone carries them.

## Step 4 — Run `sync-github` to project the board onto GitHub

The CLI pushes your local md kanban (source of truth) onto a GitHub **Project v2** board: Spec →
main Issue, Ticket → sub-issue, status → Status column, `blocked_by` → issue dependencies, Goal →
milestone + label. Idempotent — issues are matched by title and updated in place, never duplicated.

```bash
# From anywhere in the repo (the bin wrapper resolves tsx from gdd's own node_modules):
gdd/bin/sync-github create G1.S1 --owner <owner> --repo <repo>

# Or via the gdd package's npm script (from inside gdd/):
cd gdd
npm run sync:github -- create G1.S1 --owner <owner> --repo <repo>
```

`owner`/`repo` come from `--owner`/`--repo` flags, else `GITHUB_OWNER`/`GITHUB_REPO` env. The Project
board title defaults to `owner/repo` (override with `--project <title>`).

**Verify** — you should see output like:

```
created G1.S1 <title> #12 on project "owner/repo"
  G1.S1.T1 → #13 (created)
  G1.S1.T2 → #14 (created)
```

and the GitHub Project board now shows the Spec card + ticket sub-issue cards (backlog in "Backlog").
Run it again and it says `updated … ` instead of creating duplicates (idempotent).

### Other CLI commands

| Command | What it does |
|---|---|
| `sync-github create <spec>` | Create/update the Spec main issue + ticket sub-issues + status columns |
| `sync-github sync <spec>` | Re-sync an existing spec (update issue bodies/status/deps) |
| `sync-github status <ticket> <column>` | Set a ticket's md status + move its card |
| `sync-github pull <spec>` | Pull GitHub Status column changes back into md |
| `sync-github feedback <spec> [--plan-input F] [--mark-seen]` | Read new issue comments into draft md proposals |
| `sync-github list` | List the Project board cards |

See [`backend.md`](backend.md) for the full CLI reference and module docs.

## Step 5 — Deploy the opencode plugins

The opencode worker plugins automate the per-ticket mechanics: **auto-claim** (git claim-lock on the
first tool call), **progress-log** (append Progress Log rows with real timestamps), and **auto-sync**
(md → GitHub sync when a ticket is marked done). They load from `.opencode/plugins/` (project) or
`~/.config/opencode/plugins/` (global). The recommended pattern is a **thin wrapper** file that
imports the core by absolute path (`gdd/plugin/src/index.js`), so fixes land in one place:

```bash
# project-scoped
mkdir -p .opencode/plugins
cat > .opencode/plugins/athena-worker.ts <<'EOF'
const CORE = "/abs/path/to/this/repo/gdd/plugin/src/index.js";
export default {
  id: "athena.worker",
  server: async (ctx, options = {}) => {
    const mod = await import(CORE);
    return mod.createWorkerHooks(ctx, options);
  },
};
EOF
```

**Global** (every project on the machine): copy the same wrapper to `~/.config/opencode/plugins/`.
See [`plugins.md`](plugins.md) for both patterns (thin wrapper vs full copy).

**Verify:** restart `opencode serve`, dispatch a worker on a backlog ticket, and watch the ticket
file: the plugin claims it on the first tool call (`status: in_progress` + `assignee` + `session_id`,
pushed as one claim commit) and appends Progress Log rows as tools run. A second worker dispatched on
the same ticket gets a `ClaimConflictError` and backs off.

## Step 6 — Optional: athena as a viewer

If you also run athena, its Workbench **Project** tab shows the same GitHub Project v2 board (generic
GitHub viewing, GDD not required). GDD itself never depends on athena; this is purely a visual layer.
See [ADR 0009](adr/0009-gdd-vs-athena-boundary.md).

## Recap / checklist

- [ ] `docs/kanban/templates/` has the three GST templates
- [ ] `docs/kanban/G1/…` Goal + Spec + backlog tickets exist and are committed
- [ ] `git config core.hooksPath` → `gdd/hooks`; hook log shows a successful sync
- [ ] `gdd/bin/sync-github create G1.S1 --owner … --repo …` created the issues/cards
- [ ] `gh auth status` (or `GITHUB_TOKEN`) present — the sync credential resolves locally
- [ ] opencode plugins deployed (project or global) and a worker auto-claims a ticket
- [ ] `cd gdd && npm test` green (199 tests) — the package is healthy on your machine
