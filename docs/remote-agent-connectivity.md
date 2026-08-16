# Remote agent connectivity — Tailscale vs Cloudflare Tunnel vs reverse WebSocket

**Status**: research note for G4.S7 (2026-08-15).
**Decided direction**: agent **actively connects INTO the platform** (outbound, reverse-tunnel style),
WebSocket for bidirectional real-time. Below is the full analysis + industry references.

## The problem

G4.S7 lets the athena platform (6900XT, LAN 192.168.178.30) drive remote local agents (remote WSL/wts,
no admin, behind Vodafone DS-Lite/CGNAT — no public IPv4). The platform must be able to (a) reach each
agent and (b) communicate bidirectionally (send commands, stream results).

## Connectivity options compared

| Option | Type | Needs public IP? | Needs admin? | Direction | Address | SSE | Notes |
|---|---|---|---|---|---|---|---|
| **Tailscale** | Mesh VPN (WireGuard) | No | Yes (install client per device) | Bidirectional (device↔device) | private 100.x IP | native | remote wts has no admin → can't install |
| **Cloudflare Tunnel (named)** | outbound reverse tunnel | No | No (user-level cloudflared) | one-way outbound + clients reach public URL | public URL (your domain) | full (named) | free + a domain; quick tunnel has 200-conc + SSE limits |
| **reverse WebSocket** | agent connects INTO platform WS server | No | No (agent runs user-level client) | **bidirectional** (agent connects, platform drives back) | platform WS endpoint | n/a (WS is bidirectional) | **chosen** — matches AgentIDE: agents register into platform |

## Decided architecture (reverse WebSocket)

```
 remote agent ──outbound WS──▶ Cloudflare / platform WS server ──▶ athena platform (6900XT)
      ▲                                                              │
      └──────── bidirectional (platform pushes tasks, agent streams back) ──┘
```

- Agent **actively connects outbound** to the platform's WebSocket endpoint (works behind NAT/CGNAT, no
  public IP, no admin).
- Platform **drives the agent back through that tunnel** (push tasks, stream tool progress).
- Agent registers on connect with `{agent_id, capabilities, token}` (mirrors Avernet/K3s/OpenClaw).
- Platform exposes the WS endpoint publicly via Cloudflare Tunnel (named) so agents can reach it from
  anywhere.

## Why not Tailscale (for remote wts)

- Tailscale needs a client installed on every device. The remote wts has **no admin**, so it can't
  install Tailscale.
- Cloudflare Tunnel (cloudflared) is a user-level binary → installable. reverse WebSocket only needs the
  agent to run a client → also fine.

## Industry references (all use agent-outbound reverse-tunnel / register-into-plane)

> **Borrowing scope (2026-08-15):** we reference Helix mainly for its **remote-agent ↔ platform connection
> model** (reverse WebSocket tunnel: agent connects outbound, platform drives it back). Other directions
> (invitation onboarding, KB-as-MCP, chat routing, capabilities) are already defined in the G4.S7 spec.

- **Helix** (helixml/helix, Go): Runners connect to the control plane via **reverse WebSocket tunneling**
  — runner initiates outbound connection, control plane sends requests back through the tunnel. Works
  behind NAT/firewalls, no exposed ports. **(This is the connectivity model we borrow.)**
- **Avernet** (inclusionAI/Avernet, Rust BCS): agents register/connect to BCS via WebSocket `/ws/bot`,
  then receive messages and report results; capability profiles for discovery. (github.com/inclusionAI/Avernet)
- **K3s**: agent nodes register with the server via WebSocket initiated by the k3s agent process, keep a
  stable connection.
- **OpenClaw RFC #42026**: agent runtimes register on startup with agent ID + capabilities; bidirectional
  streaming (gRPC/WebSocket); control plane routes inbound/cron/agent-to-agent.
- **AWS Bedrock AgentCore**: WebSocket `/ws` endpoint on port 8080, persistent bidirectional streaming,
  session routing.

## Cloudflare Tunnel price (named)

- Cloudflare Tunnel is **free** for all plans (part of Zero Trust; free tier covers 50 seats).
- Only cost: a domain ($8–15/yr) hosted on Cloudflare.
- named tunnel removes quick-tunnel's 200-concurrent + SSE limitations; supports SSE fully.

## Decisions for G4.S7

1. Agent **connects INTO** the platform (reverse WS), not platform→agent per-agent tunnels.
2. **WebSocket** for bidirectional real-time; HTTP for registration/commands.
3. Platform exposes the WS endpoint publicly (Cloudflare named tunnel + a domain, or Tailscale once
   feasible).
4. Agent registers with `{agent_id, capabilities, token}` (already modeled in AgentCapabilities).

## Status (2026-08-15, G4.S7.T1)

- Platform WS endpoint **live**: `wss://athenakb.com/ws/agent` (reverse-WebSocket endpoint on the
  athena server, welcome handshake + echo/ping frames; registration + bidirectional streaming in T2/T4).
- Cloudflare exposure **live**: named tunnel `athena-platform` (`/home/hh/.cloudflared/config.yml`,
  systemd `cloudflared-athenakb`) routes `athenakb.com/ws/*` → `http://localhost:3000`; the frontend
  (`athenakb.com` → Vite :5173) keeps working. Verified reachable from outside the LAN.
- See `docs/s7-remote-agent-setup.md` §1.3 for the config + verification commands.

## Status (2026-08-16, G4.S7.T2/T4)

- **Bidirectional reverse-WS (T4) DONE**: agents register auth'd on connect `{agent_id, token}`
  (registry `verifyCredentials` + `markReachable` → status `reachable` + `connected` flag via
  `GET /api/agents`). The platform pushes tasks THROUGH the live tunnel (`AgentWsGateway.sendTask`,
  Hermes `chat.completions` payload); the agent streams back `tool.started`/`tool.completed` +
  text `delta` + optional `thinking` tokens, relayed as SSE `{tool}`/`{thinking}`/`{delta}` frames
  into the Chat panel. Reconnects supersede the old tunnel; disconnects fail in-flight tasks.
- **Chat routing**: `POST /api/chat` with `{agent_id}` routes the message to the selected connected
  agent over its tunnel (SSE streaming + non-streaming collect; offline agent → SSE offline error).
- **Agent template**: `server/scripts/agent-client.ts` — the remote agent connects outbound, registers,
  runs its LOCAL `/v1/chat/completions` and relays reasoning→thinking + content→delta, auto-reconnects.
  Works behind NAT/CGNAT, no public IP, no admin.
- **Verified live on 6900XT**: 15/15 checks (register→reachable/connected, task push→thinking/tool/
  delta/complete relayed in chat SSE, reconnect, invalid-token rejection). A2A (JSON-RPC task/artifact)
  deferred to M6 — see `server/src/ws/agent.ts` protocol boundary.
