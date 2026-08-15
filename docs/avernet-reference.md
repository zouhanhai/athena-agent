# Avernet — reference for G4.S7 (remote agent federation)

**Source**: https://github.com/inclusionAI/Avernet (Apache-2.0, 387★)
**Discovered**: 2026-08-10 (user). Placed in G4.S7 as a reference/optional enhancement.

## What it is

**Avernet is an open-source infrastructure layer for building and operating persistent, coordinated,
multi-agent systems at organizational scale** — "where agents live, connect, coordinate, execute, and
evolve together." Production-tested at Ant Group: multi-agent deployments across 12 business groups,
90%+ task completion rate in measured multi-agent workflows.

## Relevance to G4.S7 (remote agent federation)

G4.S7 builds a control plane where remote agents (WSL, LAN 6900XT, local Hermes) register and are driven
over HTTP+SSE + Tailscale. Avernet provides a production-grade version of the same coordination concern:

| G4.S7 need | Avernet capability |
|-----------|-------------------|
| Remote agents register + connect | Identity / onboarding / registration |
| Control plane drives agents | Execution infrastructure (dispatch, report back) |
| Multiple agents coordinate | Shared context, governed execution, long-lived collaboration |
| Auth + permissions per agent | Trusted core: auth, permissions, security, audit, lifecycle |
| Heterogeneous runtimes | Plugin integration (local runtimes) + Gateway integration (bot platforms) |

## Detailed borrowings for G4.S7 (studied 2026-08-15)

Avernet's architecture (BCS = Rust Bot Coordination Service; agent → BCS via WebSocket `/ws/bot`):
```
 Local Agent (plugin)   Agent Runtime (/ws/bot)   Bot Platform (gateway)
        │  connect/register/receive/report              ▲
        └──────────────▶ Avernet/BCS ◀──────────────────┘ dispatch/schedule/callback
```

**Borrowable for S7** (S7 stays HTTP+SSE+Tailscale; Avernet's *coordination patterns* transfer, not its WS transport):

1. **Two integration paths** (Avernet: plugin vs gateway) ↔ S7's two agent kinds:
   - **Plugin integration** (agent actively connects: register/onboard/receive/report) ↔ S7 **remote WSL/6900XT agents** (auto-register via plugin).
   - **Gateway integration** (external platform scheduled, reports back) ↔ S7 **OpenCode serve** (downlink).
2. **Registration + discovery + invitation + capability profiles** — S7.T2 builds the invitation flow, and the capability model **already exists** in athena (`AgentCapabilities`: system/mcp[]/tools[]/skills[]/specialty/description + `POST /api/agents/self-declare` + employee review/register). S7 extends it with **api_url/token** for remote reachability — NOT a from-scratch capability system.
3. **Capability-based routing / discovery** — Avernet recommends the right bot by capability profile. S7's Chat routing can pick the agent by its declared specialty/mcp/tools.
4. **Group/session/shared-context collaboration** ↔ S7 Chat routes to a specific agent's *session* (Hermes `/api/sessions/{id}`), i.e. one platform session ↔ one agent session.

## Recommendation

**Adopt as reference / optional enhancement for G4.S7, not a required dependency.** G4.S7's scope is a
lean HTTP+SSE+Tailscale federation for our WSL/6900XT/Hermes agents; Avernet is a heavyweight full
coordination platform. For our scale, implement S7 lean first; revisit Avernet if we later need:
- formal agent identity/auth/permissions/audit at org scale,
- cross-runtime agent discovery + coordination,
- governed long-lived multi-agent collaboration (beyond our kanban/thread model).

Track in G4.S7 as an optional follow-up ("evaluate Avernet vs lean federation").

## Milestone placement

- **Primary**: G4.S7 (remote federation) — reference/evaluation.
- Not M4-critical; does not block S2-S5.
