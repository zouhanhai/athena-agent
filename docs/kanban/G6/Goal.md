---
id: G6
title: "G6: Per-User Isolation & Sandboxing (independent Pi + independent keys)"
layer: G
owner: consultant
status: planned
created_at: 2026-08-17
milestone: M6
acceptance_criteria:
  - "Each employee gets an independent Pi conversation instance (isolated from others)"
  - "Each employee gets an independent OpenRouter key (cost attribution per user)"
  - "Secrets never enter the sandbox process / command line / files (Credential Vault pattern)"
  - "Scales to ~50 employees (K8s / container runtime)"
---

# G6: Per-User Isolation & Sandboxing

## Background / Context

Inherited from G4 + the 50-employee scaling decision (2026-08-15). athena currently runs all
employees' Pi sessions in **one server process** (per-employee session dir, no container isolation),
sharing one OpenRouter key. For ~50 employees the target is:

1. **each user an independent Pi** (isolated conversation instance), and
2. **each user an independent OpenRouter key** (cost attribution per employee, cache-hit control).

Reference: `docs/opensandbox-reference.md` (OpenSandbox Credential Vault + gVisor/Kata/Firecracker,
Apache-2.0, 13k★) — strongest candidate for per-user sandboxing. Also referenced by
`docs/kanban/G4/S5/s5-dataflow-study.md` ("G6 再讨论" for Local kanban view fate).

## Goal

1. Design the per-user isolation model (container/sandbox per employee vs server-process partitions).
2. Pick the sandbox runtime (OpenSandbox / gVisor variants / plain containers) + secret injection
   mechanism (Credential Vault egress sidecar).
3. Wire per-user OpenRouter keys, per-user config/state dirs, per-user Pi sessions.
4. **Analyze the 10 installed Pi packages (`~/.pi/agent/settings.json`)** in the sandbox context:
   pi-hermes-memory (v0.9.2), pi-mcp-adapter, pi-intercom, pi-task, pi-goal-list-loop-audit,
   @quintinshaw/pi-dynamic-workflows, @juicesharp/rpiv-ask-user-question, pi-web-access, pi-crew,
   @juicesharp/rpiv-todo — decide which move into the per-user sandbox, which stay platform-global,
   and whether pi-hermes-memory (memory per Pi) collides with the platform memory layer.
5. Decide G4.S5 leftover: Local kanban view fate (stalled signal source) with per-user isolation.

## Confirmed Decisions (2026-08-17)

- **Pi extensions analysis deferred to this goal** — do NOT analyze/upgrade (pi-hermes-memory
  0.9.2 vs npm 0.9.6) in the current shared-process setup; revisit during sandboxing.
- Memory/unified-key work (chat provider `athena`, Mem0 LLM `qwen/qwen3.7-flash`,
  embedder `qwen/qwen3-embedding-8b`, Hermes main key) is OUT of scope — already settled in G4.

## Progress

- (none yet — planned)