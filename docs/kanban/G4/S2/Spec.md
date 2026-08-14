---
id: s2
title: "G4.S2: RAG self-build — replace LightRAG with Athena-driven Neo4j store"
layer: S
parent: G4
owner: consultant
status: done
milestone: M4
acceptance_criteria:
  - "Decision made: self-build (Neo4j lean) vs keep LightRAG — spike validates Neo4j 2026 Community (vector index + SEARCH + filters)"
  - "If self-build: Athena injects entities/chunks/topic/headers directly (no LightRAG fork)"
  - "Case-insensitive node/label lookup in the graph (LightRAG's case-sensitive bug not repeated)"
  - "Retrieval via neo4j-graphrag (Hybrid/Vector/Text2Cypher/Tools) fusing wiki + topic + vector + graph"
  - "LightRAG replaced (self-build) or kept (accept internal LLM passes) — decided"
---

# G4.S2: RAG self-build — replace LightRAG with Athena-driven Neo4j store

## Background

LightRAG is a black box: entity extraction / keyword / paragraph-semantic chunking are hardcoded
internal LLM calls with no external-injection interface, so Athena can't drive them (would need a fork).
Its storage already uses PG + pgvector + a graph.

## Full design

See `docs/knowledge-rag-design.md` §8 (RAG system selection & self-build direction) and the M4
RAG-selection item in `TODO.md`. Key points:

- **Athena is the single full-doc LLM pass (see G4.S1)** — Athena injects chunk/entity/keyword/topic/header
  from its refinement output. This RAG is a **pure store + retrieve** (no LLM beyond embedding), which solves
  the LightRAG black-box problem: we no longer depend on LightRAG's hardcoded entity/keyword/chunk LLM passes.
- **Spike first**: run Neo4j 2026 Community in Docker on 6900XT; verify vector index (`CREATE VECTOR INDEX`),
  Cypher `SEARCH` clause, and in-index filters (`SEARCH…WHERE`). Community Edition suffices (LIST properties,
  no pgvector needed).
- **Single Neo4j store (option B, lean)**: `Chunk` nodes (embedding + topic + text, Athena-provided),
  `Entity`/`Relation` graph (Athena-provided), `Document`/`WikiPage`. One store for vector + graph + topic.
- **Ingest**: receives G4.S1's output (chunks + entities + relations + keywords + topic) and only
  **embeds + indexes** — no LLM extraction here.
- **Retrieval**: `neo4j-graphrag` (HybridRetriever = vector+full-text fusion, Text2Cypher, ToolsRetriever to
  fuse wiki + topic + vector + graph). Keyword search can use Athena's injected keywords.
- **Retrieval is hybrid + agentic + BM25 (confirmed 2026-08-09)** — mirrors the current
  `KnowledgeRetrievalService.search` (LightRAG semantic + llm_wiki keyword via Promise.allSettled):
  - **BM25**: llm_wiki's keyword search is BM25; in the self-build it's Neo4j FULLTEXT index / Cypher
    BM25 scoring (or keep llm_wiki as the BM25 source over the wiki pages).

- **Bilingual entity aliases (DE+EN, decided 2026-08-10)**: entities are one node, but must be findable in
  **both German and English** — a user searching German ("Zentraler Omnibusbahnhof") must match the EN node
  (ZOB München), and vice versa. `RefinementEntity` gains **`aliases: string[]`** (same node, alternate
  language names/terms). Athena's refinement prompt emits `name` (document-language canonical) +
  `aliases` (EN+DE variants) in one pass. RAG stores aliases as node properties and includes them in
  keyword/full-text/BM25 search. (Out of scope: Chinese — DE+EN covers the CALEO doc corpus.)
  - **Vector**: Neo4j vector index (HNSW, cosine) over Athena-chunk embeddings.
  - **Graph**: entity/relation traversal (Text2Cypher) — agentic RAG uses topic as Athena's knowledge
    navigation (determine topic → converge document domain → fuse).
  - **Fusion**: HybridRetriever / RRF fuses vector + BM25 + graph; ToolsRetriever lets the LLM pick the
    best retriever per query.
