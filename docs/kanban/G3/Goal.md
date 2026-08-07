---
id: g3
title: "G3: Multi-Agent Federation & Team Workbench"
layer: G
owner: consultant
status: active
created_at: 2026-08-07
milestone: M3
acceptance_criteria:
  - "Agent Registry: agents connect to Athena and declare identity (alias/owner/logo/capabilities/MCP), stored in PG"
  - "Employee Identity: employees log in (email), pick a logo, RBAC per role, agents archived under employees"
  - "Per-user GitHub credential (SSH/token) provided at registration, scoped to that user's GitHub permission"
  - "Conversation System: Teams-style unified conversation list + types (private/multi-user/Workbench)"
  - "Agent-card Chat UI: add agents to a chat as cards, toggle to speak, speaker logo on each message"
  - "Workbench 3-panel page: Chat | GitHub repo tree | Kanban"
  - "Git-Driven Development: full 6-role lifecycle (Consultant/PM/EngD/Worker/Reviewer/Writer) + state machine with reject→re-decompose + GitHub full ops (open PR/edit/merge)"
---

# G3: Multi-Agent Federation & Team Workbench

## Background / Context

Corresponds to Milestone M3. Objective: build the multi-agent federation + team workbench for the athena portal — any code-capable agent (Pi / OpenCode / other) can connect to Athena, declare its identity and capabilities, participate in conversations, and collaborate through a GitHub-driven workbench. Verified with a **single employee** first (multi-employee parallelism stays in M4).

Reference design docs:
- README.md (architecture overview + M3 acceptance criteria)
- docs/g3-requirements.md (G3 requirements capture — single source of truth for G3)
- docs/git-kanban-design.md (git-driven kanban mechanism, state machine, roles)
- docs/distributed-pi-collaboration.md (multi-agent federation architecture)
- docs/pi-capabilities.md (Pi SDK + packages)
- CONTEXT.md (glossary)
- Reference impl: OpenBMB/StaffDeck (digital-employee platform UX)

## Goal

1. **Agent Registry** (G3.S1): agents declare identity (alias/owner/logo/capabilities/MCP/runtime), stored in PG.
2. **Employee Identity + RBAC + GitHub credentials** (G3.S2): email login, pick logo, RBAC, per-user GitHub credential (scoped), agents archived under employees.
3. **Conversation System** (G3.S3): Teams-style unified conversation list + types (private/multi-user/Workbench).
4. **Agent-card Chat UI** (G3.S4): add agents as cards to a chat, toggle to speak, speaker logo per message.
5. **Workbench 3-panel** (G3.S5): Chat | GitHub repo tree | Kanban (frontend shell).
6. **Git-Driven Development** (G3.S6): worker-agnostic protocol + full 6-role lifecycle + GitHub full ops (open PR/edit/merge).

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Sidebar: unified conversation list (Teams-style)           │
│   private (own agent) / multi-user / Workbench             │
├─────────────────────────────────────────────────────────────┤
│ Conversation stream (G3.S3/S4)                             │
│   agent cards above, speaker logo on messages              │
├─────────────────────────────────────────────────────────────┤
│ Workbench 3-panel (G3.S5):                                 │
│   Chat | GitHub repo tree | Kanban                         │
├─────────────────────────────────────────────────────────────┤
│ Backend:                                                    │
│   AgentRegistry (PG) — G3.S1                               │
│   Employee+RBAC+GitHub creds (PG) — G3.S2                  │
│   ConversationService — G3.S3                              │
│   GitDrivenService (docs scan, kanban, GitHub ops) — G3.S6 │
└─────────────────────────────────────────────────────────────┘
```

## Confirmed Decisions

- **Single employee** for G3 (multi-employee parallelism → M4).
- **Agent Registry independent Spec** (S1); stored in PG.
- **Employee login + RBAC in G3** (shares registry), separate Spec (S2).
- **Workbench 3-panel** page (S5); Kanban is not a separate panel — folded into Workbench.
- **Conversations = Teams-style unified list + type labels** (S3), using the long sidebar.
- **Agent cards + speak toggle + speaker logo** (S4), StaffDeck-style display.
- **soul roles belong to git-driven development** (S6), separate from agent channel.
- **GitHub per-user credential + FULL ops** (browse + open PR/edit/merge), scoped to user (S2 + S6).
- **Git-driven = worker-agnostic protocol**: worker claims via git claim-lock itself; planning agent notifies/dispatches. Full 6-role lifecycle (Consultant/PM/EngD/Worker/Reviewer/Writer) + state machine with reject→re-decompose.
- **Backend parsing/logic in S6; frontend rendering in S5.**

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
