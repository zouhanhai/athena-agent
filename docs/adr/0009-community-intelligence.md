# ADR-0009: Community intelligence on the knowledge graph — in-process deterministic Louvain, per-community summaries, global QA scope, CO_OCCURS edges

## Status

Accepted (2026-08-23). Produced during G4.S9 (T1-T4, all approved 2026-08-23).
Records the design decisions behind community detection + global retrieval +
half-orphan mitigation, so they are not re-litigated.

## Context

After G4.S8 hardened the ingest/edit/delete pipeline (approved), three gaps
remained for the knowledge graph's value:

1. **Global queries** — questions spanning the whole corpus had no
   community-level abstraction (Microsoft GraphRAG solves this with community
   summaries over Leiden clusters).
2. **Half-orphan entities** — entities mentioned in chunks but with no RELATION
   edges (per-document LLM extraction is sparse and variable) looked isolated.
3. **Relation density** — chunks that co-mention entities are semantically
   related but no edge is created automatically.

Goal: give the graph a community layer (clusters + summaries + global retrieval)
and reduce half-orphan visibility — without a second cluster store, without
blocking online retrieval, and without burning tokens on unchanged communities.

## Decision

### 1. Community detection: in-process deterministic Louvain (no GDS)

- neo4j-spike ships **no GDS plugin** → running `gds.beta.community.leiden`
  would require a plugin install/licensing decision; instead implement in Node
  (`server/src/kb/store/community.ts`).
- **Deterministic**: no RNG at all — sorted iteration order + smallest-key
  tie-breaks, so the same graph always yields the same partition (fixtures
  assert stable communities).
- Modularity resolution **γ = 0.5** below the 200-entity threshold (coarser
  clusters on small graphs).
- Input: Entity nodes + RELATION edges + optional MENTIONED_IN co-mention
  weight (default on).
- Output: `community_id` property on every Entity.
- **Stable community ids**: `c_` + first 12 hex of sha256 over the sorted
  member ids — identical composition never churns downstream nodes (T2).

### 2. Incremental refresh — event-driven, never periodic

- Fire-and-forget hooks after ingest / wiki-edit / delete:
  - delete / large ingest → **full re-run**;
  - small wiki-edit → **bounded local closure** recompute (cap 500);
  - graph < 200 entities → always full re-run (fast at this scale).
- Online retrieval is NEVER blocked; memberships are eventually consistent.
- No weekly full-database scan: the graph maintains itself on every change.

### 3. Community summaries — one LLM pass per CHANGED community

- `:Community {id, summary, theme, members_hash, member_count, updated_at}` +
  `-[:MEMBER]->` edges, upserted from T1 memberships
  (`server/src/kb/store/community-summary.ts`).
- Fingerprint = `members_hash` (sha256 over the canonical sorted member form,
  the same form the community id uses).
- A community is re-summarized ONLY when: node missing / membership changed /
  summary missing (failed LLM pass retries next run). Dissolved communities
  (zero members) are DETACH DELETEd — orphan-less store.
- Summarization = ONE extraction-class direct-OpenRouter call per changed
  community (reasoning off, json_schema `{summary, theme}`, ~200-500 tokens),
  reusing the refine toolchain caller — no new provider wiring.

### 4. Global QA — a retrieval SCOPE, not a new system

- `SearchScope = "local" | "global"` (default stays local; regression-safe).
- Global path: embed query → top community summaries (BM25/vector, fused) →
  pick top 1-3 communities → member entities → MENTIONED_IN walk → chunks →
  existing fusion + rerank → answer.
- Exposed via search_knowledge/scope and route params; no second retrieval
  stack.

### 5. CO_OCCURS weak edges — half-orphan mitigation

- During ingest/overwrite, after `mentionPairs` (which already scans chunk text
  for entity names), pairwise entities within the same chunk get a **CO_OCCURS**
  edge with weight = shared chunk count.
- Skipped when a RELATION edge already exists; capped per chunk (top 8);
  stale edges cleaned when no shared chunks remain.
- These edges participate in community detection + graph expansion but are
  NEVER exposed as refinement output relations.

### 6. Admin surface — manual recompute + weekly audit section

- `POST /api/kb/admin/communities/recompute` (admin-gated, 409 on concurrent
  run): full re-run + summary refresh, report persisted into the existing T15
  audit-report store with `trigger: manual`.
- Weekly audit (T15) gains a community-quality section (count, size
  distribution, unassigned entities, summary presence), trigger=weekly.
- Admin UI: "Recompute communities" button + run history table.

## Consequences

- Graph self-maintains communities on every change (no manual weekly scans).
- Global questions get corpus-level grounding via summaries; local retrieval
  unchanged.
- Half-orphans remain valid entities but are now reachable via communities and
  CO_OCCURS edges.
- Token cost: bounded (per-changed-community only).
- Operational: no GDS dependency; deterministic so fixtures/promotions are
  reproducible.
- Known limits: deterministic Louvain (not full Leiden refinement) at small
  scale; community semantics are structural, not semantic (a community may mix
  themes — summaries help).

## References

- `server/src/kb/store/community.ts` (T1), `community-summary.ts` (T2),
  `store/retrieval.ts` + `ingest.ts` CO_OCCURS (T3), `community-maintenance.ts`
  (T4).
- G4.S9 Spec + T1-T4 tickets.