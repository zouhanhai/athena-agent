# M4 Spec — Post-docling LLM document refinement step (quality-gate + semantic re-mark)

**Status**: Planned (2026-08-09) · **Milestone**: M4 · **Owner**: eng-director

## Problem

`docling` parses documents with a **fixed ML layout model** (not an LLM). For PDFs it infers
heading levels from visual features (font size / boldness / position), which can be flat/wrong
(e.g. the Sommerseminar-2023 schedule came out as **16× `##`**, all h2). Its text-extraction
quality also varies by source quality. Relying on it alone for the markdown that feeds
LightRAG + llm_wiki means heading hierarchy, completeness, and topic decisions are all locked to
that deterministic model.

## Proposal

Insert a **post-docling LLM refinement step** in the ingest pipeline (between docling parse and the
LightRAG / llm_wiki parallel stages). One LLM pass over the extracted markdown does the full-document
semantic work that docling can't, and that currently would otherwise be scattered:

1. **Header re-level** — re-mark heading hierarchy semantically (`#`/`##`/`###`…), so a doc isn't a
   flat wall of h2. Produce a clean outline (few top-level headings, nested sub-headings).
2. **Quality check** — compare the extracted markdown against the source (completeness: are all
   sections present, no garbled/omitted text, tables/figures captured). Return a confidence/flag when
   extraction is suspect so the operator can review/re-upload.
3. **Topic judgment** — confirm/refine the topic classification (this already exists via llm_wiki
   agent; fold it into this step so it's one coherent full-doc pass).
4. **Chunking** — use paragraph-semantic segmentation. *(Already done — `DEFAULT_CHUNKING =
   paragraph_semantic` in lightrag.ts, G3.S8.T2. Keep here as the policy decision, no new code.)*

## Where it fits

Current pipeline (tasks.ts): `parsing (docling)` → `ingesting_lightrag ‖ ingesting_llmwiki`.
New: `parsing (docling)` → **`refinement (Athena LLM: re-header + quality + topic)`** → parallel stages.

## Why one combined step (context-efficiency) — decided 2026-08-09

The whole ingest chain currently has **several full-document / per-chunk LLM passes**, which is
context-exploding and costly if we add ANOTHER full read:

| Stage | LLM pass | Reads |
|-------|----------|-------|
| docling | image VLM description | images only |
| llm_wiki | classify (type+topic) | full doc |
| LightRAG | entity extraction | every chunk |
| LightRAG | keyword extraction | every chunk |
| LightRAG | paragraph-semantic chunking | chunks |
| LightRAG | embedding | chunks (non-dialog, necessary) |

So fold the FULL-DOC semantic work into **one Athena pass** that reads the document once and emits
everything downstream needs:

1. **Re-leveled markdown** (header hierarchy) → feed to BOTH LightRAG + llm_wiki.
2. **Classification** (type + topic) → write frontmatter; llm_wiki writes page, LightRAG carries it in
   content_summary.
3. **Quality report** (md vs source) → operator/log.

## How info flows downstream + remaining LLM steps (analysis)

**Easy / low-risk (M4 scope):**
- Re-leveled markdown + classification flow to both systems as the ingest input.
- This removes the DUPLICATE full-doc reads: llm_wiki classify (was reading the doc) + our refinement
  (would read it) become ONE Athena pass. LightRAG still does its own chunking/entity/keyword internally.

**Hard / needs LightRAG change (M4 spike, high risk):**
- To ALSO remove LightRAG's per-chunk LLM passes (entity extraction, keyword extraction, paragraph
  chunk), Athena would pre-extract entities/relations/chunk-boundaries and LightRAG would have to
  accept them instead of running its own LLM. `extract_entities` (operate.py) is a hardcoded internal
  LLM call with **no external-injection interface** — this needs a LightRAG fork/patch, workload unknown.
- Recommendation: **M4 = low-risk layer** (Athena re-header + quality + topic, one read); **M4+ spike**
  to verify whether LightRAG can accept pre-extracted entities/chunks before committing to it.
- `embedding` stays in LightRAG (necessary, non-dialog).

## Open decisions (M4)

- Model + prompt: single prompt doing all three, or separate passes? (single cheaper; separate more
  controllable).
- Quality-check output: flag + human review queue, or auto-accept with a low-confidence tag?
- Re-header: rewrite the md in place (mutating the parsed markdown) vs emit a header outline map.
- Interaction with incremental re-curation (re-topic) — this step only affects NEW ingests; existing
  docs re-curated via the M4 re-curation tool.

## Reference

- `server/src/kb/ingest.ts`, `server/src/kb/tasks.ts` (pipeline stages)
- `server/scripts/parse_doc.py` (docling, `save_as_markdown`)
- `server/src/kb/lightrag.ts:130` (`DEFAULT_CHUNKING = paragraph_semantic`)
- `docs/knowledge-rag-design.md` (retrieval / agentic RAG note)
