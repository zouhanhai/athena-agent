---
id: g3_s3
title: "G3.S3: Global Chat Panel (Conversation + Agent Cards)"
layer: S
parent: G3
owner: pm
status: active
milestone: M3
acceptance_criteria:
  - "Chat is a GLOBAL fixed right-side panel on every page (Knowledge/Wiki/Workbench/Upload), not a sidebar item"
  - "Single shared conversation context across all pages (switching tab does not change chat context)"
  - "Based on existing ChatView, adapted into a fixed right-side panel"
  - "Agent cards above the chat (from S1): logo, alias, capabilities, speak-toggle"
  - "Entry to add other agents / employees into the shared conversation"
  - "Speaker logo on each message (which agent/employee said it)"
---

# G3.S3: Global Chat Panel (Conversation + Agent Cards)

## Task

Build the global Chat panel — a fixed right-side panel present on every page, holding a single shared conversation context. Adapted from the existing ChatView. Agent cards (S1) sit above the chat with a speak-toggle; users can add other agents/employees into the shared conversation.

## Key Dependencies

- G3.S1 (agent registry — agent identity/capabilities for cards)
- G3.S2 (employees — multi-user participants + their logos)
- Existing ChatView.vue (conversation engine + Pi AgentSession)

## Architecture

```
┌──────────────────────────────────────────────┐
│ Global Chat panel (fixed right, all pages)   │
├──────────────────────────────────────────────┤
│ Agent cards (S1): [logo][alias][cap][toggle] │
│ Add-agent / add-employee entry               │
├──────────────────────────────────────────────┤
│ Single shared conversation (context never    │
│ changes when switching tabs)                │
│ [speaker logo] message text                  │
└──────────────────────────────────────────────┘
```

## UI Placement (Decided)

- Chat = global fixed panel on the RIGHT of the content area, on every page.
- Sidebar no longer has a Chat item (pure navigation).
- The global chat also appears on Workbench / Uploads / Wiki / Knowledge pages.

## Implementation

### 1. Convert ChatView → global fixed right panel
- Existing ChatView.vue adapted from a routed page (/chat) into a fixed layout slot on the right of every page
- Remove Chat from SidebarNav (side bar = navigation only)
- App shell: [Sidebar | Content | GlobalChat] three-column layout

### 2. Single shared conversation context
- One conversation entity (Pi AgentSession) used across all pages
- Switching tab changes only the center content; chat context persists
- Deepseek LLM cache makes long single context practical

### 3. Agent cards above chat
- From S1: logo, alias, capabilities, speak-toggle (on = agent responds, off = reads context only)
- StaffDeck-style card display

### 4. Add agent / employee entry
- Button to add other agents (S1) / employees (S2) into the shared conversation
- Added participant sees the conversation context

### 5. Speaker logo on messages
- Each bubble shows speaker logo (agent from S1, employee from S2)

## Reference

- Spec: `docs/kanban/G3/Goal.md`
- Requirements: `docs/g3-requirements.md` §2 + SUPERSEDED layout decisions
- StaffDeck (card display reference)

## How to Locate Reference Docs

- `parent: G3` → `docs/kanban/G3/Goal.md`
- Requirements: `docs/g3-requirements.md` §2

## Notes

- Multi-agent collaboration mechanics (@-mentions, agents chatting each other) deferred to a later milestone.
- The single global context is a deliberate design choice (deepseek cache economics).
- Use **implement** + tdd + code-review

## Dependencies

- G3.S1 (agents), G3.S2 (employees), existing ChatView + Pi AgentSession

## Log
