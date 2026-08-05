# Athena Agent — Team Intelligent Collaboration Portal

> Codename **Athena** (Goddess of Wisdom) · Deployed on the 6900XT team server
> Team repo: [`CALEO-Consulting/caleo.int.athena-agent`](https://github.com/CALEO-Consulting/caleo.int.athena-agent) (private) · Dev mirror: `zouhanhai/athena-agent`
> This document is the output of the grill-with-docs process, capturing all confirmed architectural decisions.

## One-Line Positioning

Provide the 3 employees of the CALEO department with a **unified collaboration portal**: each person has their own Pi intelligent assistant; the team shares conversations / knowledge graph / Wiki / Kanban, all powered by open-source components (Pi + LightRAG + LLM Wiki + CodeGraph) underneath.

## Confirmed Decisions (ADR numbers in `docs/adr/`)

| #  | Decision            | Details                                                               |
|----|---------------------|-----------------------------------------------------------------------|
| 1  | Deployment target   | 6900XT Ubuntu, Tailscale networking (employees in Germany)            |
| 2  | Authentication      | Email magic link (Resend key verified; caleo.com domain configuration needed) |
| 3  | Backend             | Node/TS + Fastify + AgentSession embedding Pi                         |
| 4  | Frontend            | Vue3 + TDesign, referencing WeKnora layout, CALEO orange (#ff6633)    |
| 5  | Database            | Postgres + pgvector (vectors); graph = LightRAG NetworkX (POC)        |
| 6  | Conversation model  | OpenRouter unified (deepseek/deepseek-v4-flash main; qwen/qwen3.7-flash vision; qwen/qwen3-embedding-8b embedding) |
| 7  | Knowledge retrieval | LightRAG (retrieval + graph, with built-in UI)                        |
| 8  | Wiki accumulation   | llm_wiki service (:19828 API + MCP), custom CALEO-style frontend      |
| 9  | Kanban              | TS rewrite, Pi-driven (pi-task/glla/dynamic-workflows)                |
| 10 | Development mode    | Local Hermes TUI + 6900XT OpenCode headless                           |
| 11 | Dialogue structure  | Personal = independent AgentSession; team = shared Pi (ultimate goal Plan B: Pi can speak) |
| 12 | Pi extensions       | mcp-adapter/intercom/pi-task/glla/dynamic-workflows/hermes-memory/web-access |

## System Architecture

```
SERVER (company server; 6900XT today) — athena federation hub
  └─ Portal (Vue) ─┬─ Personal conv → backend → AgentSession (Pi) → OpenRouter
                   ├─ Team conv     → backend → Shared AgentSession (Pi)
                   ├─ 📚 Wiki       → llm_wiki (:19828) → Vue rendering
                   ├─ 🕸 Knowledge  → LightRAG (:9621) graph + retrieval
                   ├─ 🐙 GitHub     → GitHub REST API (repos/PR/Issue/files)
                   ├─ 📁 CodeGraph  → code analysis
                   └─ 🎫 Kanban     → Pi-driven task flow + GitHub
        Server knowledge steward = Athena (fixed name)

LOCAL (each employee PC) — any agent (Hermes / Claude Code / Codex / Pi)
  └─ Local agent_i + OpenCode_i → LAN/HTTP → server

REMOTE (SAP server) — per-employee
  └─ PiB_i + ABAP MCP + OpenCode_i → HTTP → server

See docs/distributed-pi-collaboration.md (Multi-Agent Federation).
```

## Port Plan

| Service                | Port   | Bind                  |
|------------------------|--------|-----------------------|
| llama-server (Qwythos) | 8080   | 127.0.0.1 (must change to 0.0.0.0) |
| LightRAG               | 9621   | 0.0.0.0               |
| llm_wiki               | 19828  | 0.0.0.0 (headless, Xvfb) |
| llm_wiki clip server  | 19827  | 0.0.0.0 (headless, Xvfb) |
| Portal backend (Fastify)| Main   | 0.0.0.0               |
| Portal frontend (Vue)  | TBD    | 0.0.0.0               |

## Directory Structure

```
athena-agent/
├── CONTEXT.md            # Global glossary (ubiquitous language)
├── TODO.md               # High-level roadmap (done / in progress / planned)
├── docs/
│   ├── adr/                      # Architecture Decision Records (one per file)
│   ├── git-kanban-design.md      # git-driven Kanban design
│   ├── knowledge-rag-design.md   # Knowledge base & RAG routing design
│   ├── distributed-pi-collaboration.md # Multi-Agent Federation design
│   ├── output-design.md          # Output page design (NotebookLM-style)
│   ├── pi-capabilities.md        # Pi capabilities & Package mapping
│   └── kanban/                   # Goals → Specs → Tickets (git-driven board)
│       ├── G1/ (S1, S2)          # M1: skeleton + personal conversation (DONE)
│       └── G2/ (S1..S5)          # M2: knowledge base (S1/S2/S3 done, S4/S5 in progress)
├── server/           # Node/TS Fastify backend
│   ├── src/
│   │   ├── agents/   # AgentSession management
│   │   ├── routes/   # API routes
│   │   ├── kb/       # Knowledge service clients (LightRAG/llm_wiki)
│   │   └── kanban/   # Pi-driven Kanban
│   └── ...
├── web/              # Vue3 + TDesign frontend
├── deploy/           # Deployment config (6900XT)
└── README.md
```

## Milestones (MVP Order)

Each Milestone has explicit acceptance criteria (Definition of Done); all corresponding Goals must be complete for it to be considered done.

1. **M1** ✅ DONE: Project skeleton + AgentSession personal conversation
   - Acceptance: Node/TS backend starts; AgentSession embeds Pi successfully; personal conversation end-to-end works (frontend → backend → Pi → answer); Vue frontend has sidebar skeleton
   - Corresponds to: G1 (Project skeleton + AgentSession) — G1/S1 + G1/S2 complete

2. **M2** 🔄 IN PROGRESS: Knowledge Graph (LightRAG) + Wiki (llm_wiki)
   - Acceptance: LightRAG starts (OpenRouter); llm_wiki runs headless :19828; Pi retrieves from both via MCP; graph panel 2D renders; docling unified ingestion + progress bar
   - Corresponds to: G2 (LightRAG + llm_wiki) — G2.S1/S2/S3 complete, S4/S5 in progress

3. **M3**: Pi-driven Kanban + Team Conversation + GitHub Integration
   - Acceptance: git-driven kanban works (Goal create / claim lock / PR / Reject); 3 employees can claim tickets in parallel; team conversation shares Pi; pi-intercom coordinates; **GitHub integration: portal can browse repos / PRs / Issues / files via GitHub REST API**
   - Corresponds to: G3 (Pi Kanban + Team Conversation + GitHub)

4. **M4**: CodeGraph + Multi-Employee Isolation + Deploy to 6900XT
   - Acceptance: CodeGraph deployed and indexing code; 3 employees have independent git identities + independent AgentSessions; portal deployed on 6900XT accessible via Tailscale; auth (Resend) functional
   - Corresponds to: G4 (CodeGraph + Multi-Employee Isolation + Deployment)

5. **M5**: Output Page (txt/blog/charts/pptx/html) — implement after core is working
   - Acceptance: Generate txt/blog/charts from knowledge base + web sources; pptx/html generation functional; frontend preview + download
   - Corresponds to: G5 (Output Page)

6. **M6**: Multi-Agent Federation (local agent + remote SAP integration)
   - Acceptance: local agents (Hermes etc.) integrate into the federation (joinable in chat); remote SAP PiB_i per-employee with HTTP endpoint; agent naming convention (`{employee}::{agent}`, server steward `Athena`); conversation routing across the 3 tiers
   - Reference: docs/distributed-pi-collaboration.md

## Testing

Backend tests live under `server/`, based on `node:test` (no additional test framework needed):

```bash
cd server
npm test            # unit + integration + E2E conversation tests
npm run typecheck   # type checking (tsc --noEmit)
```

Coverage:

- Unit/Integration: AgentSession creation and conversation, AgentManager session management (reuse / isolation / teardown), POST /api/chat streaming + non-streaming
- E2E (`test/e2e-conversation.test.ts`): Real OpenRouter end-to-end — single message, multi-turn context (same userId reuses session), different userId context isolation, error handling (empty message / invalid fields / conversation service not started)
- Real conversation test cases require `~/.pi/agent/auth.json` (OpenRouter key)

## Key Risks

- Resend test mode can only send to self; must verify caleo.com domain before sending to employees
- LightRAG NetworkX is fine for POC; at scale Neo4j may be needed

## Open Items (to be confirmed later)

- CodeGraph specific deployment approach
- Portal frontend/backend specific ports (Vite dev :5173, backend :3000)
- Resend domain verification (caleo.com)
- Future: migrate from 6900XT to a company server (see Multi-Agent Federation)
