# ADR-0008: Self-build the RAG store on Neo4j 2026 Community (spike-validated), replacing LightRAG

## Status

Accepted (2026-08-10). Decision record produced by spike G4.S2.T2 — Neo4j 2026 Community ran in Docker
on 6900XT and met every retrieval requirement (vector index, `SEARCH` clause, in-index filters,
case-insensitive + bilingual lookup). Recorded to avoid re-litigating the choice.

## Context

LightRAG is a black box: entity extraction / keyword / paragraph-semantic chunking are hardcoded
internal LLM calls with **no external-injection interface**, so Athena cannot drive them (a fork would
be required). Its storage already sits on PG + pgvector + a graph. G4.S2 (RAG self-build) wants Athena
as the **single full-document LLM pass** (G4.S1 refinement output: chunks/entities/keywords/topic/
headers) and the RAG store to be **pure store + retrieve** — embed + index only, no LLM extraction.

Before committing to the self-build we had to prove Neo4j 2026 Community (free tier, no Enterprise
features, no pgvector) covers the retrieval needs. This ADR records that spike and the decision.

## Spike evidence (G4.S2.T2, run 2026-08-10)

**Deployment** — Neo4j **2026.06.0-community** (Kernel 2026.06.0, Cypher 25) in Docker on 6900XT:

```
docker run -d --name neo4j-spike \
  -p 7687:7687 -p 7474:7474 \
  -e NEO4J_AUTH=neo4j/<password> \
  -v <dir>/data:/data -v <dir>/logs:/logs \
  neo4j:2026.06.0-community
```

Bolt 7687 + HTTP 7474, auth via `NEO4J_AUTH`. Container came up in ~15s. Data volume persists across
restarts. The image tag `2026.06.0-community` is the current 2026 Community release (latest 2026.x).

**Vector index** — HNSW + cosine on an Athena-style `Chunk` node (`embedding` LIST<FLOAT>, plus `topic`
as an additional property for in-index filtering):

```cypher
CREATE VECTOR INDEX chunk_embedding_idx IF NOT EXISTS
FOR (n:Chunk) ON (n.embedding)
WITH [n.topic]                                   -- additional property → in-index filter
OPTIONS { indexConfig: { `vector.dimensions`: 8,
                         `vector.similarity_function`: 'cosine' } };
```

Reported ONLINE with provider `vector-2026.06`, `vector.hnsw.m: 16`, `vector.hnsw.ef_construction: 100`,
`vector.similarity_function: COSINE`. Available in **Community** — no Enterprise license needed.
✅ Verified.

**Cypher `SEARCH` clause** (ANN with score, Cypher 25 — subclause of `MATCH`):

```cypher
MATCH (c:Chunk)
  SEARCH c IN (
    VECTOR INDEX chunk_embedding_idx
    FOR [0.3,0.2,0.2,0.1,0.8,0.9,0.7,0.2]
    LIMIT 3
  ) SCORE AS score
RETURN c.text, score ORDER BY score DESC;
```

Returned the correct cosine-ranked neighborhood. ✅ Verified.

**`SEARCH…WHERE` — in-index filters by topic**:

```cypher
MATCH (c:Chunk)
  SEARCH c IN (
    VECTOR INDEX chunk_embedding_idx
    FOR [0.2,0.3,0.8,0.2,0.5,0.1,0.3,0.2]
    WHERE c.topic = 'transport'
    LIMIT 5
  ) SCORE AS score
RETURN c.text, c.topic, score;
```

Only `transport` chunks returned even when closer neighbors of other topics exist; the search keeps
scanning until it finds `LIMIT` results satisfying the predicate (vs post-filtering, which can return
fewer). `WHERE c.topic IN ['transport','tourism']` also works — the `IN` filter operator was added in
**2026.06**, which is exactly the version we run. ✅ Verified.

**Case-insensitive node lookup** — two verified patterns that fix LightRAG's case-sensitivity bug
(`caleo`/`CALEO`):
- **Normalized indexed property** — store `nameUpper = toUpper(name)` on the node, range-index it,
  query `WHERE e.nameUpper = toUpper($q)`. The naive `MATCH (e:Entity {name: 'zob münchen'})` returns
  nothing (case-sensitive), the normalized lookup returns `ZOB München`. ✅ Verified.
- **Fulltext** — a `FULLTEXT` index over `name` + `aliases` folds case **and diacritics**: querying
  `zob` matches `ZOB München`; `luesen` matches `Lüsen`; German alias `zentraler omnibusbahnhof`
  matches the EN node `ZOB München` (the bilingual DE+EN alias requirement). ✅ Verified.

Note: the ticket mentions `toCUpper`, but Neo4j 2026.06 ships `toUpper`/`toLower` (no `toCUpper`).
Both are Unicode-aware (`toUpper('Lüsen') → 'LÜSEN'`, `toLower('ZOB MÜNCHEN') → 'zob münchen'`), so
German umlauts case-fold correctly.

## Decision

**Self-build the RAG store (option B, lean single store) on Neo4j 2026 Community in Docker. Replace
LightRAG's retrieval path.** The spike confirms every G4.S2 retrieval requirement on the free
Community edition; there is no need to keep LightRAG (and accept its black-box internal LLM passes) or
to self-build on a different store. Athena stays the single LLM pass; the RAG only embeds + indexes +
searches.

Confirmed design anchors for the build-out (G4.S2.T3–T7):
- `Chunk` nodes: `embedding` (Athena-provided) + `topic` (as vector-index additional property) + `text`.
- `Entity`/`Relation` graph + `Document`/`WikiPage` — one Neo4j store for vector + graph + topic.
- Bilingual alias search: fulltext index over `name` + `aliases` (case/diacritic-folding) + normalized
  `nameUpper` property for exact case-insensitive lookup.
- Retrieval via `neo4j-graphrag` (Hybrid/Vector/Text2Cypher/Tools) fusing wiki + topic + vector + graph.

## Consequences

- LightRAG is eventually removed from the retrieval path (G4.S2.T7) once the self-build store + ingest
  + retrieval land; PG/pgvector usage for RAG is dropped.
- The container must be provisioned as part of the deployment (Docker compose / systemd with the
  `neo4j:2026.06.0-community` image, data volume, `NEO4J_AUTH` secret, ports 7687/7474).
- `toCUpper` referenced in planning docs must be read as `toUpper`/`toLower` in Cypher.
- In-index topic filters require the filter property to be declared with `WITH [...]` at vector-index
  creation time — the ingest step (T4) must add `topic` as an additional property.
- Redis/PG-dependent LightRAG features (its graph export for the KB frontend) need a Neo4j-native
  replacement (`getGraph` → Cypher graph query) — tracked in T5/T7.
