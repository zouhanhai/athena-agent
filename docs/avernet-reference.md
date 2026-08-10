# Avernet — reference for G4.S6 (remote agent federation)

**Source**: https://github.com/inclusionAI/Avernet (Apache-2.0, 387★)
**Discovered**: 2026-08-10 (user). Placed in G4.S6 as a reference/optional enhancement.

## What it is

**Avernet is an open-source infrastructure layer for building and operating persistent, coordinated,
multi-agent systems at organizational scale** — "where agents live, connect, coordinate, execute, and
evolve together." Production-tested at Ant Group: multi-agent deployments across 12 business groups,
90%+ task completion rate in measured multi-agent workflows.

## Relevance to G4.S6 (remote agent federation)

G4.S6 builds a control plane where remote agents (WSL, LAN 6900XT, local Hermes) register and are driven
over HTTP+SSE + Tailscale. Avernet provides a production-grade version of the same coordination concern:

| G4.S6 need | Avernet capability |
|-----------|-------------------|
| Remote agents register + connect | Identity / onboarding / registration |
| Control plane drives agents | Execution infrastructure (dispatch, report back) |
| Multiple agents coordinate | Shared context, governed execution, long-lived collaboration |
| Auth + permissions per agent | Trusted core: auth, permissions, security, audit, lifecycle |
| Heterogeneous runtimes | Plugin integration (local runtimes) + Gateway integration (bot platforms) |

## Recommendation

**Adopt as reference / optional enhancement for G4.S6, not a required dependency.** G4.S6's scope is a
lean HTTP+SSE+Tailscale federation for our WSL/6900XT/Hermes agents; Avernet is a heavyweight full
coordination platform. For our scale, implement S6 lean first; revisit Avernet if we later need:
- formal agent identity/auth/permissions/audit at org scale,
- cross-runtime agent discovery + coordination,
- governed long-lived multi-agent collaboration (beyond our kanban/thread model).

Track in G4.S6 as an optional follow-up ("evaluate Avernet vs lean federation").

## Milestone placement

- **Primary**: G4.S6 (remote federation) — reference/evaluation.
- Not M4-critical; does not block S2-S5.
