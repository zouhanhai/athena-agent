---
id: G4.S9
title: "G4.S9: Graph community intelligence — Leiden clustering, community summaries, global QA, co-occurrence edges"
owner: pm
layer: S
parent: G4
acceptance_criteria:
  - "Leiden community detection runs on the Neo4j knowledge graph (Entity nodes + RELATION edges, optionally weighted by MENTIONED_IN co-occurrence) producing stable community memberships persisted on nodes (e.g. e.community_id) and re-runnable incrementally after ingests/edits/deletes without disrupting online retrieval."
  - "Community summaries: for each detected community, an LLM pass generates a concise summary (members, theme, key relations) stored back in the graph (Community node or property); summaries are refreshed when the community composition changes materially, not on every micro-edit."
  - "Global/community-level QA: a retrieval path answers whole-corpus questions by matching the query against community summaries (vector/BM25) and then grounding the answer in the community's member chunks via the existing chunk/entity retrieval — exposed through /api/kb (search_knowledge or a dedicated endpoint) and usable by the Athena agent."
  - "Co-occurrence edge option: chunks that mention several entities within a window produce weak RELATION edges (cooc- prefix or a dedicated CO_OCCURS type) with a configurable threshold, mitigating sparse-relation 'half-orphans' without duplicating LLM relations."
  - "Half-orphan handling: entities with no explicit relation now participate in retrieval (they belong to a community via mention edges) — the previous 'orphan' class is gone or visibly reduced."
  - "Tests: community detection on the Sommerseminar corpus yields a stable partition including the CALEO-centric community; community summary endpoint returns content; global query uses the summary path; co-occurrence edges appear for shared-chunk entities; existing server suite stays green."
status: in_progress
---

# G4.S9: Graph community clustering, global QA and co-occurrence edges

## Background

After G4.S8 (ingest/refine/wiki-edit/dedup hardened and approved), three gaps
remain for the knowledge graph's value:

1. **Global queries** — questions spanning the whole corpus (e.g. "what events does
   CALEO organize?") rely on per-document retrieval; there is no community-level
   abstraction. Microsoft GraphRAG solves this with community summaries over
   Leiden clusters.
2. **Half-orphan entities** — an entity that is mentioned in chunks but has no
   RELATION edges (the LLM's relation extraction is per-document and sparse) looks
   isolated in the graph UI and is under-served by graph-path retrieval, even
   though vector/BM25 still finds it.
3. **Relation density** — the LLM extraction varies per document (three rels one
   run, eight the next); entities that co-occur in the same chunk are semantically
   related but get no edge.

This spec picks up the Leiden community detection previously identified as an
optional enhancement in the RAG comparison (entity-level vs document-level topic),
now as the core of global-query support.

## Design / Approach

### 1. Leiden community detection

- Use a community-detection implementation that works against the Neo4j graph.
  Options (prefer the one with least operational burden on our stack):
  - neo4j-graph-data-science (GDS) community edition (supported for non-commercial)
  - a JS/TS in-process implementation (e.g. @graphology/communities-louvain or a
    Leiden port) reading the graph over the driver and writing memberships back —
    avoids GDS plugin/server dependencies.
- Input: Entity nodes + RELATION edges (optionally add MENTIONED_IN co-weight).
- Output: `communityId` on each Entity (or a Community node with
  -[:MEMBER]-> members). Persisted property `d.community`.
- **Incremental strategy**: full re-run is acceptable when a document is deleted or
  a big ingest lands; for small wiki-edit diffs, recompute communities for the
  touched entity's community and its neighbours only (documented heuristic), or
  simply re-run whole-graph when size < some threshold (fixture scale ~50 nodes).

### 2. Community summaries

- After clustering, for each community: extract the member entities + core relations
  and call one LLM pass (reasoning off, extraction-class prompt reused from the
  refine tooling; ~200-500 tokens) to produce `summary` text. Persist on Community
  node: `{ id, summary, memberEntityIds:[], relationIds:[], updatedAt }`.
- Refresh policy: rerun the summarization for communities whose composition changed
  since last run (diff on membership), not on every write. One-shot for fixtures.

### 3. Global QA path

- Index community summaries in the same embedding/BM25 pipeline (as small "Chunk"
  nodes or a dedicated CommunityText node with vector index).
- Global query: embed query → top community matches by summary vector → pick the
  best 1-3 communities → gather member entities + their chunks (existing
  MENTIONED_IN walk) → fuse into the agent answer (same fusion + rerank as current
  retrieval). Expose as `search_knowledge(query, {scope:"global"})` or a separate
  endpoint.

### 4. Co-occurrence edges (half-orphan mitigation)

- After chunk embedding, for each chunk: find entity names/aliases present in the
  chunk text (the existing mentionPairs logic already does this — we just keep the
  co-occurrence pairs). For every pair of entities co-occurring in the same chunk,
  MERGE a `CO_OCCURS` edge with weight = number of shared chunks, unless a RELATION
  edge already exists (don't duplicate).
- These edges participate in community detection and graph expansion, but are
  never exposed as "real" relations in the refinement output.

### 5. UI/observability

- Knowledge-graph view shows community membership (node colour by community or a
  filter) — optional, low priority, only if cheap.

## Dependencies

- G4.S8 (approved: ingest/edit/delete/dedup/review-state stable — the graph
  shapes we cluster over are final).
- Retrieval fusion + rerank layer already in place from S2/S8 (vector + BM25 +
  graph + llama rerank) stays unchanged; S9 adds the community/global layer on top.

## Deliverables

- Leiden community detection integrated + incremental strategy documented.
- Community nodes + summaries pipeline (create/summarize/refresh).
- Global-query retrieval path (endpoint + agent-usable).
- CO_OCCURS edges wiring (ingest-time) + config flag.
- Tests + docs: ADR for community store + retrieval path, fixtures on existing Sommer docs.
