---
id: g1_s1
title: "G1.S1: Backend Service Skeleton (Fastify + AgentSession)"
layer: S
parent: G1
owner: hermes
status: approved
milestone: M1
acceptance_criteria:
  - "Node/TS Fastify backend can start"
  - "AgentSession embeds Pi successfully (DeepSeek chat)"
  - "Provides POST /api/chat endpoint (personal chat)"
  - "Clean module architecture, extensible"
---

# G1.S1: Backend Service Skeleton (Fastify + AgentSession)

## Problem Statement

athena-agent needs a Node/TS backend as the portal core, embedding Pi via AgentSession,
providing personal chat capability for each employee. Currently no code skeleton exists.

## Solution

Build the backend skeleton with Node/TS + Fastify, integrating @earendil-works/pi-coding-agent's AgentSession.
Provide basic API routes (personal chat), supporting DeepSeek as the chat model.

## User Stories

1. As an employee, I want to use personal chat, so that I can chat privately with my Pi
2. As a developer, I want a clean module structure, so that knowledge base/Kanban/team chat can be added later
3. As an admin, I want AgentSession correctly embedded, so that Pi capabilities are reused

## Implementation Decisions

- Framework: Fastify (ADR-0001)
- Pi embedding: AgentSession (@earendil-works/pi-coding-agent)
- Chat model: DeepSeek (default), supports Qwythos MTP local
- Module structure:
  - `src/agents/` — AgentSession management (per-employee persistent instances)
  - `src/routes/` — API routes (personal chat)
  - `src/config/` — configuration
- API: POST /api/chat (personal chat, streaming)

## Testing Decisions

- Unit tests: AgentSession creation/chat
- Integration tests: POST /api/chat → Pi → response
- Only test external behavior, not implementation details

## Out of Scope

- Frontend (G1.S2)
- Knowledge base / Kanban / Team chat (M2-M3)
- Multi-employee identity isolation (M4)

## Further Notes

- Development environment runs locally on 6900XT, deploy to 6900XT
- Reference: docs/adr/0001-node-fastify-agent-session.md
