---
id: g1
title: "G1: Project Skeleton + AgentSession Personal Chat"
layer: G
owner: hermes   # Initiator (currently played by Hermes, later employees/Pi each)
status: done
created_at: 2026-08-04
milestone: M1
acceptance_criteria:
  - "Node/TS + Fastify backend can start"
  - "AgentSession embeds Pi successfully"
  - "Personal chat works end-to-end (frontend → backend → Pi → response)"
  - "Vue frontend has sidebar skeleton"
---

# G1: Project Skeleton + AgentSession Personal Chat

## Background / Context

This is the first Goal of the athena-agent project, corresponding to Milestone M1.
Objective: Build the technical skeleton of the entire project and run through the core "personal chat" closed loop.

Reference design docs:
- README.md (architecture overview + M1 acceptance criteria)
- docs/adr/0001-node-fastify-agent-session.md (Node/TS + Fastify + AgentSession)
- gdd/docs/design.md (git-driven Kanban)
- CONTEXT.md (glossary)

## Goal

1. Establish athena-agent project's Node/TS + Fastify backend skeleton
2. Embed Pi via `AgentSession` (@earendil-works/pi-coding-agent)
3. Establish Vue 3 + TDesign frontend skeleton (CALEO orange theme)
4. Run through "personal chat" end-to-end: employee → frontend → backend → Pi(AgentSession) → response

## Confirmed Decisions

- Backend: Node/TS + Fastify (ADR-0001)
- Pi Embedding: AgentSession (ADR-0001)
- Frontend: Vue3 + TDesign, CALEO orange #ff6633
- Deployment target: 6900XT (run locally during development)

## Tech Stack

```
server/   → Node/TS Fastify + AgentSession
web/      → Vue3 + TDesign + Vite
models    → DeepSeek (chat) + Qwythos MTP (local, optional)
```

## Completion Criteria

See frontmatter acceptance_criteria. All Specs under G1.S1 and their Tickets must be approved.
