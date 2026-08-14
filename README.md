# Athena Agent — Team Intelligent Collaboration Portal

> Codename **Athena** (Goddess of Wisdom) · Deployed on the 6900XT team server
> Team repo: [`CALEO-Consulting/caleo.int.athena-agent`](https://github.com/CALEO-Consulting/caleo.int.athena-agent) (private) · Dev mirror: `zouhanhai/athena-agent`

## One-Line Positioning

Provide CALEO a **unified intelligent collaboration portal** for the whole team: each person has
their own intelligent assistant; the team shares conversations, a company-wide **knowledge base**
(self-built RAG + Wiki), and a **git-driven Kanban** — all powered by open-source components, with
cross-machine multi-agent collaboration via a git repo and a **control-plane** model (agents stay
local, the platform routes and coordinates). The KB is the organization's shared knowledge store,
growing across the whole CALEO consultancy.

## Architecture

The knowledge pipeline is **Athena-driven**: a single Athena LLM pass is the source of truth for
structure — it reads each document once and emits headers / topic / chunks / entities / relations /
keywords. Downstream stores (RAG graph, Wiki) consume that output without their own LLM passes.

```
DOCUMENT
  │  docling (layout parse; VLM image descriptions)
  ▼
Athena single-pass refinement (one LLM read): headers + topic + chunks + entities/relations + keywords + quality
  │
  ├──► RAG store (Neo4j 2026 Community, self-built, G4.S2)
  │        vector (HNSW) + BM25 + graph + topic fusion
  │        cross-encoder rerank (llama.cpp BGE-Reranker-v2-M3)
  ├──► Wiki (llm_wiki :19828) — interlinked markdown KB
  └──► Knowledge access (MCP / search_knowledge Agentic RAG, G4.S3)
```

```
SERVER (6900XT) — athena federation hub
  └─ Portal (Vue :5173) ─┬─ Personal/Team chat → backend → OpenRouter (Athena answers, KB-first)
                         ├─ 🕸 Knowledge → Neo4j RAG (:7687) + rerank (:9632) + Wiki (:19828)
                         ├─ 🎫 Kanban    → git-driven board (docs/kanban/) + OpenCode worker serve (:4096)
                         ├─ 🐙 GitHub    → REST (repos/PR/Issue/files)
                         ├─ 📁 CodeGraph → code analysis (OpenCode codegraph)
                         └─ Admin       → employees/permissions/invites
        Server knowledge steward = Athena (fixed federation name)

LOCAL (each employee) — any agent (Hermes / Claude Code / Codex / OpenCode / Pi)
  └─ Agent_i → HTTP + SSE (not WS) → server (control plane; agents stay local, tools run on the employee's machine)

REMOTE (SAP) — per-employee
  └─ PiB_i + ABAP MCP + OpenCode_i → HTTP → server
```

See `docs/distributed-pi-collaboration.md` (3-tier federation) and `docs/knowledge-rag-design.md`.

## Service Stack (6900XT)

| Service                  | Port   | Purpose                                             |
|--------------------------|--------|-----------------------------------------------------|
| athena-backend (Fastify) | 3000   | Portal API + Athena knowledge steward               |
| Vite frontend            | 5173   | Vue3 + TDesign UI                                   |
| Neo4j (self-built RAG)   | 7687/7474 | RAG graph: vector + BM25 + graph + topic         |
| llama-server reranker    | 9632   | cross-encoder BGE-Reranker-v2-M3 (fallback = RRF)   |
| llm_wiki                 | 19828/19827 | interlinked markdown KB (+ clip server)       |
| OpenCode serve           | 4096   | Kanban worker (auto-claim plugin from `.opencode/`) |
| Postgres                 | 5432   | employees, RBAC, Q&A pairs (local socket)           |

Manage all with `scripts/start-all.sh` (idempotent; logs in `~/.athena-tmp/`).

## Development Model (by Goal)

### G1 — Project skeleton + personal conversation
Node/TS + Fastify backend with Pi's AgentSession embedded (one long-lived, isolated session per
employee). Vue3 + TDesign frontend with the CALEO theme (orange `#ff6633`, dark/light toggle, sidebar).
Personal chat end-to-end: frontend → backend → AgentSession → OpenRouter → answer.

### G2 — Knowledge base
docling parses documents (PDFs incl. VLM image descriptions); an **Athena single-pass refinement**
re-levels headers, judges topic, and extracts chunks/entities/relations/keywords once (no repeated LLM
passes). Downstream: llm_wiki (interlinked markdown KB) + retrieval routing.

### G3 — Multi-agent federation + team workbench
Agent registry (PG: alias/owner/logo/capabilities/MCP), employee identity + RBAC + per-user GitHub
credentials, a global shared Chat panel, a GitHub-style Workbench (Code / Issues / Project tabs — the
GitHub Project panel is the only board view), and an Uploads page (per-system ingest stages + chunk
progress). Git-driven development protocol (worker-agnostic 6-role lifecycle).

