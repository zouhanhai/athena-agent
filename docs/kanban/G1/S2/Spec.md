---
id: g1_s2
title: "G1.S2: Frontend Web Portal Skeleton (Vue3 + TDesign)"
layer: S
parent: G1
owner: hermes
status: active
milestone: M1
acceptance_criteria:
  - "Vue3 + Vite + TS project can start, TDesign imported"
  - "CALEO brand theme (orange #ff6633 + dark gray-blue + sky blue)"
  - "Sidebar layout skeleton (personal chat/knowledge/Kanban route placeholders)"
  - "Personal chat panel usable (send message + display response, supports SSE streaming)"
  - "Connects to backend POST /api/chat"
---

# G1.S2: Frontend Web Portal Skeleton (Vue3 + TDesign)

## Problem Statement

athena-agent needs a frontend portal so employees can chat with their personal Pi via a web interface.
The backend (G1.S1) already provides the POST /api/chat endpoint. The frontend needs to consume it and provide portal navigation skeleton.

## Solution

Build the frontend portal with Vue3 + Vite + TypeScript + TDesign (Vue).
Provide sidebar navigation skeleton + personal chat panel (connects to backend /api/chat, supports SSE streaming).
CALEO brand color theme.

## User Stories

1. As an employee, I want to open the portal in a browser, so that I see the post-login workspace
2. As an employee, I want to navigate via sidebar, so that I can switch between personal chat/knowledge/Kanban panels
3. As an employee, I want to send messages to my personal Pi and see real-time responses, so that I complete personal chat
4. As an employee, I want to see streaming output, so that the chat experience is smooth
5. As a developer, I want a clean component structure, so that adding panels/features later is easy

## Implementation Decisions

- Framework: Vue3 + Vite + TypeScript (Composition API)
- UI Library: TDesign Vue (Tencent, same origin as WeKnora)
- State: Pinia (Vue official state management)
- Routing: Vue Router
- Color scheme: CALEO brand (orange #ff6633 primary + dark gray-blue #2d3142 + sky blue #69b3e7)
- Directory structure (web/):
  - `src/views/` — pages (personal chat/knowledge/Kanban placeholders)
  - `src/components/` — components (sidebar/chat bubbles etc.)
  - `src/api/` — API client (POST /api/chat + SSE)
  - `src/stores/` — Pinia state
  - `src/router/` — routing
- Personal chat MVP: manual userId input (Resend login deferred to M4)
- Backend connection: http://localhost:3000 (dev proxy to /api)

## Testing Decisions

- Component tests: Vitest + Vue Test Utils
- Unit/integration: chat panel send message → mock API
- Only test external behavior

## Out of Scope

- Knowledge base / Kanban / Team chat panels (M2-M3)
- Resend login / multi-employee identity (M4)
- Output page (M5)

## Further Notes

- Dev directory: web/ (6900XT)
- Reference backend API: POST /api/chat (G1.S1, already done)
- Reference WeKnora frontend design style
- Targeting German/international team (English UI)
