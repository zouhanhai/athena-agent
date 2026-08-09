---
id: s6
title: "G4.S6: Remote agent federation (HTTP/SSE + Tailscale) + KB-as-MCP"
layer: S
parent: G4
owner: consultant
status: backlog
milestone: M4
acceptance_criteria:
  - "Local agents (remote WSL, LAN 6900XT, and the local Hermes) register to the platform via an invitation flow {agent_id, api_url, token}"
  - "Communication is HTTP + SSE over a Tailscale tunnel (NOT WebSocket); Tailscale is part of this Spec"
  - "Platform Chat panel routes to a selected remote agent's API Server, streaming tool progress (tool.started / tool.completed) into the panel"
  - "Knowledge base exposed as an MCP server (search_knowledge / get_wiki_page / get_graph) so any agent can retrieve company KB"
  - "Agent identity traceable: each agent connects with a unique id + token (invitation-issued); the platform knows which agent is where and how to reach it"
---

# G4.S6: Remote agent federation (HTTP/SSE + Tailscale) + KB-as-MCP

## Background

The AgentIDE vision: users manage remote agents from the platform. Each agent stays LOCAL (tools run on
the agent's machine); the platform is the control plane. Users send commands → forwarded to the right
local agent → agent works locally → streams the process + result back.

**Concrete goal (user, 2026-08-09):** register BOTH
1. the remote **WSL** agent, and
2. the **LAN 6900XT** agent
into the platform via the federation, so either can be controlled from the platform.

## Full design

See `docs/knowledge-rag-design.md` + M4 federation items in `TODO.md`. Key points:

- **Tailscale is part of this Spec** — it provides the encrypted tunnel so the server can reach every
  local agent across regions. This Spec includes: Tailscale the 6900XT + the remote WSL host, set
  `APP_BASE_URL` to a reachable address, and make invite/magic-link URLs open remotely (currently LAN-only).
- **Architecture**: agents stay local; platform is the control plane. **HTTP + SSE, NOT WebSocket**
  (SSE covers real-time push; HTTP covers command send).
- **Invitation onboarding** (like employee invites): admin generates `{agent_id, api_url, token}` →
  hand to the agent → agent registers (auth'd, so the platform knows which agent is where/how to reach it).
- **Chat routing**: platform Chat panel → selected remote agent's API Server (Hermes `/api/sessions/{id}/chat/stream`
  SSE, OpenCode `/global/event`), streaming tool progress into the panel.
- **KB as MCP server**: wrap `KnowledgeRetrievalService` (LightRAG + llm_wiki + semantic) into an MCP server;
  each local agent adds one `mcpServers` entry over Tailscale. Bonus: Workbench GitHub + kanban ops as MCP tools.
- A2A deferred to M6.

## Dependencies

- G4.S2 (RAG) for the KB the MCP server wraps.

## Deliverables

- Tailscale setup (6900XT + remote WSL) + APP_BASE_URL / remote access.
- Invitation-based agent onboarding + manual register form (S2.T9).
- HTTP+SSE routing from platform Chat to remote agents with streamed progress.
- KB MCP server (search_knowledge / get_wiki_page / get_graph).
