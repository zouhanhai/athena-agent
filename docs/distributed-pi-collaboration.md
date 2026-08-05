# Multi-Agent Federation Design (Athena as Coordination Hub)

> Distributed collaboration where each employee talks to **multiple agents** through
> one unified hub. Local agent is **abstraction-agnostic** (Hermes / Claude Code / Codex /
> Pi / any agent), server owns knowledge, remote endpoint owns external codebases (e.g. SAP).
> Athena = the federation hub: unified HTTP/MCP interface + git-kanban + portal.

## Problem

Athena embeds Pi locally. For remote-codebase projects (e.g. SAP ABAP objects, not a git
repo the local agent can read), a single Pi cannot see the codebase, test, or review.
We need a distributed model where: (a) each employee runs their own local agent +
development environment, (b) knowledge is centralized on a server, (c) remote codebases
are owned by a remote endpoint — all reachable through one unified interface.

## Architecture (Three-Tier Federation)

```
┌────────────────────────────────────────────────────┐
│ SERVER (company server; 6900XT today)               │
│  ┌─────────┐ ┌─────────┐ ┌─────────────┐ ┌────────┐ │
│  │LightRAG  │ │llm_wiki │ │ athena portal│ │Server  │ │
│  │ :9621    │ │ :19828   │ │ (Vue)       │ │PiA_srv │ │
│  └─────────┘ └─────────┘ └─────────────┘ └────────┘ │
│  │ Unified Interface Layer (HTTP API + MCP)          │
│  │   knowledge · ingest · status · git-kanban        │
└───────────────┬──────────────────┬──────────────────┘
                │ HTTP (Tailscale) │
   ┌────────────┴─────────┐   ┌────┴─────────────┐
   │ REMOTE (SAP server)  │   │ LOCAL (each PC)   │
   │ Remote PiB + ABAP MCP│   │ Local agent       │
   │ + OpenCode workers   │   │ Hermes/Claude/    │
   │ (HTTP shell)         │   │ Codex/Pi + OpenCode│
   └──────────────────────┘   └──────────────────┘
```

## Core Design Principles

### 1. Local agent is abstraction-agnostic
- The local agent is **NOT required to be Pi**. It can be **Hermes, Claude Code, Codex, Pi,
  or any agent** that implements the unified interface.
- Requirements: call server HTTP API, claim/submit git-kanban tickets, return results.
- Server assumes NO local agent type.

### 2. Each employee talks to 3 agents
```
Employee → ① Local agent   (development, daily work, local OpenCode)
         → ② Server Pi     (knowledge: LightRAG + llm_wiki, ingest, wiki)
         → ③ Remote PiB    (external codebase: SAP ABAP, dispatch OpenCode workers)
```

### 3. Athena = federation hub (not a single-agent system)
- **Unified protocol**: HTTP API + MCP for knowledge/ingest/status/tasks.
- **Unified state**: git-kanban (async coordination).
- **Unified display**: athena portal (Vue) shows all agents' status.
- Any agent implementing the protocol joins the federation.

## Roles

| Tier | Component | Role |
|------|-----------|------|
| Server | **Server PiA_srv** | Knowledge steward: ingest, embedding, wiki maintenance; serves knowledge via HTTP/MCP |
| Server | LightRAG + llm_wiki | Centralized knowledge (vector+graph / wiki pages) |
| Server | athena portal | Unified UI: conversations, knowledge, kanban, wiki |
| Local | **Local agent** (any) | Employee's dev + chat; local OpenCode for coding; HTTP shell → server |
| Remote | **Remote PiB** (shared) | Owns external codebase context (ABAP MCP); dispatches OpenCode workers |
| Remote | OpenCode workers | Actual coders for remote tasks |

## Communication

### Unified Interface (server-side)
```
Server HTTP API (Fastify shell) + MCP:
  GET  /api/knowledge/search   (RAG)
  POST /api/knowledge/ingest   (docling → LightRAG + llm_wiki)
  GET  /api/wiki/:path         (wiki page)
  GET  /api/status             (agent/task status)
  git-kanban: ticket claim/submit
```
Local + Remote agents talk to the server through this interface over **Tailscale**.

### Remote PiB (SAP) reachable from server/local
```
POST /api/task   → PiB dispatches an OpenCode worker
GET  /api/status → worker/task status
```

## Conversation Routing (3 agents per employee)

| Intent | Agent |
|--------|-------|
| Knowledge / team processes / general | Server PiA_srv (knowledge graph) |
| Local development / own code | Local agent |
| External codebase (SAP ABAP) | Remote PiB |

- **Private chat**: default local agent; knowledge → server Pi; SAP → @PiB / SAP session.
- UI labels each agent (avatar/name): "Local Hermes", "Server Pi - Knowledge", "PiB - SAP".
- **Agent↔agent in conversation**: local agent consults server Pi or remote PiB via HTTP,
  then fuses the answer; sub-replies rendered source-labeled.

## Per-Employee Isolation + Independent OpenRouter Key

- Each employee's agent has **independent context/session** (already via AgentSession).
- Optionally **independent OpenRouter API key** → exact per-employee cost tracking,
  isolated quotas, no cross-employee cache interference.
- Knowledge (LightRAG/llm_wiki) remains shared at the service level (optionally
  permission-gated per employee).

## Migration Path (6900XT → company server)

1. Today: athena + Pi + LightRAG + llm_wiki all on 6900XT.
2. Next: move knowledge services (LightRAG/llm_wiki) + athena portal to a company server.
3. Then: server PiA_srv becomes the knowledge steward; each employee runs local agent.
4. Remote SAP endpoint (PiB + OpenCode) added when remote-codebase work begins.

## Open Questions / Next Steps

- Authentication between tiers (Tailscale identity + API token).
- Knowledge access permissions per employee.
- Whether server PiA_srv is one shared instance or per-employee (recommend shared for
  knowledge stewardship; local agent is per-employee).
- HTTP protocol versioning for the unified interface.

## Reference

- `docs/adr/0005-dialogue-structure.md` (single-Pi dialogue model, to evolve)
- `docs/git-kanban-design.md` (async coordination)
- `docs/knowledge-rag-design.md` (knowledge context)
- `docs/distributed-pi-collaboration.md` was the precursor (now superseded by this doc)