- **Case-insensitive** node lookup (LightRAG's `caleo`/`CALEO` bug must not recur).
- A2A deferred to M6; MCP-first for KB access (G4.S7).
- **Leiden community detection (optional enhancement, decided 2026-08-09)**: our `topic` classification is
  **document-level, human-defined** (taxonomy tree); Leiden is **entity-level, automatic** (data-driven
  clustering of densely-connected entity nodes). They are complementary, NOT the same:
  - topic = "which bucket does this doc belong to" (per-doc, curated tree).
  - Leiden = "which entities are densely related" (per-graph, auto-discovered clusters).
  - **Value**: Leiden auto-discovers topic clusters the taxonomy didn't anticipate → can **feedback into
    the taxonomy** (spot subtopics needing split/new topics) + enable GraphRAG-style global queries
    (community summaries). Tracked as optional enhancement; not required for S2 core.

## Dependencies

- G4.S1 (Athena refinement output contract).
- G4.S3, G4.S7 build on this.

## Deliverables

- Neo4j deployment spike (Docker on 6900XT) + decision record.
- Store schema (Chunk/Entity/Relation/Document) + ingest from Athena output.
- Retrieval service (neo4j-graphrag) replacing `KnowledgeRetrievalService`'s LightRAG path.
- Case-insensitive lookup + tests.

## Status: DONE (2026-08-11) + enhancement tickets

Core S2 (T1-T9) + enhancement tickets (T10-T14) all complete and verified.

### Core tickets
| Ticket | Deliverable | Status |
|--------|------------|--------|
| T1 | RefinementEntity bilingual aliases (DE+EN) | done |
| T2 | Neo4j 2026 spike + ADR-0008 (self-build confirmed) | done |
| T8 | Refinement retry default 1→3 (fewer spurious fallbacks) | done |
| T3 | Neo4j store schema (Chunk/Entity/Relation/Document + folded index) | done |
| T4 | Ingest: Athena output → Neo4j (embed + index, no LLM) + pipeline stage | done |
| T5 | Retrieval service (vector + BM25 + graph + topic + fusion) | done |
| T9 | Fix Neo4j vector search hang (CYPHER 25 prefix + index dims 4096 + LIMIT int) | done |
| T6 | Case-insensitive + bilingual alias search | done |
| T7 | Replace LightRAG path in /api/kb/search | done |

### Enhancement tickets
| Ticket | Deliverable | Status |
|--------|------------|--------|
| T10 | Remove LightRAG completely (stage, client, poller, deps, tests) | done |
| T11 | RAG↔Wiki fusion: Section/WikiPage nodes + chunk hits carry wikiPath/sectionPath + same-section context | done |
| T13 | Athena layered document summaries (file-level + per-H1-section) | done |
| T14 | Entity→Chunk (MENTIONED_IN) + graph in RRF + cross-encoder rerank (llama.cpp BGE-Reranker-v2-M3) | done |

### Verification (2026-08-11)
- Server tests: **693/693 pass**, typecheck 0 errors (grew from 656 base to 693 across T10-T14).
- End-to-end upload (Sommerseminar Mallorca 2023.pdf) verified on clean DB:
  - Neo4j graph: 1 Document + 14 Chunk + 18 Section + 20 Entity + 1 WikiPage.
  - Relationships: HAS_SUBSECTION (17), PART_OF (14), RELATION (5), IS_DOCUMENT (1), HAS_SECTION (1).
  - Layered summaries: file-level on Document + per-H1-section on Section nodes.
  - Retrieval returns neo4j chunks with `wikiPath` + `sectionPath`.
  - Graph-only chunk RRF-fused (verify-t14.ts): entity chunk surfaces via MENTIONED_IN path.
  - llm_wiki page written (internal/events/Sommerseminar-Mallorca-2023.pdf.md).
- T14 verify script (`server/scripts/verify-t14.ts`): MENTIONED_IN edges created + graph-only chunk fused.

### Notes / decisions
- LightRAG database (NetworkX graph in Postgres `lightrag`) deleted; qm/weknora DBs removed (empty).
- Chunking stays "semantically complete sections" (each schedule activity = a chunk); short chunks
  are fine — Context Enrich (T11) supplies same-section context.
- Cross-encoder rerank runs on local llama.cpp (`/home/hh/llamacpp-rocm/llama-server --rerank
  --pooling rank`, BGE-Reranker-v2-M3 GGUF) — injectable, falls back to RRF-only if unavailable.
- Reranker is BGE-Reranker-v2-M3 (2025, MIT, 100+ languages) not the older bge-reranker-base.

