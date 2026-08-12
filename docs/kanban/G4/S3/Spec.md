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

## Agentic RAG optimizations (added 2026-08-11, from docs/retrieval-analysis.md)

These need an LLM in the retrieval/generation path (deviate from S2's pure-storage lean design).
Decompose into tickets during S3 planning:

1. **Query Transformation**: if a user question is too broad, ask back for detail; or decompose the
   query into multiple sub-queries and run them in parallel, then fuse.
2. **Compression**: after recall, an LLM distills the retrieved chunks into a concise summary before
   output — controls token use and removes noise.
3. **Agentic retriever picker** (ToolsRetriever already exists but defaults to "hybrid"): the LLM picks
   the best retriever (vector/bm25/graph/hybrid) per query.
4. **Multi-hop graph reasoning**: the LLM walks the Entity/Relation graph over multiple hops to
   discover indirect associations the single-hop retriever misses.

## Feedback loop + custom semantic mappings (added 2026-08-11, front-end enhancements)

Two chat/front-end driven features that feed the KB lifecycle + retrieval:

1. **Feedback loop (thumbs up/down)**: on the Chat page, a user can upvote/downvote an answer.
   - Store Q&A pairs `{question, answer, sources, feedback}` in a DB table (reusable, avoids re-RAG).
   - Upvote = reinforce (raise `confidence` of the source chunks/document — ties into the lifecycle).
   - Downvote = fade (lower `confidence`).
2. **Custom semantic mappings (synonyms/terms)**: in the front-end, a user can map a company term /
   colloquial name to a canonical semantic (e.g. "C-Day" → "CALEO Day", "HW" → "Haushaltswaren").
   - Stored in a DB table; applied at query time so a colloquial term also matches the canonical.
   - Complements T1 Athena-extracted aliases (DE/EN) with user-curated mappings.
   - Lives on a NEW dedicated tab **"Terms & QA"** (separate from Uploads) that shows both the
     semantic mappings AND the stored Q&A pairs, with live query against the DB.
   - The **Terms & QA** tab also lets a user **manually add Q&A pairs** (typed in directly as
     knowledge injection, in addition to the Feedback-loop Q&A pairs that are auto-stored).

## KB-as-MCP: topic-scoped search contract for external agents (G4.S6)

The KB will be exposed as an **MCP server** (primary path for agents — OpenCode/Claude Code/Codex/
Hermes all speak MCP client). T4 (topic-scoped search) is the retrieval capability it wraps. When
building the MCP server, the **topic contract for external agents MUST be documented**:

- **Tool**: `search_knowledge(query, topic?)` — `topic` is a wiki frontmatter topic subtree (e.g.
  `internal/events`, `sap`, or `sap/group_reporting`). Omit/empty = whole-corpus search.
- **How an agent chooses `topic`**: the agent's LLM decides the relevant domain(s) from the question
  (topic = Athena's knowledge-navigation: determine topic → converge document domain → search within it).
  The MCP tool description should teach this: "if the question is about a specific domain, pass its
  topic subtree to scope the search; otherwise omit for a whole-corpus search."
- **Sibling tools**: `get_wiki_page(path)` (read a wiki page's content + frontmatter), `get_graph()`
  (knowledge-graph nodes/edges). Retrieval results carry `wikiPath`/`sectionPath` so an agent can
  group chunks by source page and fuse analysis.
- **Auth**: MCP server auth'd (per-employee/agent token); agents reach it over Tailscale.
- Alias mapping (T6) + bilingual aliases (S2.T1) apply at query time, so a colloquial/cross-language
  term in `query` still matches canonical text within the scoped topic.

## Dependencies

- G4.S1 (refinement), G4.S2 (RAG).

## Deliverables

- Frontmatter schema (read_count/last_reviewed/confidence/topic_history).
- Athena KB review pass.
- Re-curation tool (re-topic + topic_history + index rebuild).
- Topic-scoped search in the retrieval service.
