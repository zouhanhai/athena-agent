---
id: G4.S10
title: "G4.S10: Graph-aware entity linking — ingest-time merge/link step + weekly re-link in the audit"
owner: pm
layer: S
parent: G4
acceptance_criteria:
  - "Ingest pipeline gains a LINK stage between refine and store: refine output (candidate entities/relations) is matched against the EXISTING graph (vector/BM25 similarity + name/alias overlap), producing merges (candidate→existing identity), new cross-document RELATION edges (with evidence quotes), and untouched standalone entities. Applied deterministically where similarity is high; LLM decision only for ambiguous cases."
  - "Pipeline ORDER is fixed: refine → LINK → audit → store. LINK runs before the audit so the audit reviews the MERGED/decided entity set (final names, closure, merge-correctness); refine-only output is the degrade path."
  - "LINK retries: the LLM portion retries ≤3 (aligned with refine retry policy) with repair retry on schema mismatch; on total failure it degrades to deterministic-only results (exact/alias/substring merges still apply) and does NOT block ingestion."
  - "LINK context/output contract is bounded: input = refine JSON candidates + top-k existing-entity matches (name/type/similarity/evidence quote, no full documents); output = strict json_schema {merges, new_edges, standalone} with endpoint validation (merge from∈candidates, to∈existing; edge endpoints∈candidates∪existing) and max_tokens caps. No document/markdown re-emission."
  - "Merged entities accumulate source provenance: source_docs / wiki_paths lists are updated on every merge, so an entity records every document that mentions it; deletion protection reads the same list."
  - "Concurrency handled: parallel uploads' LINK write phase serializes (short global mutex) or the LINK runs as a batch post-write job — per the decision recorded in the spec; no lost/conflicting merges under parallel uploads."
  - "The weekly knowledge-base audit (T15 flow) re-runs LINK over the recent/new entities and reports: merges applied since last audit, candidates left unlinked (with similarity scores), new cross-document edges; trigger=weekly records land in the existing auditRunsStore."
  - "Wiki-edit path reuses the SAME LINK engine on the delta-refine candidates (renames/merges discovered on edit, e.g. galleo Office → CALEO Office)."
  - "Code channel: deterministic nameUpper merge already covers code-object identity; no LLM merge needed. OPTIONAL extension (future ticket): cross-channel link between document entities and code entities (e.g. a doc mentions a CDS view present in the code graph)."
  - "Community refresh runs AFTER linking so merged entities land in one community (fixes CALEO vs CALEO Office split by naming similarity where type+evidence supports it)."
  - "Tests: pipeline-order test, parallel-upload race test, link-retry-degradation test, link contract bounds test, merge-dedup test, provenance-accumulation test, wiki-edit link reuse test, weekly re-link report test; server suite green; push required before done."
status: in_progress
---

# G4.S10: Graph-aware entity linking

## Background

Current refining extracts entities/relations per document WITHOUT seeing the
existing graph: the same real-world thing appears as separate nodes
(CALEO / CALEOs / CALEO Office — all disconnected), cross-document edges are
never created, and the Leiden community detector (G4.S9.T1) then splits
semantically-related entities into different communities. This spec adds a
dedicated LINK stage to ingest (and a weekly re-link pass in the audit) so the
graph converges: one node per real-world entity, carrying every source that
mentions it, with edges grounded in evidence.

## Design / Approach

### 1. Pipeline (decision: order = refine → link → audit → store)

```
[existing] refine (extraction-only delta, entities carry type+occurrences)
    → [NEW] link     (match candidates to existing graph; merge/edge decisions)
    → audit          (T19: review the MERGED set — merge-correctness, canonical
                      names, closure of endpoints)
    → store/overwrite → community refresh
```

Rationale for link BEFORE audit: audit is the final-quality gate and should
review the FINAL merged entity set (one entity per real-world thing, canonical
names, endpoints resolved); linking first lets audit catch over/under-merges and
name conflicts once. refine→audit→link would double-normalize (audit fixes a name,
link re-merges to the existing node, audit runs on intermediate).

LINK degradation: LLM link failure (retry exhausted) → skip LLM decisions, keep
deterministic merges, audit still runs on the deterministic set — ingestion
never blocked by link.

### 2. LINK input/output contract (tight, no full documents)

Input to the LINK LLM:
1. Candidate entities/relations from refine (name/type/description/occurrences).
2. For each candidate, top-K (≤5) existing-graph matches:
   `{name, type, similarity, evidence_quote(≤80 chars)}`.
3. Optional compact context: candidate occurrences (short quotes).

