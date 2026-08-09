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
  - "G4.S6 Remote agent federation (HTTP/SSE + Tailscale) + KB-as-MCP: local agents register via invite, platform Chat routes to a remote agent with streamed progress; KB exposed as MCP server"
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
- G4.S6 Remote federation + MCP — independent.

## Reference design docs

- `docs/knowledge-rag-design.md` (§8 RAG self-build direction, Neo4j)
- `docs/spec-m4-docling-refinement.md` (G4.S1)
- `docs/spec-m4-kb-confidence-lifecycle.md` (G4.S3)
- `docs/spec-m4-worker-progress.md` (G4.S4)
- `docs/spec-m4-kanban-issues-sync.md` (G4.S5)
- `docs/taxonomy.md` (classification tree)
