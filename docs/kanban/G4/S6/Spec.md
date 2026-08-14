---
id: s6
title: "G4.S6: GDD (Git-Driven Development) decoupling — boundary vs athena, docs/gdd handbook, Workbench Kanban/Project sub-tab split"
owner: consultant
layer: S
parent: G4
milestone: M4
acceptance_criteria:
  - "GDD is documented as a generic, agent-agnostic dev-flow protocol in a gdd/docs/ handbook (design / setup / backend / plugins / reference), clearly separated from athena's KB/chat product"
  - "A step-by-step setup guide exists so any new project can enable GDD (templates, git hook, sync CLI, opencode plugins) on its own repo without athena coupling"
  - "Workbench separates Kanban (local GST board = GDD) and Project (GitHub view = athena generic) into sibling sub-tabs (moved ticket, ex-G4.S5.T19)"
  - "The boundary decision is recorded as ADR 0009 and referenced from the Goal"
status: in_progress
---

# G4.S6: GDD decoupling & packaging

## Background

athena-agent contains two conflated capabilities (2026-08-14 user discussion): the **GDD dev-flow**
(Gx.Sx.Tx kanban, md→GitHub sync, state machine, roles, plugins) and the **athena KB/chat product**
(Neo4j RAG, Q&A, chat). The abaplorer team uses GitHub Issues/Projects directly and never touches GDD —
they use athena for the KB, and still browse GitHub repo/issue/project in the Workbench. So GDD is a
**generic protocol** that must be packageable/reusable on any project, cleanly separated from athena.

Boundary rule (ADR 0009): **split by dev-flow vs knowledge-base** — whatever serves development-task
management is GDD (generic); whatever serves KB/Q&A is athena (product-specific).

## Design / Approach

1. **Boundary decision** — recorded in `docs/adr/0009-gdd-vs-athena-boundary.md`:
   - GDD: GST 3-layer + md templates, local Kanban board, md→GitHub sync (hook + CLI), state machine,
     kanban-index, roles (Consultant/PM/EngD/Worker/Reviewer/Writer), opencode plugins.
   - athena: Workbench shell + GitHub repo/issue/project viewing (generic), KB/RAG/Q&A/chat.
   - Recommendation: new projects adopt GDD (pairs with athena); optional per project.

2. **gdd/docs/ handbook** (方案 B, lightweight — code stays in athena repo, docs make GDD independently
   adoptable):
   - `gdd/README.md` — what GDD is, boundary vs athena, when to use, architecture overview.
   - `gdd/docs/design.md` — the full GDD protocol (moved from `gdd/docs/design.md`).
   - `gdd/docs/protocol-review.md` — design decision record (moved from `gdd/docs/protocol-review.md`).
   - `gdd/docs/setup.md` — step-by-step: enable GDD on any new project (copy templates, install
     `scripts/install-kanban-hook.sh` + `hooks/post-commit`, run `sync-github`, deploy opencode plugins).
   - `gdd/docs/backend.md` — kanban backend modules (server/src/kanban/*.ts: scan/state-machine/
     git-lock/schema/github-sync/github-feedback/roles/planning/lifecycle/protocol/frontmatter/
     index-file/progress/status-map/board/index) — what each does, how to run.
   - `gdd/docs/plugins.md` — opencode plugins (auto-claim / progress-log / done-commit / auto-sync).
   - `gdd/docs/reference.md` — concept index (Gx.Sx.Tx, state machine, roles, Progress Log, glossary).

3. **Workbench sub-tab split** (moved ticket, ex-G4.S5.T19): keep **Kanban** (local GST = GDD) and
   **Project** (GitHub view = athena generic) as sibling sub-tabs under the Workbench.

## Dependencies

- None hard (GDD is self-contained). Related: G4.S5 (GitHub sync the handbook documents), G4.S7
  (remote federation — GDD is one workflow a remote agent can run).

## Deliverables

- ADR 0009 (boundary) — done.
- Workbench sub-tabs: T1 split Kanban/Project; T4 remove local Kanban tab + local board stack (kanban-index/scan), GitHub Project panel is the only board view.
- Spec state machine simplification — remove decomposed, ticket-driven in_progress + spec main-issue open/closed sync (T2).
- GDD code separation — move GDD code (kanban protocol/sync, sync-github, hooks, plugins, templates) into an independently-runnable gdd/ package running on the user's local machine (T3, after T1/T2): split github-sync (createSpecIssue→GDD, buildGithubProjectBoard→athena), local-token-first credential.
- gdd/docs/ handbook — README/design/protocol-review/setup/backend/plugins/reference + GST templates (T5, after T3).
- Goal.md updated (S6 = GDD, S7 = remote federation).
