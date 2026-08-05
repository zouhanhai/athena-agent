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

**Claiming a ticket**: change status to `in_progress`, assignee to `opencode`,
and record the **session id** (e.g. `session_id: ses_xxxxxxxx`) that is handling it
(OpenCode serve supports multiple parallel sessions — the session id identifies which
worker is responsible, avoiding confusion when S1/S2 specs run concurrently).
Then `git add + commit + push` (git push atomicity guarantees mutual exclusion, preventing conflicts).

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
2. Claim (change status + assignee + session_id, then push)
3. `codegraph_explore` to understand existing code
4. Develop per **tdd** (tests first, then implementation)
5. Implementation complete, change status=done, write Log
6. commit + push

## Tech Stack

- Node 24+ / TypeScript (strict mode)
- Backend: Fastify + @earendil-works/pi-coding-agent (Pi SDK)
- Frontend: Vue3 + TDesign + Vite
- Database: Postgres 16 + pgvector

## Reference Documents

- `README.md` — project overview + milestones
- `docs/adr/` — architecture decisions (one per file)
- `docs/git-kanban-design.md` — Kanban mechanism
- `docs/pi-capabilities.md` — Pi SDK + packages capabilities
