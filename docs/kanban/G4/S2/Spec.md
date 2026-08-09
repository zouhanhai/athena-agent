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

- **Spike first**: run Neo4j 2026 Community in Docker on 6900XT; verify vector index (`CREATE VECTOR INDEX`),
  Cypher `SEARCH` clause, and in-index filters (`SEARCH…WHERE`). Community Edition suffices (LIST properties,
  no pgvector needed).
- **Single Neo4j store (option B, lean)**: `Chunk` nodes (embedding + topic + text), `Entity`/`Relation`
  graph, `Document`/`WikiPage`. One store for vector + graph + topic.
- **Athena injection**: entities/chunk/topic/headers come from G4.S1's output contract.
- **Retrieval**: `neo4j-graphrag` (HybridRetriever = vector+full-text fusion, Text2Cypher, ToolsRetriever to
  fuse wiki + topic + vector + graph).
- **Case-insensitive** node lookup (LightRAG's `caleo`/`CALEO` bug must not recur).
- A2A deferred to M6; MCP-first for KB access (G4.S6).

## Dependencies

- G4.S1 (Athena refinement output contract).
- G4.S3, G4.S6 build on this.

## Deliverables

- Neo4j deployment spike (Docker on 6900XT) + decision record.
- Store schema (Chunk/Entity/Relation/Document) + ingest from Athena output.
- Retrieval service (neo4j-graphrag) replacing `KnowledgeRetrievalService`'s LightRAG path.
- Case-insensitive lookup + tests.
