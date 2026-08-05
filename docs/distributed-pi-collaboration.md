# Distributed Pi Collaboration Design (Local PiA + Remote Shared PiB)

> Multi-Pi distributed collaboration for remote-codebase projects (e.g. SAP ABAP).
> Local Pi (knowledge) + Remote shared Pi (SAP codebase context + OpenCode worker dispatch).

## Problem

Athena runs with Pi embedded locally (6900XT). For projects that live on a **remote
server** (e.g. SAP ABAP objects, not a git repo the local Pi can read), the local Pi
cannot see the codebase, test changes, or review worker output. A single Pi is
insufficient.

## Architecture (Two-Pi Model)

```
LOCAL (athena / 6900XT)
  ├─ Local PiA₁  (Employee 1 AgentSession, knowledge graph: LightRAG + llm_wiki)
  ├─ Local PiA₂  (Employee 2 AgentSession)
  ├─ Local PiA₃  (Employee 3 AgentSession)
  └─ Team PiA_team (shared team conversation)

REMOTE (SAP server)
  └─ Remote PiB (SHARED, single instance)
        ├─ ABAP MCP → understands SAP codebase (SE38/ADT/CTS)
        └─ dispatches OpenCode serve → allocates OpenCode workers (parallel)
```

**Key roles:**
- **Local PiA_i**: owns the employee's knowledge context (graph RAG) + orchestration.
- **Remote PiB (shared, 1)**: owns the remote codebase context (via ABAP MCP) and
  dispatches OpenCode workers. It is NOT itself the coder — it schedules workers.
- **OpenCode workers**: the actual coders, spawned by PiB for each task.

## Why PiB is shared (not per-employee)

PiB's job is querying remote SAP code + dispatching OpenCode workers. Multiple employees
can talk to PiB concurrently; PiB allocates a **separate OpenCode worker** per task. One
shared PiB avoids N SAP connections while still parallelizing via workers.

## Total Pi Count

| Scope | Local PiA | Remote PiB | OpenCode workers |
|-------|-----------|------------|------------------|
| 3 employees + team | 4 (PiA₁-₃ + team) | 1 shared | dynamic per task |

## Communication (Remote PiB as HTTP service)

PiB is wrapped in an athena-style Fastify HTTP shell (like athena's server), reachable
over **Tailscale VPN** (already meshed for German employees).

```
Local PiA ──HTTP (Tailscale)──▶ Remote PiB API
  ├─ POST /api/task   (dispatch task)
  ├─ POST /api/ask    (consult SAP codebase / ask PiB)
  ├─ GET  /api/status (worker/task status)
  └─ GET  /api/result (retrieve result)
```

Communication channels (composable):
1. **HTTP API** (primary): local PiA → remote PiB dispatch/consult.
2. **git-kanban** (async): shared GitHub board for ticket state.
3. **athena portal** (status): employees view progress.

## Conversation Routing (who is the user talking to?)

### Private chat — session isolation + explicit @
- Private chat default = **local PiA_i** (knowledge graph).
- Need SAP/codebase → employee uses a **SAP session** (routes to PiB) or **@PiB** in
  conversation.
- UI clearly labels current Pi (avatar/name/tag: "PiA - Knowledge" vs "PiB - SAP").

### Pi↔Pi in conversation (agent collaboration)
Local PiA can trigger remote PiB mid-conversation via HTTP:
```
User: "Explain this SAP program ZPRGM_001"
PiA:   "Consulting the SAP expert (PiB)…"
       [PiB: "This program does…; I can dispatch a worker to modify it."]
PiA:   integrates the answer for the user.
```
- PiA is the primary conversation; PiB's contribution rendered as an inline sub-reply / quote block (source-labeled).
- Optionally fork into two conversations (PiA thread + PiB thread) switchable.

### Team channel — shared PiA_team + shared PiB
```
Team channel:
  Employee1: "The SAP report has a bug"
  Team PiA_team: coordinates → triggers PiB → PiB allocates OpenCode worker
```
- 3 employees share the team conversation + the single remote PiB.

## Intent Routing (Local PiA)

| User intent | Route |
|-------------|-------|
| Knowledge / team processes / general | Local PiA (knowledge graph) |
| SAP codebase / ABAP / remote project | Remote PiB (via HTTP) |
| Cross-domain | PiA consults PiB then fuses |

## Open Questions / Next Steps

- SAP connection limit (single PiB vs N workers' ABAP access).
- OpenCode worker isolation on the remote server (per-task sessions, already supported by serve).
- Authentication between local and remote (Tailscale identity + API token).
- Whether the remote PiB + worker shell should be deployed as a second athena instance or standalone.

## Reference

- `docs/adr/0005-dialogue-structure.md` (existing single-Pi dialogue model)
- `docs/git-kanban-design.md` (async coordination)
- `docs/knowledge-rag-design.md` (local PiA knowledge context)
