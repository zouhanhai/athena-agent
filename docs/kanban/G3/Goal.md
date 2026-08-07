---
id: g3
title: "G3: Multi-Agent Federation & Team Workbench"
layer: G
owner: consultant
status: active
created_at: 2026-08-07
milestone: M3
acceptance_criteria:
  - "Global Chat panel: fixed right-side panel on every page (Knowledge/Wiki/Workbench/Upload), single shared context, agent cards above, add agent/employee entry"
  - "Agent Registry: agents declare identity (alias/owner/logo/capabilities/MCP) in PG"
  - "Employee Identity: email login, pick logo, RBAC, per-user GitHub credential (encrypted), agents archived under employees"
  - "Workbench page: 3 GitHub-style tabs (Code file-tree + code view / Issues / Kanban) scoped to per-user credential"
  - "Uploads page: own tab with per-system processing stages (docling/LightRAG/llm_wiki) + chunk progress, using the global chat"
  - "Git-Driven Development: worker-agnostic protocol + full 6-role lifecycle (Consultant/PM/EngD/Worker/Reviewer/Writer) + state machine with reject→re-decompose + GitHub full ops"
  - "Sidebar = pure navigation (Knowledge/Wiki/Workbench/Upload/Output[future]); Chat is not a sidebar item"
---

# G3: Multi-Agent Federation & Team Workbench

## Background / Context

Corresponds to Milestone M3. Objective: build the multi-agent federation + team workbench for the athena portal — any code-capable agent (Pi / OpenCode / other) can connect to Athena, declare identity and capabilities, and participate in a **single global shared-context chat** while working across the platform. The UI is redesigned around a **global right-side Chat panel**; the sidebar becomes pure navigation. Verified with a **single employee** first (multi-employee parallelism stays in M4).

Reference design docs:
- README.md (architecture overview + M3 acceptance criteria)
- docs/g3-requirements.md (G3 requirements capture — single source of truth for G3)
- docs/git-kanban-design.md (git-driven kanban mechanism, state machine, roles)
- docs/distributed-pi-collaboration.md (multi-agent federation architecture)
- docs/pi-capabilities.md (Pi SDK + packages)
- CONTEXT.md (glossary)
- Reference impl: OpenBMB/StaffDeck (digital-employee platform UX) + GitHub UI (Workbench)

## Goal

1. **Agent Registry** (G3.S1): agents declare identity (alias/owner/logo/capabilities/MCP/runtime), stored in PG.
2. **Employee Identity + RBAC + GitHub credentials** (G3.S2): email login, pick logo, RBAC, per-user GitHub credential (scoped), agents archived under employees.
3. **Global Chat panel** (G3.S3): fixed right-side panel on every page, single shared context, agent cards above, add agent/employee entry. Based on existing ChatView + S1 identity.
4. **Workbench page** (G3.S4): GitHub-style content area with 3 tabs — Code (file tree + code view), Issues, Kanban. Scoped to per-user credential.
5. **Uploads page** (G3.S5): own tab with detailed per-system processing stages (docling/LightRAG/llm_wiki) + chunk progress; uses the global Chat panel (no separate chat).
6. **Git-Driven Development** (G3.S6): worker-agnostic protocol + full 6-role lifecycle + GitHub full ops (open PR/edit/merge).

## Architecture

```
┌─────────────┬──────────────────────────────┬──────────────────────┐
│ Sidebar     │ Content area (per tab)        │ Global Chat panel    │
│ (nav only)  │                              │ (fixed right, S3)    │
│ Knowledge   │  Knowledge / Wiki /          │  agent cards (S1)    │
│ Wiki        │  Workbench (S4) /            │  add agent/employee  │
│ Workbench   │  Uploads (S5) /              │  single shared       │
│ Upload      │  Output[future]              │  context, speaker    │
│ Output[fu]  │                              │  logos, speak-toggle │
└─────────────┴──────────────────────────────┴──────────────────────┘

Backend:
  AgentRegistry (PG) — S1
  Employee+RBAC+GitHub creds (PG) — S2
  ConversationService (global context) — S3
  GitDrivenService (docs scan, kanban, GitHub ops) — S6
```

## Confirmed Decisions

- **Single employee** for G3 (multi-employee parallelism → M4).
- **Sidebar = pure navigation**; Chat is a global right-side panel (not a sidebar item).
- **Global single-context Chat**: switching tabs changes only center content; chat context never changes. Rationale: deepseek LLM cache high hit-rate + cheap.
- **Agent Registry independent Spec** (S1); stored in PG.
- **Employee login + RBAC in G3** (shares registry), separate Spec (S2).
- **S3 = Conversation + Global Chat panel** (merged S3+S4 of old plan).
- **Workbench (S4) = 3 GitHub-style tabs**: Code (file tree + code view + syntax highlight + branch) / Issues / Kanban, scoped to per-user credential.
- **Uploads (S5) = own tab**: detailed per-system stages + chunk progress; uses global Chat (no separate chat).
- **soul roles belong to git-driven development** (S6), separate from agent channel.
- **GitHub per-user credential + FULL ops** (browse + open PR/edit/merge), scoped to user (S2 + S6).
- **Git-driven = worker-agnostic protocol**: worker claims via git claim-lock; planning agent notifies/dispatches. Full 6-role lifecycle + state machine with reject→re-decompose.
- **Backend parsing/logic in S6; frontend rendering in S4.**

## Tech Stack

```
Backend: Node/TS + Fastify + @earendil-works/pi-coding-agent (Pi SDK)
Frontend: Vue3 + TDesign + Vite
Database: Postgres 16 + pgvector
GitHub: REST API (per-user credential)
Kanban: markdown files in git repo (docs/kanban/)
```

## Completion Criteria

See frontmatter acceptance_criteria. All Specs under G3.S1..S6 and their Tickets must be approved.
