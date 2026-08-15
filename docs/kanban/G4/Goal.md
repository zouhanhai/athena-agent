---
id: g4
title: "G4: RAG Self-Build, KB Intelligence & Agent Collaboration"
layer: G
owner: consultant
status: active
created_at: 2026-08-09
milestone: M4
acceptance_criteria:
  - "G4.S1 Post-docling Athena refinement: an LLM pass after docling re-levels headers, quality-checks md vs source, and confirms topic — single full-doc read, fallback to docling output on failure"
  - "G4.S2 RAG self-build: replace LightRAG with a self-built store (Neo4j lean) driven by Athena's injected entities/chunks/topic/headers; case-insensitive node lookup; no LightRAG fork"
  - "G4.S3 KB confidence & lifecycle + incremental re-curation + topic-scoped search: wiki frontmatter gains read_count/last_reviewed/confidence/topic_history; Athena KB review re-topics/deprecates/reinforces; search can scope to a topic subtree"
  - "G4.S4 Worker progress tracking: OpenCode plugin appends a Progress Log row to the ticket md file on real change; Kanban shows last row + stalled flag"
  - "G4.S5 Kanban ↔ GitHub Issues bidirectional sync + planning feedback loop: Spec → Issue (title Gx.Sx), ticket status syncs, plan agent reads issue discussion back into md"
  - "G4.S6 GDD decoupling: GDD dev-flow documented as a generic agent-agnostic protocol (docs/gdd handbook) separated from athena KB; Workbench splits Kanban (GST) and Project (GitHub) into sibling sub-tabs"
  - "G4.S7 Remote agent federation (reverse WebSocket + Cloudflare Tunnel) + KB-as-MCP: local agents register via invite and connect INTO the platform, platform Chat routes to a remote agent with streamed progress; KB exposed as MCP server; public site at athenakb.com"
---

# G4: RAG Self-Build, KB Intelligence & Agent Collaboration

## Background / Context

Corresponds to Milestone M4. Three thrusts:

1. **KB / RAG re-architecture** — LightRAG is a black box (entity/keyword/chunk LLM are hardcoded,
   no external-injection). G4 replaces it with a self-built store driven by **Athena's refined output**
   (headers, quality, topic, entities, chunks). Athena refinement runs first (defines the output
   contract), then the RAG consumes it.
2. **KB intelligence** — confidence + lifecycle in frontmatter, incremental re-curation, topic-scoped search.
3. **Agent collaboration** — worker progress tracking, Kanban ↔ GitHub Issues sync, remote agent
   federation + KB-as-MCP.

## Spec dependency order

- **G4.S1 Athena refinement FIRST** — defines the Athena output contract (entities/chunk/topic/header)
  that G4.S2 (RAG) consumes. Do not start RAG before the refinement output is decided.
- G4.S2 RAG self-build — depends on S1.
- G4.S3 KB intelligence — builds on S1/S2.
- G4.S4 Worker progress, G4.S5 Kanban-issues sync — independent collaboration items.
- **G4.S6 GDD decoupling (prerequisite for S7)** — package the GDD dev-flow protocol (boundary vs
  athena, docs/gdd handbook, Workbench Kanban/Project sub-tab split) so it is reusable on any project.
- **G4.S7 Remote federation + MCP — AFTER S6**: federating/controlling remote agents assumes the GDD
  dev-flow they run is packaged (S6) first.

## Reference design docs

- `docs/knowledge-rag-design.md` (§8 RAG self-build direction, Neo4j)
- `docs/spec-m4-docling-refinement.md` (G4.S1)
- `docs/spec-m4-kb-confidence-lifecycle.md` (G4.S3)
- `docs/spec-m4-worker-progress.md` (G4.S4)
- `docs/spec-m4-kanban-issues-sync.md` (G4.S5)
- `docs/taxonomy.md` (classification tree)
- `docs/ingest-retrieval-flow.md` (ingest + retrieval pipeline + RAG↔Wiki fusion design)
- `docs/retrieval-analysis.md` (retrieval deep analysis + optimization roadmap)

## Progress

- **G4.S1 (Athena refinement): DONE** — T1-T6 complete. Athena is the single full-doc LLM pass
  (re-level headers + quality + topic + chunks + entities/relations/keywords + layered summaries).
  Server tests green.
- **G4.S2 (RAG self-build): DONE (2026-08-11)** — T1-T9 core + T10-T14 enhancement all complete.
  Neo4j 2026 lean store replaces LightRAG; vector + BM25 + graph + topic + bilingual aliases;
  RAG↔Wiki fusion (Section/WikiPage nodes, chunk hits carry wikiPath/sectionPath);
  layered summaries; Entity→Chunk + graph in RRF + cross-encoder rerank (llama.cpp BGE-Reranker-v2-M3).
  Server **693/693** tests, typecheck 0. LightRAG fully removed (T10).
  See `docs/kanban/G4/S2/Spec.md` "Status: DONE" for verification details.
- **G4.S3 (KB confidence & lifecycle + agentic RAG): DONE (2026-08-12)** — T1-T13 all complete.
  KB confidence/lifecycle (read_count/last_reviewed/confidence/topic_history, Athena re-curation,
  topic-scoped search); semantic terms (CDay→CALEO Day) + stored Q&A pairs (PG text + Neo4j vector
  index); `search_knowledge` Agentic RAG wired into Athena chat (QA reuse, term expansion, multi-hop,
  not-found→web fallback, clarify only for subject-less queries with a real chat follow-up);
  wiki edit→diff-refine→RAG re-embedding (kb.edit RBAC) + Admin console (employee/permission/invite).
  Server **928/928**, web **421/421**, vue-tsc 0. End-to-end verified: QA reuse, web fallback, clarify,
  Edit→re-ingest (refinement + 4 chunks re-embedded).
- **G4.S4 (Worker progress + auto-claim via OpenCode plugin): DONE (2026-08-13)** —
  T1 (plugin auto-claim + Progress Log via git-lock + session.idle done double-commit),
  T2 (Kanban reads Progress Log + updated-ago + stalled flag), T3 (deploy GLOBAL plugin dir +
  concurrent double-claim fix + Progress append dedupe + done double-commit + AGENTS.md manual-claim
  removal + E2E). Plugin tests 22/22, server 930/930, web 438/438, vue-tsc 0; verified end-to-end on
  6900XT (auto-claim once, single progress rows, separate index-done commit).
  See `docs/kanban/G4/S4/Spec.md`.
- **G4.S5 (Kanban ↔ GitHub Issues sync): DONE (2026-08-14)** — Spec→Issue projection, ticket→sub-issue sync, state machine (T7), Workbench Kanban/Issues/GitHub views, git hook auto-sync, universal board progress + status colors.
- **G4.S6 (GDD decoupling — boundary vs athena, gdd/ package + handbook, Workbench Kanban/Project sub-tab
  split): done** — GDD packaged + separated (T1-T5), runs standalone on the user's machine.
- **G4.S7 (Remote agent federation + KB-as-MCP): backlog** — after S6.

## Post-G4 enhancement backlog (recorded, not scheduled)

Recorded here so they are not lost; implement in a later milestone (M5+). None are G4-blocking.

- *None currently open.* (The wiki-edit → RAG re-embed idea is now tracked as **G4.S3.T10**.)

