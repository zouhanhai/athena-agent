---
id: g3_s3
title: "G3.S3: Conversation System"
layer: S
parent: G3
owner: pm
status: active
milestone: M3
acceptance_criteria:
  - "Conversations are first-class entities with a type (private / multi-user / Workbench)"
  - "Unified conversation list in the sidebar (Teams-style)"
  - "Conversation CRUD: create/delete, participants, unread markers, search"
  - "Click a conversation → opens its message stream"
  - "Workbench conversation type → renders 3-panel layout (S5)"
  - "Conversation participants include agents (from S1)"
---

# G3.S3: Conversation System

## Task

Build the conversation system — Teams-style unified conversation list in the sidebar, conversations as first-class entities with types (private/multi-user/Workbench). This replaces the current single ChatView with a dynamic multi-conversation model.

## Key Dependencies

- G3.S1 (agent registry — participants include agents)
- G3.S2 (employees — multi-user participants)
- Existing Pi AgentSession (conversation engine)

## Architecture

```
Sidebar (Teams-style) → conversation list
  ├─ private (own agent)  : 1:1 with an agent
  ├─ multi-user            : employee group chat
  └─ Workbench             : 3-panel layout (Chat | Repo | Kanban) — S5

ConversationService (backend)
  → conversations table (PG): id, type, title, participants, created_at
  → messages: via Pi AgentSession per conversation
  → unread markers, search, create/delete
```

## UI Placement (Decided)

- **Sidebar becomes the conversation list** (Teams-style), replacing the current static Chat tab.
- Clicking a conversation → main area shows its message stream.
- A Workbench conversation → main area renders the 3-panel layout (S5).

## Implementation

### 1. Conversation data model (Postgres)
- `conversations` table: id, type (private/multi-user/workbench), title, participants (jsonb: employees+agents), created_at, updated_at
- Each conversation maps to a Pi AgentSession (existing session engine)

### 2. Conversation CRUD API (server/src/routes/conversations.ts)
- `POST /api/conversations` (create, type + participants), `GET /api/conversations` (list for user), `DELETE /api/conversations/:id`
- `GET /api/conversations/:id/messages` (stream), `POST /api/conversations/:id/messages` (send)
- Participants: employees (S2) + agents (S1)

### 3. Sidebar conversation list (frontend)
- Replace static Chat tab with dynamic conversation list (Teams-style)
- Unread markers, search, create/delete
- Type labels on each conversation

## Reference

- Spec: `docs/kanban/G3/Goal.md`
- Requirements: `docs/g3-requirements.md` (B: Teams-style unified list + types)

## How to Locate Reference Docs

- `parent: G3` → `docs/kanban/G3/Goal.md`
- Requirements: `docs/g3-requirements.md` §B

## Notes

- Conversation = first-class entity; the current single ChatView becomes one (private) conversation
- Workbench type only renders 3-panel in S5; S3 just stores the type
- Use **implement** + tdd + code-review

## Dependencies

- G3.S1 (agents), G3.S2 (employees), Pi AgentSession

## Log