Input is bounded: refine JSON + per-candidate top-5 matches — no full
documents, no full graph, no markdown re-emission.

Output = strict json_schema, capped max_tokens:
```
{
  "merges": [{"from": "<candidate name>", "to": "<existing name>",
                  "similarity": 0.85, "evidence": "<≤80 chars>"}],
  "new_edges": [{"source": "...", "target": "...", "relation": "HAS_OFFICE",
                  "evidence_quote": "<≤80 chars>"}],
  "standalone": ["SAP"]
}
```
Validation after the LLM call: from/to in merge must exist in candsates +
existing; edge endpoints must be candidates/existing; no phantom nodes; capped
output size. Schema mismatch → one repair retrs (same as refine repair).

### 3. Deterministic merge rules (no LLM)

- exact nameUpper / alias / substring / ≥0.92 vector similarity AND same
  canonical type → merge automatically.
- Type-aware: different canonical types → NEVER merge; offer a typed edge
  instead (HAS_OFFICE / PART_OF / EMPLOYS — via LLM ambiguous path).
- Type normalization map BEFORE matching: `organization→org`,
  `group (org context)→org`, `place→location`, `other→prompt LLM`.
- Wait for the enum hard-validation in the refinement schema
  (observed organization/group leaking in beside org).

### 4. Concurrency (decision here)

Default: **serialized write phase** — LINK reads parallel; writes (merge +
edge application) pass a global async mutex per document (ms-level, no
throughput cost). Fallbacks: batch re-link after batches of uploads; full
weekly re-link.

### 5. Source provenance

- Entities carry `source_docs` list + `wiki_paths` list; every ingest/overwrite
  appends the current document path; merge joins the lists.
- Delete cascade: removing a document also removes its path from source_docs;
  entity deletable only when list empty AND no MENTIONED_IN edges exist
  (mirrors existing mention-count protection, makes it explicit).

### 6. Weekly re-link (T15, decision: full-graph DETEW deterministic pre-scan + LLM adjudication on candidates)

Full, but layered:
1. Deterministic pre-scan (no LLM, seconds-mins on 10k-100k nodes):
   - embedding similarity ≥0.85 pairs (vector index, top-k per node)
   - naming variants / alias dupes / same-name-different-type clusters
   → candidate PAIRS (hundreds-thousands, not millions).
2. LLM adjudication on candidates only:
   - batch candidate pairs, LLM decides merge/edge/kiếu (with evidence);
   - thousands of pairs → tens-hundreds of LLM calls/week (few $ at flash).
3. Report: merges applied, unmerged candidates (with similarity), new edges;
   trigger=weekly in auditRunsStore + Admin UI.

Scale check: 1000 docs → ~10-20k entities → candidates ≤ few thousand →
fine. Even 100k entities bounded by pre-scan (0 LLM on non-candidates).

### 7. Wiki-edit shares the LINK engine

- `runWikiSave` calls the same linkCandidates() after its delta refine
  (before audit): new/edited entities are merged/ed against the graph; a
  rename ("galleo Office"→"CALEO Office") becomes an automatic re-link to the
  correct existing node.
- Degradation identical to ingest path.

### 8. Code channel (CDS/ABAP/U5/DDIC) — deterministic only

- Code extraction is deterministic parse (no LLM) and object names are unique
  in the system → plain nameUpper MERGE already resolves identity; NO LLM
  merge needed.
- Optional future extension: link recipe entities ↔ code objects (document
  mentioning a CDS view connects to the code entity) — NOT in scpoe of T1-T3.

### 9. Community synergy

- Community refresh (G4.S9.T1) runs AFTER linking, so merged identities form
  one node → one community.

## Dependencies

- G4.S8 (ingest/refine/delete stable, review gate), G4.S9 (community +
  summaries + weekly audit integration; LINK feeds richer graphs to both).

## Deliverables

- LINK engine in server ingest pipeline + wiki-edit reuse (rules + LLM
  fallback + retry/repair + atomic writes + concurrency lock).
- Source provenance on entities.
- Weekly re-link in audit (deterministic prescan + candidate LLM) + report/
  Admin visibility.
- Tests + docs/ADR-0010.

## Notes

- Reuse G4.S8 retrieval (embedder, BM25) — LINK only needs vector/BM25 over
  identities + existing capabilities.
- `nameUpper` is the identity key; aliases extend it.
- The LINK LLM uses the extraction-class caller (reasoning off, json_schema),
  same provider path.
- Ticket split: T1 = LINK engine (rules+LLM+retry+atomic+lock+contract),
  T2 = provenance + type normalization + validation, T3 = weekly re-link +
  report + Admin UI.
