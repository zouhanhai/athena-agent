# GDD — Git-Driven Development

GDD (git-driven development) is a **generic, agent-agnostic development-flow protocol**: a
three-layer (Goal → Spec → Ticket) kanban whose **single source of truth is markdown files** in
`docs/kanban/`, coordinated through **git** (commit history + push atomicity as the mutual-exclusion
lock) and shared through **GitHub** (Issues + Projects v2 as the remote hub).

It is not a product, not a server, and not tied to any one agent. It is a **workflow contract** that
runs on the **user's local machine**: the user's own planning agent (Eng Director) and code agents
(Workers) create and claim tickets, sync `docs/kanban/*.md` to GitHub, and log progress — using
whichever agent tooling they already have.

> The concrete agent used in this handbook (and throughout the protocol) is **opencode** — the
> opencode plugins in `gdd/plugin/` automate the claim/progress/sync steps. Any agent that can run
> git + edit markdown can participate; see [`design.md` §18](design.md) "Other Agent Onboarding".

## Why GDD?

- **Markdown is the source of truth** — no database, no app server, no special tooling. A board is a
  folder of `.md` files that anyone can read, edit, and diff.
- **Git is the coordination mechanism** — who claimed what is decided by a git push (atomic
  mutual-exclusion), and the commit history is the activity log.
- **GitHub is the shared hub** — remote/collab teams see the same board as Issues + a Project v2
  board; discussion happens in issue comments and flows back into markdown.
- **Agent-agnostic** — the protocol is defined once; each agent implements the integration points
  (hooks/plugins/instructions) with its own tooling.

## GDD vs athena (the boundary)

GDD is **separate from athena**. athena-agent bundles two kinds of capability that must not be
conflated ([ADR 0009](../adr/0009-gdd-vs-athena-boundary.md)):

| Capability | Bucket |
|---|---|
| `docs/kanban/*.md` GST structure + templates | **GDD** |
| md → GitHub sync (`sync-github` CLI, git hook, auto-sync plugin) | **GDD** |
| Ticket/Spec state machines, roles, Progress Log, claim lock | **GDD** |
| opencode plugins (auto-claim / progress-log / auto-sync) | **GDD** |
| Workbench shell + GitHub repo/issue/project viewing | athena (generic) |
| KB, Neo4j RAG, Q&A, chat, terms | athena |

**Boundary rule (ADR 0009): split by development-flow vs knowledge-base.** Whatever serves
*development-task management* is GDD (generic, reusable on any project); whatever serves *KB / Q&A* is
athena (product-specific).

**Where GDD runs:** on the user's own local plan/code agents, operating on `docs/kanban/*.md` in the
repo and syncing to GitHub. **athena is only an OPTIONAL GitHub-project viewer** — its Workbench
"Project" tab shows the repo's GitHub Project v2 board (any repo, GDD not required). GDD never imports
athena's server code; its credential is **local-token-first** (`gh auth token` / `GITHUB_TOKEN`), so
the whole flow works on a fresh machine with no athena server, database, or employee store.

Since G4.S6.T4 the **local Kanban board view is removed** — the **GitHub Project panel is the only
board view**. GDD itself is: **md files (source of truth) + md↔GitHub sync + Progress Log/stalled
(md-level mechanism)**. The local plan agent reads the md Progress Log directly to detect stalled
workers; there is no local board display layer.

## When to use GDD

Use GDD when you want an agent-driven, git-coordinated kanban on **any** repo: goals decomposed into
specs, specs into tickets, tickets claimed/implemented/reviewed by agents or humans, with a GitHub
Project board as the visual surface. It pairs cleanly with athena (KB + dev-flow), but is fully
optional and usable on its own.

## Quick start

```bash
# 1. Copy the GST templates into the repo
mkdir -p docs/kanban/templates
cp gdd/templates/*.template docs/kanban/templates/

# 2. Install the md → GitHub auto-sync git hook (once per clone)
bash gdd/hooks/install-kanban-hook.sh

# 3. Sync a spec to a GitHub Project board (local credential: gh auth token → GITHUB_TOKEN)
gdd/bin/sync-github create G1.S1 --owner <owner> --repo <repo>

# 4. Deploy the opencode plugins so workers auto-claim / log progress / auto-sync
```

Full steps with verification: **[`setup.md`](setup.md)**.

## Handbook index

| Document | What it covers |
|---|---|
| [`README.md`](README.md) | What GDD is, boundary vs athena, when to use, this index |
| [`design.md`](design.md) | The full GDD protocol (§1–§20): principles, structure, claim lock, state machines, roles, Progress Log, sync |
| [`protocol-review.md`](protocol-review.md) | The design decision record (grill) behind the protocol |
| [`setup.md`](setup.md) | Step-by-step: enable GDD on **any new project** (templates, git hook, sync CLI, plugins) |
| [`backend.md`](backend.md) | The `gdd/` package modules + `sync-github` CLI — what each does, how to run |
| [`plugins.md`](plugins.md) | The opencode plugins (auto-claim / progress-log / auto-sync) + deployment |
| [`reference.md`](reference.md) | Concept index: Gx.Sx.Tx, ticket + spec state machines, roles, Progress Log, glossary |
| [`templates/`](templates/) | Ready-to-copy Goal / Spec / Ticket markdown templates |

## The `gdd/` package

All the runnable pieces of GDD live in the **`gdd/` package** (separated from athena in G4.S6.T3),
which runs standalone on the user's machine:

```
gdd/
├── src/
│   ├── credential.ts          # local-token-first credential (gh auth token → GITHUB_TOKEN → optional athena store)
│   ├── athena-employee.ts     # optional athena employee-store fallback (only when running inside athena)
│   ├── github/                # GitHub API client + types (no athena dependency)
│   ├── kanban/                # protocol/sync modules: scan, schema, state-machine, protocol, git-lock,
│   │                          #   lifecycle, planning, roles, progress, status-map, github-sync, github-feedback
│   └── sync-github.ts         # the sync-github CLI entry point
├── bin/sync-github            # CLI wrapper (works from any cwd)
├── hooks/                     # install-kanban-hook.sh + post-commit (md → GitHub auto-sync)
├── plugin/                    # the opencode worker plugins (auto-claim / progress-log / auto-sync)
├── templates/                 # Goal / Spec / Ticket .md.template
└── test/                      # 199 node:test tests for the protocol/sync modules
```

See [`backend.md`](backend.md) for the module-by-module guide, [`plugins.md`](plugins.md) for the
plugins, and [`setup.md`](setup.md) to adopt GDD on a new project.

## Getting involved

- Open an issue / comment on a Spec main-issue to discuss a feature (the feedback loop reads comments
  back into markdown as draft proposals).
- The decision record behind the design is in [`protocol-review.md`](protocol-review.md).
- The boundary with athena is recorded in [ADR 0009](../adr/0009-gdd-vs-athena-boundary.md).
