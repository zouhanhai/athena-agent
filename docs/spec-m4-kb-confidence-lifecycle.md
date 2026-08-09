# M4 Spec — KB confidence & lifecycle in wiki frontmatter

**Status**: Planned (2026-08-09) · **Milestone**: M4 · **Owner**: eng-director

## Motivation

(From LLM Wiki v2, gist rohitg00/2067ab416f7bbe447c1977edaaa681e2 — "steal the ideas".)
Knowledge has a lifecycle: some facts are fresh and reliable, others stale. A wiki that treats
every claim as equally valid rots. We already store wiki pages as markdown with frontmatter — the
natural place to carry confidence + lifecycle is the frontmatter, so **Athena's KB review** can see,
for every file: when it was ingested, how often it's read, when it was last re-evaluated, and its
topic path (including changes over time). Then decide re-topic, re-classify, or deprecate.

## Current frontmatter (example)

```yaml
---
type: event
title: Sommerseminar Mallorca 2023.pdf
topic: internal/events
created: 2026-08-09
updated: 2026-08-09
---
```

## Proposed frontmatter additions

```yaml
---
type: event
title: Sommerseminar Mallorca 2023.pdf
topic: internal/events            # current topic
created: 2026-08-09               # initial ingest date (exists)
updated: 2026-08-09               # last content/edits (exists)
read_count: 0                     # times Athena/retrieval read this page
last_reviewed: 2026-08-09         # last Athena re-evaluation date
confidence: 0.85                  # 0..1 — sources supporting, recency of confirmation, no contradictions
topic_history:                    # ordered list of past topics (migration trail)
  - internal/events
---
```

## How each field is used

| Field | Meaning | Set / updated by |
|-------|---------|------------------|
| `read_count` | how many times Athena/retrieval surfaced this page | incremented on retrieval read |
| `last_reviewed` | when Athena last reviewed/re-evaluated it | Athena KB review pass |
| `confidence` | reliability score (source count, recency, contradictions) | Athena review; decays over time |
| `topic_history` | past topics (audit trail for re-curation) | appended when topic changes |

## Athena KB review workflow (M4, ties into incremental re-curation)

- Athena reviews the KB on a schedule / on demand: scan frontmatter of all wiki pages.
- For each page, decide based on the lifecycle fields:
  - **re-topic** → update `topic`, append to `topic_history`, bump `last_reviewed`.
  - **re-classify** → update `type`.
  - **deprecate / fade** → lower `confidence`; if very stale + rarely read, flag for archive.
  - **reinforce** → a fresh source confirming the page raises `confidence`.
- `read_count` + `last_reviewed` tell Athena what's actually used vs rotting.
- Retaining the topic migration trail (`topic_history`) makes re-curation auditable.

## Relationship to other M4 work

- Complements **incremental re-curation** (re-topic, deeper sub-topics) — topic_history is the audit
  trail; confidence guides *what* to re-evaluate.
- Complements **post-docling LLM refinement** — Athena's single read pass can also emit/set these fields.
- **No LightRAG re-chunk/embedding needed** for any of this (topic filtering is wiki-frontmatter driven;
  these fields live in the wiki md frontmatter only).

## Reference

- LLM Wiki v2 gist: https://gist.github.com/rohitg00/2067ab416f7bbe447c1977edaaa681e2 (confidence,
  supersession, forgetting, consolidation, quality).
- `docs/spec-m4-docling-refinement.md`, M4 incremental re-curation.
