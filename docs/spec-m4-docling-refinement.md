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
New: `parsing (docling)` → **`refinement (LLM: re-header + quality + topic)`** → parallel stages.

- Reuses the same model as llm_wiki classification (`deepseek-v4-flash-latest` via OpenRouter) for
  consistency/cost. Athena (server knowledge agent) is the natural orchestrator, but the step itself
  is a deterministic LLM call, not the chat agent.
- Must be **optional/degradable**: if the LLM step fails, fall back to the docling output (no worse
  than today).

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
