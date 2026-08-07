---
id: g3_s4
title: "G3.S4: Agent-Card Chat UI"
layer: S
parent: G3
owner: pm
status: active
milestone: M3
acceptance_criteria:
  - "Chat area has a region above messages to pick agents to add into the conversation"
  - "Each added agent shows as a card (StaffDeck-style): logo, alias, capabilities"
  - "Each card has a toggle/slider controlling whether the agent may speak"
  - "Adding an agent = that agent sees the conversation context"
  - "Each message bubble shows the speaker's logo (which agent/employee said it)"
---

# G3.S4: Agent-Card Chat UI

## Task

Build the agent-aware chat UI — a region above the messages to add agents into a conversation (as cards with a speak-toggle), and speaker logos on each message so you can tell who said what.

## Key Dependencies

- G3.S1 (agent registry — agent identity/capabilities for cards)
- G3.S3 (conversation system — messages/stream)

## Architecture

```
Conversation stream (from S3)
  ┌─────────────────────────────────────────────┐
  │ Agent picker (above messages)               │
  │   [pick agents to add to conversation]      │
  ├─────────────────────────────────────────────┤
  │ Agent cards (each joined agent)             │
  │   [logo] [alias] [capabilities] [toggle]    │
  ├─────────────────────────────────────────────┤
  │ Message stream                              │
  │   [speaker logo] message text               │
  └─────────────────────────────────────────────┘
```

## UI Placement (Decided)

- Inside the conversation message area (S3): agent picker + cards above the stream, speaker logo on each bubble.

## Implementation

### 1. Agent picker (frontend)
- Region above messages: list available agents (S1) → pick to add
- Adding an agent → shows as a card + agent gains conversation context

### 2. Agent card component
- Each card: logo (S1), alias, capabilities, and a **toggle/slider** for "may speak"
- StaffDeck-style display (clean, logo + identity)

### 3. Speak toggle
- Toggle controls whether the agent responds in this conversation
- Off = agent reads context but does not respond

### 4. Speaker logo on messages
- Each message bubble shows the speaker's logo (S1) to identify which agent/employee said it
- Includes the human user's logo (S2) for their own messages

## Reference

- Spec: `docs/kanban/G3/Goal.md`
- Requirements: `docs/g3-requirements.md` §2 (agent-aware conversation UI)
- StaffDeck (card display reference)

## How to Locate Reference Docs

- `parent: G3` → `docs/kanban/G3/Goal.md`
- Requirements: `docs/g3-requirements.md` §2

## Notes

- Multi-agent collaboration mechanics (@-mentions, agents chatting each other) are **deferred** to a later milestone — G3 only does pick + speak-toggle + speaker logo.
- Use **implement** + tdd + code-review

## Dependencies

- G3.S1 (agents), G3.S3 (conversation)

## Log
