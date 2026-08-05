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
| 6  | Conversation model  | DeepSeek (conversation) + Qwythos MTP (local/vision, :8080)           |
| 7  | Knowledge retrieval | LightRAG (retrieval + graph, with built-in UI)                        |
| 8  | Wiki accumulation   | llm_wiki service (:19828 API + MCP), custom CALEO-style frontend      |
| 9  | Kanban              | TS rewrite, Pi-driven (pi-task/glla/dynamic-workflows)                |
| 10 | Development mode    | Local Hermes TUI + 6900XT OpenCode headless                           |
| 11 | Dialogue structure  | Personal = independent AgentSession; team = shared Pi (ultimate goal Plan B: Pi can speak) |
| 12 | Pi extensions       | mcp-adapter/intercom/pi-task/glla/dynamic-workflows/hermes-memory/web-access |

## System Architecture

```
Employee browser → Tailscale → 6900XT Portal (Vue frontend)
  │
  ├─ 💬 Personal conv  → Portal backend → AgentSession (Pi) → DeepSeek/Qwythos
  ├─ 👥 Team conv      → Portal backend → Shared AgentSession (Pi)
  ├─ 📚 Wiki           → Portal backend → llm_wiki (:19828) → markdown → Vue rendering
  ├─ 🕸 Graph          → iframe embed LightRAG built-in graph UI
  ├─ 🐙 GitHub         → Portal backend → GitHub REST API (repos/PR/Issue/files) → Vue GitHub panel
  ├─ 📁 CodeGraph      → Deployed on 6900XT → code analysis
  └─ 🎫 Kanban         → Portal backend → Pi-driven task flow (TS) + GitHub PR/Issue
       ├─ pi-task (task decomposition)
       ├─ pi-goal-list-loop-audit (audit & acceptance)
       └─ pi-dynamic-workflows (parallel execution)
```

## Port Plan

| Service                | Port   | Bind                  |
|------------------------|--------|-----------------------|
| llama-server (Qwythos) | 8080   | 127.0.0.1 (must change to 0.0.0.0) |
| LightRAG               | 9621   | 0.0.0.0               |
| llm_wiki               | 19828  | 127.0.0.1 (must change to 0.0.0.0) |
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
│   ├── output-design.md          # Output page design (NotebookLM-style)
│   ├── pi-capabilities.md        # Pi capabilities & Package mapping
│   └── kanban/                   # Goals → Specs → Tickets (git-driven board)
│       ├── G1/ (S1, S2)          # M1: skeleton + personal conversation (DONE)
│       └── G2/ (S1..S5)          # M2: knowledge base (planned)
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
   - Acceptance: LightRAG starts with DeepSeek+Postgres; llm_wiki runs headless serving :19828; Pi can retrieve from both systems via MCP; graph panel iframe displays; docling unified ingestion + progress bar
   - Corresponds to: G2 (LightRAG + llm_wiki) — 5 specs planned (S1..S5)

3. **M3**: Pi-driven Kanban + Team Conversation + GitHub Integration
   - Acceptance: git-driven kanban works (Goal create / claim lock / PR / Reject); 3 employees can claim tickets in parallel; team conversation shares Pi; pi-intercom coordinates; **GitHub integration: portal can browse repos / PRs / Issues / files via GitHub REST API**
   - Corresponds to: G3 (Pi Kanban + Team Conversation + GitHub)

4. **M4**: CodeGraph + Multi-Employee Isolation + Deploy to 6900XT
   - Acceptance: CodeGraph deployed and indexing code; 3 employees have independent git identities + independent AgentSessions; portal deployed on 6900XT accessible via Tailscale; auth (Resend) functional
   - Corresponds to: G4 (CodeGraph + Multi-Employee Isolation + Deployment)

5. **M5**: Output Page (txt/blog/charts/pptx/html) — implement after core is working
   - Acceptance: Generate txt/blog/charts from knowledge base + web sources; pptx/html generation functional; frontend preview + download
   - Corresponds to: G5 (Output Page)

## Testing

Backend tests live under `server/`, based on `node:test` (no additional test framework needed):

```bash
cd server
npm test            # unit + integration + E2E conversation tests
npm run typecheck   # type checking (tsc --noEmit)
```

Coverage:

- Unit/Integration: AgentSession creation and conversation, AgentManager session management (reuse / isolation / teardown), POST /api/chat streaming + non-streaming
- E2E (`test/e2e-conversation.test.ts`): Real DeepSeek end-to-end — single message, multi-turn context (same userId reuses session), different userId context isolation, error handling (empty message / invalid fields / conversation service not started)
- Real conversation test cases require `~/.pi/agent/auth.json` (DeepSeek key)

## Key Risks

- llm_wiki is a Tauri desktop app; must verify it can run headless (Xvfb is available) and serve its API
- Service binds must be changed from 127.0.0.1 to 0.0.0.0 for Tailscale access
- Resend test mode can only send to self; must verify caleo.com domain before sending to employees
- LightRAG NetworkX is fine for POC; at scale Neo4j may be needed

## Open Items (to be confirmed later)

- CodeGraph specific deployment approach
- Portal frontend/backend specific ports
- Resend domain verification
- llm_wiki headless feasibility verification
