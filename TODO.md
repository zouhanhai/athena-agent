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

### M2 — Knowledge Base (G2) — 5 specs planned
- [ ] G2.S1 LightRAG service deployment (DeepSeek + Postgres + pgvector)
- [ ] G2.S2 llm_wiki service deployment (Rust compile + headless :19828)
- [ ] G2.S3 Knowledge access layer + Pi retrieval routing (docling + dual pipeline + MCP)
- [ ] G2.S4 Frontend knowledge panels (graph iframe + Wiki browse)
- [ ] G2.S5 Data/document input interface (upload + URL + docling + progress bar)

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

---

## Recent Changes
- 2026-08-05: M1 complete, G2 (M2) planned (5 specs), repo synced to CALEO org
- 2026-08-05: Full project i18n (docs + comments + tests), logo cleanup
