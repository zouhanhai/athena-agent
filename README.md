# Athena Agent — Team Intelligent Collaboration Portal

> Codename **Athena** (Goddess of Wisdom) · Deployed on the 6900XT team server
> Team repo: [`CALEO-Consulting/caleo.int.athena-agent`](https://github.com/CALEO-Consulting/caleo.int.athena-agent) (private) · Dev mirror: `zouhanhai/athena-agent`

## One-Line Positioning

Provide the 3 employees of the CALEO department a **unified collaboration portal**: each person has
their own intelligent assistant; the team shares conversations, a **knowledge base** (self-built RAG +
Wiki), and a **git-driven Kanban** — all powered by open-source components, with cross-machine
multi-agent collaboration via a git repo and a **control-plane** model (agents stay local, the platform
routes and coordinates).

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

## Development Model (G4)

- **Kanban = git repo** — `docs/kanban/` (Goals → Specs → Tickets) is the source of truth; agents
  write tickets directly.
- **Auto-claim plugin** (G4.S4) — an OpenCode plugin auto-claims on a worker's first tool call
  (status/assignee/session_id + kanban-index regen, one commit), appends **Progress Log** rows (real
  UTC), and on `done` regenerates + commits the index as a **separate commit** (`session.idle` event).
  Workers never manually claim. Plugin deploys from the GLOBAL opencode dir (`~/.config/opencode/plugins/`).
- **Worker progress** is readable from the ticket file (last Progress Log row → "updated Xs ago" +
  stalled flag on the Kanban board).
- **AGENTS.md** is the worker protocol; `docs/kanban/TICKET-WORKFLOW.md` is the full workflow.

## Milestones

| Milestone | Status | Scope |
|-----------|--------|-------|
| **M1** Project skeleton + personal conversation (G1) | ✅ DONE | Node/TS + Fastify + AgentSession, Vue3 + CALEO theme |
| **M2** Knowledge base (G2) | ✅ DONE | docling ingestion, retrieval routing, graph + wiki panels |
| **M3** Multi-agent federation + team workbench (G3) | 🔄 | agent registry, RBAC, chat panel, workbench, uploads, git-driven dev |
| **M4** KB intelligence + RAG self-build + collaboration (G4) | 🔄 | S1 refinement ✅, S2 Neo4j RAG ✅, S3 agentic RAG ✅, S4 worker progress ✅, S5 Kanban↔Issues, S6 federation |
| **M5** Output page (txt/blog/charts/pptx/html) | planned | — |
| **M6** Remote agent federation + A2A | planned | agents chat as peers, MCP-first KB access |

## Testing

```bash
cd server && npm test          # node:test unit + integration (930+)
cd web && npx vitest run       # Vue component tests (438+)
cd web && npx vue-tsc --noEmit # typecheck
cd opencode-plugin && npx -y tsx --test 'test/**/*.test.ts'  # plugin tests (22)
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

- `docs/git-kanban-design.md` — git-driven Kanban design (claim lock, Progress Log, done double-commit)
- `docs/knowledge-rag-design.md` — KB + RAG routing (Athena single-pass, Neo4j, fusion, rerank)
- `docs/distributed-pi-collaboration.md` — Multi-Agent Federation (control plane, HTTP+SSE)
- `docs/spec-m4-*.md` — G4 specs (refinement, RAG self-build, KB confidence, worker progress, kanban-issues sync)
- `CONTEXT.md` — global glossary (ubiquitous language)
- `TODO.md` — high-level roadmap
