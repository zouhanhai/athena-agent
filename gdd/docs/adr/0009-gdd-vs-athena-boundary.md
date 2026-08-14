# GDD (Git-Driven Development) vs athena — Boundary & Decoupling

The GDD workflow protocol is a **generic, agent-agnostic development-flow mechanism**, distinct from
athena's knowledge-base/chat product. This ADR records the boundary decision so GDD can be packaged and
reused on any project without athena coupling.

**Status**: Accepted (2026-08-14, discussed + confirmed by user)

## Context

athena-agent contains two distinct kinds of capability that had become conflated:

1. **Git-Driven Development (GDD)** — the collaborative kanban dev-flow: Gx.Sx.Tx three-layer structure,
   markdown files (`docs/kanban/*.md`) as source of truth, ticket claim-lock, state machine
   (backlog → in_progress → done → approved/rejected, + Spec lifecycle incl. canceled),
   kanban-index.json, md → GitHub Issues/Project sync (git hook + sync-github CLI), GitHub → md feedback,
   roles (Consultant/PM/Eng Director/Worker/Reviewer/Writer), Progress Log, and the opencode plugins
   (auto-claim / progress-log / done-commit / auto-sync).
2. **athena KB/chat product** — Neo4j RAG, docling refinement, llm_wiki, Q&A pairs, terms, retrieval,
   chat/Q&A UI, and the Workbench shell + generic GitHub repo/issue/project viewer.

Observation (2026-08-14): the abaplorer team uses GitHub Issues/Projects directly and **does not use the
GDD Gx.Sx.Tx flow at all** — they still use athena for the **KB**, and they can still browse GitHub
repo/issue/project inside the Workbench. So the Workbench's GitHub viewing capability is athena-generic,
NOT GDD.

## Decision

**Boundary rule: split by "development-flow" vs "knowledge-base".**
Whatever serves **development-task management** is **GDD** (generic, reusable on any project).
Whatever serves **knowledge-base / Q&A** is **athena** (product-specific).

Concretely:

| Capability | Bucket |
|---|---|
| Gx.Sx.Tx 3-layer structure + md templates (`docs/kanban/templates/`) | GDD |
| Local Kanban board (reads GST md + kanban-index) | GDD |
| md → GitHub Issue/Project sync (sync-github.ts, github-sync.ts, github-feedback.ts, git hook) | GDD |
| Ticket/Spec state machine, status-map, schema, lifecycle | GDD |
| kanban-index.json + write-index.ts + scan.ts | GDD |
| Roles (Consultant/PM/EngD/Worker/Reviewer/Writer) + planning | GDD |
| opencode plugins (auto-claim, progress-log, done-commit, auto-sync) | GDD |
| Workbench shell (tabs container) | athena (generic viewer infra) |
| GitHub repo / issue / project viewing (Code/Issues/Project tabs) | athena (anyone can use, GDD not required) |
| KB, Neo4j RAG, docling, llm_wiki, Q&A, terms, retrieval, chat | athena |

**UI consequence — Workbench sub-tabs** (T19): keep **Kanban** (local GST board = GDD) and **Project**
(GitHub Project view = athena generic) as **two sibling sub-tabs under the Workbench**, not conflated in
one tab and not separate top-level pages. So a non-GDD user (e.g. abaplorer) sees a generic Project tab,
while GDD users additionally get the local Kanban tab.

**Documentation packaging (方案 B, lightweight)**: keep the GDD code in the athena repo for now, but
organize a **`gdd/docs/` handbook** (README / design / protocol-review / setup / backend / plugins /
reference) that (a) defines GDD, (b) explains the boundary vs athena, (c) gives a step-by-step
**setup guide** for enabling GDD on any new project (install templates, hook, sync CLI, plugins). This
makes GDD independently adoptable without physically splitting the repo. Physical extraction to its own
repo is deferred (future option if a second consumer appears).

**Recommended stance**: for new projects, recommend adopting the GDD flow since it pairs cleanly with
athena (KB + dev-flow views). It is optional — a project may use only the athena KB + GitHub viewing.

## Consequences

- **Positive**: GDD becomes a documented, reusable protocol any team can adopt; the athena product is
  not confused with the dev-flow; the UI reflects the boundary (Kanban vs Project tabs).
- **Negative/trade-off**: GDD code still physically lives in the athena repo (no extraction yet); the
  docs/ setup guide must be kept in sync with the code; the `employees` credential store is an athena
  coupling that a standalone GDD setup bypasses via `GITHUB_TOKEN`/gh token.
- **Reusable**: the whole GDD handbook + a setup guide is the path for a new user to switch GDD onto
  their own environment/agent.

## Links

- [`gdd/docs/design.md`](../design.md) — the GDD protocol design; [§19 Issues Sync](../design.md#19-issues-sync-s5--collab-mode-only) documents the GitHub sync mapping/triggers
- [`gdd/docs/protocol-review.md`](../protocol-review.md) — grill record behind the design
- Kanban tickets: G4.S5.T19 (Workbench Kanban/Project sub-tab split)
