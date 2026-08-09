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

### M2 — Knowledge Base (G2) — 5 specs
- [x] G2.S1 LightRAG service deployment (OpenRouter deepseek-v4-flash + qwen3-embedding-8b + Postgres/pgvector)
- [x] G2.S2 llm_wiki service deployment (Rust compile + headless :19828)
- [x] G2.S3 Knowledge access layer + Pi retrieval routing (dual pipeline + 5 knowledge tools + capability routing, Pi→OpenRouter)
- [x] G2.S4 Frontend knowledge panels (2D graph + Wiki tree, 4 tickets)
- [x] G2.S5 Data/document input interface (docling + Add Data in Knowledge panel, 14 tickets)

## In Progress

### M3 — Multi-Agent Federation & Team Workbench (G3) — 6 specs, 22 tickets
- [ ] G3.S1 Agent Registry (agents declare alias/owner/logo/capabilities/MCP, PG)
- [ ] G3.S2 Employee Identity + RBAC + GitHub credentials (email login, logo, per-user credential encrypted)
- [ ] G3.S3 Global Chat panel (right-side fixed, single shared context, agent cards + add agent/employee)
- [ ] G3.S4 Workbench (GitHub-style Code / Issues / Kanban tabs, per-user credential)
- [ ] G3.S5 Uploads page (detailed per-system ingest stages + chunk progress, real LightRAG status)
  - S5.T5: show source images in llm_wiki pages (export via --images-dir + copy beside page + serve to frontend); LightRAG stays pure text. docling `picture_area_threshold` lowered to 0.01 (small images get VLM desc). Long docs get heading anchors + table of contents (markdown-it-anchor / markdown-it-table-of-contents) — see docs/knowledge-rag-design.md §2.1.2
- [ ] G3.S6 Git-Driven Development (worker-agnostic protocol + 6-role lifecycle + GitHub full ops)

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
  - Tailscale the 6900XT, then set `APP_BASE_URL` to the Tailscale IP so remote colleagues can reach the portal + open invite/magic-link URLs (currently LAN-only 192.168.178.30; remote access blocked until this is done — see `docs/deployment-config.md`)
- [ ] Auth (Resend magic link) functional
  - Requires verifying `caleo.com` domain in Resend (user lacks DNS today → 403 on send; meanwhile ConsoleMailer logs the invite/login links to `~/.athena-tmp/athena-server.log`)
