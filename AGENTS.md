# AGENTS.md — athena-agent Dev Worker Guide

This file is the operational specification for OpenCode/agent when developing this project.

## Project Essence

athena-agent is a **Pi-centric** multi-employee intelligent collaboration portal.
- **Pi SDK** is the core engine (conversation / agent / logic); Fastify is a thin HTTP shell
- The Dev Worker for development is **OpenCode** (this project merely uses OpenCode to write athena code; this is unrelated to the athena product itself)

## Kanban Structure (git-driven)

All tasks are managed via markdown files in the git repository. The board is at `docs/kanban/`:

```
docs/kanban/
├── G{N}/              ← Goal layer (directory)
│   ├── Goal.md        ← This Goal's objective / grill output / acceptance criteria
│   └── S{N}/          ← Spec layer (subdirectory)
│       ├── Spec.md    ← This Spec's requirements / implementation decisions / acceptance criteria
│       └── T{N}.md    ← Ticket layer (the specific task you need to complete)
```

### Finding Spec and Goal from a Ticket (Mandatory)

Each Ticket's frontmatter has hierarchy fields:
- `parent: G1.S1` → navigate to `docs/kanban/G1/S1/Spec.md`
- `parent`'s parent → navigate to `docs/kanban/G1/Goal.md`

**Before developing any ticket**, read:
1. The ticket file itself (current task)
2. `docs/kanban/{G}/{S}/Spec.md` (requirements / acceptance criteria)
3. `docs/kanban/{G}/Goal.md` (overall objective / acceptance criteria)

### Ticket State Transitions (Claim Lock)

```
backlog → in_progress → done → in_review → approved
                            ↘ rejected → Eng Director regenerates T{N}.N
```

**Claiming a ticket is AUTOMATED**: the resident OpenCode plugin (`athena.worker`,
loaded from `.opencode/plugins/` / `~/.config/opencode/plugins/`; the worker logic
lives in the GDD package at `gdd/plugin/`, G4.S6.T3) auto-claims a dispatched
ticket on the worker's first tool call — it writes status `in_progress`,
assignee, and the session id, appends the claim row to the Progress Log, and does
`git add + commit + push` (git push atomicity is the mutual-exclusion lock,
preventing two workers claiming the same ticket). Workers must NOT manually claim;
just start working. On a lost race the plugin surfaces `ClaimConflictError` and the
worker backs off.

**Only claim tickets with status=backlog. Rejected tickets cannot be directly claimed.**

## Development Standards (OpenCode Worker)

### Required Skills

- **tdd**: Red-Green-Refactor cycle. Write tests at public seams first, then minimal implementation
- **implement**: Implement based on spec/ticket, use `codegraph_explore` to understand code
- **code-review**: After completing implementation, review against both Standards and Spec
- **diagnosing-bugs**: When encountering bugs, use the systematic 6-stage diagnosis

### Required CodeGraph

Project code is indexed with **CodeGraph** (`codegraph serve --mcp`).
When understanding / locating code, prioritize `codegraph_explore` (more comprehensive than grep/find);
it can follow call chains, dynamic dispatch, and find connections that grep misses.

### Workflow

A ticket's full lifecycle:
1. Read ticket + corresponding Spec.md + Goal.md
2. `codegraph_explore` to understand existing code
3. Develop per **tdd** (tests first, then implementation)
4. Implementation complete, change status=done, write Log
5. commit + push

The claim itself is handled by the plugin on your first tool call — do not edit
the ticket's status/assignee/session_id by hand.

## Tech Stack

- **Language**: All files (docs, comments, tickets, specs, code) are written in **English** — the whole team reads them.
- Node 24+ / TypeScript (strict mode)
- Backend: Fastify + @earendil-works/pi-coding-agent (Pi SDK)
- Frontend: Vue3 + TDesign + Vite
- Database: Postgres 16 + pgvector

## Reference Documents

- `README.md` — project overview + milestones
- `docs/adr/` — architecture decisions (one per file)
- `gdd/` — the GDD package: kanban protocol/sync modules, `sync-github` CLI, hooks,
  opencode plugins (`gdd/plugin/`), GST templates; runs standalone on the user's machine
- `gdd/docs/` — the GDD handbook: `README.md` (what GDD is + boundary vs athena),
  `design.md` (Kanban mechanism), `protocol-review.md` (GDD design decision record),
  `setup.md` (enable GDD on a new project), `backend.md` (gdd package modules + sync-github CLI),
  `plugins.md` (opencode plugins), `reference.md` (concept index),
  `adr/` (GDD boundary decision — `0009-gdd-vs-athena-boundary.md`)
- `docs/pi-capabilities.md` — Pi SDK + packages capabilities
