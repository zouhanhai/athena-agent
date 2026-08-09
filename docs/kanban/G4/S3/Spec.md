---
id: s3
title: "G4.S3: KB confidence & lifecycle + incremental re-curation + topic-scoped search"
layer: S
parent: G4
owner: consultant
status: backlog
milestone: M4
acceptance_criteria:
  - "Wiki frontmatter gains read_count / last_reviewed / confidence / topic_history"
  - "Athena KB review scans frontmatter and re-topics / re-classifies / deprecates / reinforces"
  - "Re-curation to deeper sub-topics works (topic_history audit trail; no LightRAG re-chunk)"
  - "Semantic search can scope to a topic subtree (topic-scoped search)"
---

# G4.S3: KB confidence & lifecycle + incremental re-curation + topic-scoped search

## Background

Knowledge has a lifecycle (from LLM Wiki v2): some facts are fresh and reliable, others stale. We store
wiki pages as markdown with frontmatter — the natural place to carry confidence + lifecycle.

## Full design

See `docs/spec-m4-kb-confidence-lifecycle.md` and the M4 KB items in `TODO.md`. Key points:

- **Frontmatter additions**: `read_count` (times Athena/retrieval read), `last_reviewed` (last Athena re-eval),
  `confidence` (0..1, decays), `topic_history` (past topics = migration audit trail). `created`/`updated` exist.
- **Athena KB review**: on schedule/on demand, scan frontmatter → decide re-topic / re-classify / deprecate(fade) /
  reinforce. `read_count` + `last_reviewed` show what's used vs rotting.
- **Incremental re-curation**: re-topic to deeper layers (e.g. `internal/events/sommerseminar`) once a topic
  dir grows. `isValidTopic` supports arbitrary depth; topic filtering is wiki-frontmatter driven → **no LightRAG
  re-chunk/re-embed**.
- **Topic-scoped search**: let a query search within a topic subtree (pre-filter candidates by wiki frontmatter
  topic before semantic scoring), for agentic-RAG scoping + precision on large corpora.

## Dependencies

- G4.S1 (refinement), G4.S2 (RAG).

## Deliverables

- Frontmatter schema (read_count/last_reviewed/confidence/topic_history).
- Athena KB review pass.
- Re-curation tool (re-topic + topic_history + index rebuild).
- Topic-scoped search in the retrieval service.
