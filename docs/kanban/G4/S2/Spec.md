---
id: s2
title: "G4.S2: RAG self-build — replace LightRAG with Athena-driven Neo4j store"
layer: S
parent: G4
owner: consultant
status: backlog
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
  - **Vector**: Neo4j vector index (HNSW, cosine) over Athena-chunk embeddings.
  - **Graph**: entity/relation traversal (Text2Cypher) — agentic RAG uses topic as Athena's knowledge
    navigation (determine topic → converge document domain → fuse).
  - **Fusion**: HybridRetriever / RRF fuses vector + BM25 + graph; ToolsRetriever lets the LLM pick the
    best retriever per query.
- **Case-insensitive** node lookup (LightRAG's `caleo`/`CALEO` bug must not recur).
- A2A deferred to M6; MCP-first for KB access (G4.S6).
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
- G4.S3, G4.S6 build on this.

## Deliverables

- Neo4j deployment spike (Docker on 6900XT) + decision record.
- Store schema (Chunk/Entity/Relation/Document) + ingest from Athena output.
- Retrieval service (neo4j-graphrag) replacing `KnowledgeRetrievalService`'s LightRAG path.
- Case-insensitive lookup + tests.