### G4 — KB intelligence, RAG self-build & agent collaboration
- **Kanban = git repo** — `docs/kanban/` (Goals → Specs → Tickets) is the source of truth; agents
  write tickets directly. GDD = md (source) + md↔GitHub sync + Progress Log/stalled (md-level).
- **Auto-claim plugin** (G4.S4) — an OpenCode plugin auto-claims on a worker's first tool call
  (status/assignee/session_id + claim row, one commit) and appends **Progress Log** rows (real UTC).
  Workers never manually claim. Plugin deploys from the GLOBAL opencode dir (`~/.config/opencode/plugins/`).
- **Worker progress** is readable from the ticket file (last Progress Log row → the plan agent reads
  the md locally to detect stalled workers).
- **AGENTS.md** is the worker protocol; `docs/kanban/TICKET-WORKFLOW.md` is the full workflow.
- **RAG self-build** (G4.S2): Neo4j 2026 lean store replaces LightRAG — vector + BM25 + graph + topic
  fusion, cross-encoder rerank, case-insensitive node lookup.
- **Agentic RAG** (G4.S3): `search_knowledge` into Athena chat — QA-pair reuse, term expansion,
  multi-hop graph reasoning, not-found → web fallback, clarify only when genuinely needed.

## Progress (git-driven kanban)

Work is tracked as Goals in `docs/kanban/` (each Goal → Specs → Tickets), the source of truth.

| Goal | Status | Progress |
|------|--------|----------|
| **G1** Project skeleton + personal conversation | ✅ DONE | M1 — skeleton + AgentSession personal chat |
| **G2** Knowledge base | ✅ DONE | M2 — docling ingestion, retrieval routing, graph + wiki |
| **G3** Multi-agent federation + team workbench | ✅ DONE | agent registry, RBAC, chat, workbench, uploads, git-driven dev |
| **G4** KB intelligence + RAG self-build + collaboration | 🔄 | S1 refinement ✅ · S2 Neo4j RAG ✅ · S3 agentic RAG ✅ · S4 worker progress ✅ · **S5 Kanban↔Issues (next)** · S6 GDD decoupling · S7 federation |
| **G5** Output page | planned | txt/blog/charts/pptx/html |
| **G6** Remote federation + A2A | planned | agents as peers, MCP-first KB access |

## Testing

```bash
cd server && npm test          # node:test unit + integration (930+)
cd web && npx vitest run       # Vue component tests (438+)
cd web && npx vue-tsc --noEmit # typecheck
cd gdd && npm test             # GDD protocol/sync tests (199+)
cd gdd/plugin && npm test      # opencode worker plugin tests
```

**Authoritative verification is on the 6900XT** (the local WSL web test env is often polluted and
reports false failures).

## Key Risks / Open Items

- **Resend auth**: caleo.com domain must be verified before sending invites to employees (403 until
  then; ConsoleMailer logs links to `~/.athena-tmp/athena-server.log`).
- **Tailscale**: portal is LAN-only (192.168.178.30) until the 6900XT is Tailscale'd + `APP_BASE_URL`
  points at the Tailscale IP, so remote colleagues can reach it.
- **Neo4j** Community Edition (2026): SEARCH clause LIMIT must be inside the vector-index parens
  (`FOR $embedding LIMIT 1`), not after — otherwise Cypher syntax error.

## Docs Index

- `gdd/` — the **GDD package** (G4.S6.T3): kanban protocol/sync modules, `sync-github` CLI
  (`gdd sync-github create <spec>`), git hooks (`gdd/hooks/`), opencode plugins (`gdd/plugin/`) and
  GST templates (`gdd/templates/`) — runs standalone on the user's local machine with just a GitHub
  token (`gh auth token` / `GITHUB_TOKEN`). athena only views GitHub; GDD never imports athena.
- `gdd/docs/` — the **GDD handbook**: [`README.md`](gdd/README.md) (what GDD is + boundary vs
  athena), [`design.md`](gdd/docs/design.md) (git-driven Kanban design: claim lock, Progress Log,
  state machines), [`protocol-review.md`](gdd/docs/protocol-review.md) (the GDD design decision
  record), [`setup.md`](gdd/docs/setup.md) (enable GDD on a new project), [`backend.md`](gdd/docs/backend.md)
  (gdd package modules + sync-github CLI), [`plugins.md`](gdd/docs/plugins.md) (opencode plugins),
  [`reference.md`](gdd/docs/reference.md) (concept index), [`adr/`](gdd/docs/adr/0009-gdd-vs-athena-boundary.md) (GDD boundary decision)
- `docs/knowledge-rag-design.md` — KB + RAG routing (Athena single-pass, Neo4j, fusion, rerank)
- `docs/distributed-pi-collaboration.md` — Multi-Agent Federation (control plane, HTTP+SSE)
- `docs/spec-m4-*.md` — G4 specs (refinement, RAG self-build, KB confidence, worker progress, kanban-issues sync)
- `CONTEXT.md` — global glossary (ubiquitous language)
- `TODO.md` — high-level roadmap