- [x] **Normalize G3.TFIX → G3/S4/T6.md** (DONE 2026-08-09): moved from `docs/kanban/G3/TFIX.md` to `docs/kanban/G3/S4/T6.md`, frontmatter id→t6 / parent→G3.S4. (Was an orphan at G3 root the scanner didn't read.)
- [ ] **KB confidence & lifecycle in wiki frontmatter** — spec `docs/spec-m4-kb-confidence-lifecycle.md` (2026-08-09)
  - Add to each wiki md frontmatter: `read_count` (times Athena/retrieval read it), `last_reviewed`
    (last Athena re-eval), `confidence` (0..1: source count, recency, contradictions; decays), and
    `topic_history` (ordered past topics = migration audit trail). `created`/`updated` already exist.
  - **Athena KB review** (ties into incremental re-curation + post-docling refinement): on schedule/on
    demand scan frontmatter → decide re-topic / re-classify / deprecate(fade) / reinforce. `read_count` +
    `last_reviewed` show what's used vs rotting. No LightRAG re-chunk needed (fields live in wiki md only).
  - Source: LLM Wiki v2 gist (confidence, supersession, forgetting, consolidation).
- [ ] **Worker progress tracking via ticket-file Progress Log** — spec `docs/spec-m4-worker-progress.md` (2026-08-09)
  - Pain: OpenCode workers don't update their ticket file → can't see progress/stuck without manually
    polling the session. Make progress readable directly from the ticket md file.
  - Design: a **Progress Log table at the bottom of each ticket file** (UTC timestamp + status + one-line
    progress). **Written by an OpenCode plugin** (`tool.execute.after` + `session.status`), NOT an AGENTS.md
    instruction (LLM may forget). **Append a row only on a real change** (a tool ran / status moved) — not a
    fixed every-minute tick; a stale last-row timestamp IS the "stalled" signal. Kanban parser reads the log →
    `KanbanTab` shows last row + "updated Xs ago" + flags **stalled**. Refresh button re-scans.
    - **AI4Kanban reference (2026-08-09, ai4kanban.dev)**: our markdown-board-in-repo + agent-directly-updates
      model matches its core. Worth borrowing: (1) **project memory** (`docs/kanban/memory/{goal,decisions,rejected}.md`)
      so product decisions / rejected directions carry into future planning; (2) **failure-reason classification**
      + don't auto-retry unfixable failures (avoid the "12 identical reruns on one card" problem we saw);
      (3) optional autonomous planning (goal → tasks, dependencies, priority). See vs-github-issues: our board
      = agent's local workspace; GitHub Issues = external/team tracker; can coexist.
- [ ] **Kanban ↔ GitHub Issues bidirectional sync + planning feedback loop** — spec `docs/spec-m4-kanban-issues-sync.md` (2026-08-09)
  - md files stay the single source of truth (agents read/write docs/kanban directly); each **Spec →
    a GitHub Issue** (tickets as `## Sub-tasks` checklist), giving team discussion surface.
  - **md → GitHub** (projection): spec→issue; ticket state-machine changes + assignee/session sync;
    Progress Log detail NOT pushed (stays in md; avoid spamming GitHub). Sync CLI/tool (board.js-style).
  - **GitHub → md** (feedback loop): team comments/ideas → **plan agent reads them → new/edited tickets
    or a new spec** back into md (source of truth). Human keeps authority; md authoritative on conflict.
  - Reference: ABAPlorer workflow (Caleo, private repo `WORKFLOW-PROPOSAL.md` + `scripts/board.js`).
- [ ] **Remote Agent Federation (HTTP/SSE + Tailscale)**
  - Architecture (decided 2026-08-09): agents stay LOCAL (tools run on each employee's machine); the platform is a control plane. Users send commands via the platform → forwarded to the right local agent → agent works locally → streams the process + result back. **Communication is HTTP + SSE, NOT WebSocket** (SSE covers real-time push; HTTP covers command send). Tailscale provides the encrypted tunnel so the server can reach every local agent across regions.
  - Each local agent (Hermes API Server `/api/sessions/{id}/chat/stream` SSE, OpenCode serve `/global/event`, etc.) already exposes an HTTP+SSE remote-control surface — no new protocol needed.
  - Invitation-based agent onboarding (like employee invites): admin generates `{agent_id, api_url, token}` invite → hand to the agent → agent registers with the platform (auth'd, so the platform knows which agent is where and how to reach it).
  - Manual "Register agent" form in the Agents panel (S2.T9, moved here from G3) — design together with the invite flow: manual alias/logo/owner/capabilities form + invite-based auto-onboarding.
  - Platform Chat panel → route to a selected remote agent's API Server, streaming tool progress (tool.started / tool.completed) into the panel.
- [ ] **Knowledge base as MCP server (agents retrieve company KB)**
  - Decision (2026-08-09): expose the knowledge base as an **MCP server** (primary path) — the KB is a tool/resource for agents (`search_knowledge`, `get_wiki_page`, `get_graph`), and MCP is the semantically-correct + mature protocol (OpenCode/Claude Code/Codex/Hermes all speak MCP client).
  - Platform wraps `KnowledgeRetrievalService` (LightRAG + llm_wiki + semantic search) into an MCP server (run on the server), auth'd; each local agent adds one `mcpServers` entry pointing at it over Tailscale.
  - Bonus: also wrap Workbench GitHub + kanban ops as MCP tools so agents can operate GitHub/kanban directly (AgentIDE vision).
  - **A2A (agent-to-agent) deferred** — put in M6 with "agents chat with each other / with Athena as a peer", not in M4. MCP-first for KB access.
- [ ] **Post-docling LLM document refinement step** — spec `docs/spec-m4-docling-refinement.md` (2026-08-09)
  - docling uses a fixed ML layout model (not LLM) → PDFs can come out flat (e.g. Sommerseminar = 16× h2).
  - Insert an LLM pass between docling parse and the parallel stages doing: header re-level (semantic
    `#`/`##`/`###`), quality check (md vs source completeness), topic judgment (fold in existing
    llm_wiki classify). Chunking already paragraph_semantic (lightrag.ts:130). Fallback to docling
    output if the LLM step fails (never worse than today). Same model (deepseek-v4-flash-latest).
  - **Context-efficiency**: fold ALL full-doc LLM passes into ONE Athena read (llm_wiki classify +
    this step). LightRAG still runs its own per-chunk entity/keyword LLM internally (hardcoded,
    no injection interface — needs fork to remove; spike in M4).
- [ ] **RAG system selection: replace LightRAG?** (2026-08-09)
  - Driver: LightRAG is a black box — entity extraction / keyword / chunk are hardcoded internal LLM
    calls with no external-injection interface, so Athena can't drive them (needs fork). 
  - Evaluated RAGFlow (86.9k★): deep doc parsing + GraphRAG + Docling support + custom chunker, BUT it
    is a full platform on **ES/MinIO/MySQL** (NOT pgvector) and its GraphRAG is internal (not
    injectable) — does not solve the "Athena injection" goal; heavy new infra. Not a match.
  - Lean toward **self-built lightweight RAG** on the existing PG + pgvector 0.6 + a simple graph
    (PG tables / NetworkX / Apache AGE): vector top-k (pgvector) + keyword + graph-neighbor fusion,
    with Athena injecting entities/headers/chunks directly (no fork). Most controllable, solves all
    pain points. Haystack/LlamaIndex as modular-library reference (still need to build graph RAG).
  - Decision needed in M4: self-build vs keep LightRAG (accept its internal LLM passes).
  - **Key reference found (2026-08-09): Neo4j official `neo4j-graphrag` Python lib** — highly matches
    self-build. Provides HybridRetriever (vector+full-text fusion + rank), VectorRetriever, Text2Cypher
    (LLM→Cypher), and **ToolsRetriever** (combine multiple retrievers, LLM picks — fits "fuse wiki +
    topic + vector + graph" enhancement). SimpleKGPipeline builds KG (or inject Athena entities
    directly). Vectors can be Neo4j-native or external; may need a custom retriever for pgvector.
  - **Neo4j has native vector index (confirmed)**: `CREATE VECTOR INDEX` (HNSW, cosine/euclidean), Cypher
    `SEARCH` clause (2026.01+) + in-index filters (`SEARCH…WHERE`, GA 2026.02) — **Community Edition OK**;
    native VECTOR type is Enterprise but Community uses LIST properties (equivalent for indexing). So
    **Neo4j 2026 Community (Docker) suffices — no pgvector needed**. See design §8.
  - **M4 open items**: deployment spike (run Neo4j 2026 Community in Docker on 6900XT, verify vector+SEARCH+filters);
    decide single Neo4j store (B) vs PG+pgvector+Neo4j (A); wiki frontmatter topic → Neo4j chunk.topic.
    Keep llm_wiki (pages/TOC); LightRAG replaced (self-build) or kept.
  - Reclassify/re-topic existing docs into deeper sub-topic layers (e.g. `internal/events/sommerseminar`, `internal/events/cday`, `internal/events/oktoberfest`) once a topic dir grows large (e.g. events with 100 files).
  - `isValidTopic` already supports arbitrary-depth slash paths; the gap is a re-curation tool, not the schema.
  - **LightRAG does NOT need re-chunking/re-embedding.** Topic filtering is driven by the WIKI file frontmatter, not LightRAG internals: `buildTopicMap()` (retrieval.ts) reads `topic` from llm_wiki pages, then `filterGraphByTopic()` uses it to filter LightRAG graph nodes by file_path. So re-topic = edit the wiki md frontmatter `topic` (+ move file to the new `wiki/<topic>/` dir) and re-`listWikiPages`/rebuild index; the existing chunks + embeddings + entities stay valid.
  - Exception: if we ever want topic stored as LightRAG document metadata (not just wiki frontmatter) for doc-level filtering, that WOULD need a re-ingest. Decide scope in M4.
  - Sub-topic assignment source (decide): manual per-file, filename/title keyword rules, or re-run llm_wiki classification against an extended taxonomy tree (events→{sommerseminar,cday,oktoberfest}).
- [ ] **Topic-scoped semantic search** (search within a topic domain) — enhancement (2026-08-09)
  - Let a query search only within a topic subtree (e.g. "docs under `sap/`"), by pre-filtering
    candidate docs/chunks by their wiki frontmatter topic before semantic scoring. Currently
    `/api/kb/search` is full-corpus (topic-agnostic). Useful for agentic RAG scoping + precision on
    large corpora. See design note "Role of topic in retrieval / agentic RAG" in
    `docs/knowledge-rag-design.md`.

### M5 — Output Page (txt/blog/charts/pptx/html)
- [ ] Generate txt/blog/charts from knowledge base + web sources
- [ ] pptx/html generation functional
- [ ] Frontend preview + download

### M6 — Multi-Agent Federation (local agent + remote SAP integration)
- [ ] Integrate local agents (e.g. local Hermes) into the athena federation (via LAN, joinable in chat)
- [ ] Remote SAP PiB_i per-employee + HTTP endpoint connecting to athena server
- [ ] Agent naming convention: fixed names in the server (see Naming Convention below)
- [ ] Conversation routing among the 3 agent tiers (local / server Athena / remote SAP)
- [ ] **Agent connection SDK / HTTP protocol**: define a standard spec + SDK so any agent
      (Hermes/Claude/Codex/Pi) can connect to athena, register itself, and operate —
      local HTTP-shell setup guide (see Connection Protocol in design doc)
- [ ] **A2A (agent-to-agent) + multi-agent chat collaboration** (deferred here from M4, 2026-08-09)
  - MCP covers KB access for M4; A2A lives here for agents collaborating / chatting with each other.
  - Agents converse with each other and with Athena as peers (A2A protocol), not just calling KB tools.
  - Multi-agent chat in the Chat panel: multiple agents in one conversation cooperating on a task
    (e.g. local Hermes plans → remote OpenCode implements → Athena pulls KB context), coordinating
    via the platform as the control plane (HTTP + SSE from M4).

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
- 2026-08-07: M2 (G2) complete — all 5 specs / 26 tickets done; graph node selection + circle-shape fix; G1+G2 Goals and all Specs marked done
