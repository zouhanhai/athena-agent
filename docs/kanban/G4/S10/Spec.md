---
id: G4.S10
title: "G4.S10: Graph-aware entity linking — ingest-time merge/link step + weekly re-link in the audit"
layer: S
parent: G4
owner: pm
status: backlog
acceptance_criteria:
  - "Ingest pipeline gains a LINK stage between refine and store: refine output (candidate entities/relations) is matched against the EXISTING graph (vector/BM25 similarity + name/alias overlap), producing merges (candidate→existing identity), new cross-document RELATION edges (with evidence quotes), and untouched standalone entities. Applied deterministically where similarity is high; LLM decision only for ambiguous cases."
  - "Merged entities accumulate source provenance: source_docs / wiki_paths lists are updated on every merge, so an entity records every document that mentions it; deletion protection reads the same list."
  - "Concurrency handled: parallel uploads' LINK write phase serializes (short global mutex) or the LINK runs as a batch post-write job — per the decision recorded in the spec; no lost/conflicting merges under parallel uploads."
  - "The weekly knowledge-base audit (T15 flow) re-runs LINK over the recent/new entities and reports: merges applied since last audit, candidates left unlinked (with similarity scores), new cross-document edges; trigger=weekly records land in the existing auditRunsStore."
  - "Community refresh runs AFTER linking so merged entities land in one community (fixes CALEO vs CALEO Office split by naming similarity where evidence supports identity)."
  - "Tests: parallel-upload race test (two docs sharing an entity → one node, both sources recorded); merge-dedup test; evidence-grounded edge test; weekly re-link report test; suite green; push required before done."
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

### 1. Pipeline: refine → LINK → store → community

```
[existing] refine (extraction-only delta) → [NEW] link → store/overwrite → community refresh
```

- LINK reads the candidate entities/relations from the refine output and
  queries the EXISTING graph: exact nameUpper match, alias match, vector
  similarity (embed the candidate name+description, top-k), and BM25 on the
  entity index.
- Deterministic rules first (no LLM): exact/substring/alias/≥0.92 vector
  similarity → MERGE automatically. Ambiguous (0.6-0.92) → one LLM call with
  the top-k candidates + evidence quotes → decision.
- Output of LINK: `{ merges: [{from, to, similarity, evidence}], new_edges: [...] ,
  standalone: [...] }`, applied in one atomic batch per document.
- LLM failure → skip LINK decisions, keep refine output (degrade, not block).

### 2. Source provenance on entities

- Entities carry `source_docs` (list) and `wiki_paths` (list); every
  ingest/overwrite appends the current document path; merge joins the lists.
- Deletion cascade: removing a document also removes its path from
  source_docs; only when the list is empty AND no MENTIONED_IN edge remains
  can the entity be deleted (mirrors the existing mention-count protection,
  makes it explicit).

### 2b. Type normalization and type-aware merging (prerequisite for LINK)

- Refinement already tags each entity with a preset type enum
  (`org | person | product | event | location | concept | other`) using the
  source-document context — keep that as the primary signal (the document is
  the richest context for typing).
- Enforce the enum: the refinement schema hard-validates `type ∈ enum`
  (today the prompt lists it but the schema does not constrain it — observed
  `organization` / `group` leaking in beside `org`).
- LINK applies a normalization map BEFORE matching:
  `organization→org`, `group` (org context)→`org`, `place→location`, etc.
  so merge candidates compare on a single canonical type set.
- Merge rule is type-aware: same canonical type + high similarity → MERGE
  candidate; different canonical types (CALEO org vs CALEO Office location)
  → NEVER merge, instead propose a typed edge (HAS_OFFICE / PART_OF /
  EMPLOYS… decided by LINK/LLM). Missing/`other` type → route to the LLM
  ambiguity path.

### 3. Concurrency strategy (decision here)

- Default: **serialized write phase** — LINK reads run in parallel; writes
  (MERGE decisions + new edges) pass a global async mutex per document.
  At our scale (ms-level writes) this is a single await; no throughput cost.
- Fallback documented: batch re-link after multiple uploads, or full weekly
  re-link.

### 4. Weekly re-link in the audit (T15 flow)

- The audit re-runs LINK over entities that changed since the last audit:
  candidates = entities whose source_docs changed, plus entities with low
  degree / naming variants. Produces a "re-link report": merges performed,
  candidates left unmerged (with similarity), new cross-document edges.
- Stored in the existing auditRunsStore with trigger=weekly; surfaced in the
  Admin UI alongside the community-quality section.

### 5. Community synergy

- Community refresh (G4.S9.T1) runs AFTER linking, so merged identities form
  one node → one community. A follow-up ticket may also pre-connect
  name-similar entities in the clustering input, but linking is the primary
  convergence mechanism.

## Dependencies

- G4.S8 (ingest/refine/delete stable), G4.S9 (community + summaries + weekly
  audit integration; LINK feeds richer graphs to both).

## Deliverables

- LINK stage in the server ingest pipeline (rules + LLM fallback + atomic
  writes + concurrency lock).
- Source provenance (source_docs / wiki_paths) maintained on entities.
- Weekly re-link pass in the audit + report; Admin visibility.
- Tests (engine correctness, race, provenance, weekly report) + docs/ADR-0010.

## Notes

- Reuse G4.S8 retrieval (embedder, BM25) — LINK mainly needs vector/BM25 over
  entities, an existing capability.
- `nameUpper` is the identity key; aliases extend it.
- The LLM in LINK is the extraction-class caller (reasoning off, json_schema),
  same provider path as refine/audit.