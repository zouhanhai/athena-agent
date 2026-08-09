---
id: s1
title: "G4.S1: Post-docling Athena document refinement step"
layer: S
parent: G4
owner: consultant
status: backlog
milestone: M4
acceptance_criteria:
  - "An LLM pass runs between docling parse and the LightRAG/llm_wiki parallel stages"
  - "It re-levels headers (semantic #/##/###), quality-checks md vs source completeness, and confirms type/topic — all in ONE full-doc read"
  - "Falls back to the raw docling output if the LLM step fails (never worse than today)"
  - "Output contract (entities/chunk/topic/header) is defined and feeds G4.S2 RAG self-build"
  - "Same model (deepseek-v4-flash-latest) for consistency/cost"
---

# G4.S1: Post-docling Athena document refinement step

## Background

docling uses a fixed ML layout model (not LLM) — PDFs can come out flat (e.g. Sommerseminar = 16× h2)
and extraction quality varies. Relying on it alone means heading hierarchy, completeness, and topic
decisions are locked to that deterministic model.

## Full design

See `docs/spec-m4-docling-refinement.md` — it is the authoritative spec for this goal. Key points:

- **One Athena LLM pass** after docling reads the full document once and emits:
  1. re-leveled markdown (header hierarchy),
  2. quality check (md vs source completeness),
  3. topic/type judgment (fold in the existing llm_wiki classify),
  4. chunk segmentation (paragraph-semantic, already the policy).
- **Context-efficiency**: folds ALL full-doc LLM passes (llm_wiki classify + this step) into one read.
- **Output contract** feeds G4.S2 — this is why S1 precedes S2.
- **Fallback**: if the LLM step fails, use the raw docling output (no regression).

## Dependencies

- G4.S2 (RAG self-build) consumes this step's output contract.

## Deliverables

- Server refinement step in the ingest pipeline (tasks.ts).
- Prompt + model wiring (OpenRouter deepseek-v4-flash-latest).
- Output contract schema (entities/chunk/topic/header/quality).
- Fallback path + tests.
