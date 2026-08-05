# Athena Agent — Project TODO

> Git-driven development board. Also tracked in `docs/kanban/` (Goals/Specs/Tickets).
> This file is a high-level roadmap of what is done and what comes next.

## Status Legend
- [x] Done
- [ ] In progress / planned

---

## Completed

### M1 — Project Skeleton + Personal Conversation (G1)
- [x] Backend: Node/TS + Fastify + AgentSession embedding Pi
- [x] Personal conversation E2E (frontend → backend → Pi → answer)
- [x] Frontend: Vue3 + TDesign + CALEO theme + sidebar
- [x] Deep/Light theme toggle, CALEO + Athena owl logos, settings panel
- [x] All docs/comments/errors translated to English
- [x] Repo synced to `CALEO-Consulting/caleo.int.athena-agent` (private)

## In Progress

### M2 — Knowledge Base (G2) — 5 specs
- [x] G2.S1 LightRAG service deployment (OpenRouter deepseek-v4-flash + qwen3-embedding-8b + Postgres/pgvector)
- [x] G2.S2 llm_wiki service deployment (Rust compile + headless :19828)
- [x] G2.S3 Knowledge access layer + Pi retrieval routing (dual pipeline + 5 knowledge tools + capability routing, Pi→OpenRouter)
- [ ] G2.S4 Frontend knowledge panels (2D graph + Wiki tree, 4 tickets)
- [ ] G2.S5 Data/document input interface (docling + Add Data in Knowledge panel, 4 tickets)

## Planned

### M3 — Pi-Driven Kanban + Team Conversation + GitHub Integration (G3)
- [ ] GitHub integration: backend API layer (repos/PR/Issue/file tree/content)
- [ ] GitHub panel: frontend Vue UI (CALEO style) to browse repos/PR/Issue/files
- [ ] Pi-driven Kanban: backend logic (Goal create / claim lock / state flow)
- [ ] Kanban panel: frontend board UI
- [ ] Team conversation: shared Pi (AgentSession)
- [ ] 3 employees claim tickets in parallel (pi-intercom coordination)

### M4 — CodeGraph + Multi-Employee Isolation + Deploy 6900XT
- [ ] CodeGraph deployed and indexing code
- [ ] 3 employees independent git identities + independent AgentSessions
- [ ] Portal deployed on 6900XT via Tailscale
- [ ] Auth (Resend magic link) functional

### M5 — Output Page (txt/blog/charts/pptx/html)
- [ ] Generate txt/blog/charts from knowledge base + web sources
- [ ] pptx/html generation functional
- [ ] Frontend preview + download

### M6 — Multi-Agent Federation (local agent + remote SAP integration)
- [ ] Integrate local agents (e.g. local Hermes) into the athena federation (via LAN, joinable in chat)
- [ ] Remote SAP PiB_i per-employee + HTTP endpoint connecting to athena server
- [ ] Agent naming convention: fixed names in the server (see Naming Convention below)
- [ ] Conversation routing among the 3 agent tiers (local / server Athena / remote SAP)

## Naming Convention (Agent identity in the federation)

Every agent appearing in the server has a **fixed, namespaced name**:

- **Server knowledge steward** = named **`Athena`** (the server-side knowledge assistant).
- **Each employee's personal agent** = `{employee-name}-prefix` + agent name:
  e.g. `{First}.{Last}::{agent}` — employee prefix first, agent name follows.
- Any agent in the federation is uniquely identifiable by this fixed name.

Examples:
```
Athena                          # server knowledge steward
zhang.wei::Hermes               # employee zhang.wei's local Hermes
zhang.wei::PiB                  # employee zhang.wei's remote SAP Pi
li.na::OpenCode                 # employee li.na's local OpenCode
```

## Architecture Reference

- `docs/distributed-pi-collaboration.md` — Multi-Agent Federation design (3-tier: server / local / remote SAP)

---

## Recent Changes
- 2026-08-05: M1 complete, G2 (M2) planned (5 specs), repo synced to CALEO org
- 2026-08-05: Full project i18n (docs + comments + tests), logo cleanup
- 2026-08-05: G2.S1/S2/S3 done (knowledge services + access layer + Pi→OpenRouter), S4/S5 tickets split
- 2026-08-05: Multi-Agent Federation design recorded; M6 added (local agent + remote SAP + naming convention)
