---
id: g3_s5
title: "G3.S5: Uploads Page (Per-System Ingest Detail)"
layer: S
parent: G3
owner: pm
status: done
milestone: M3
acceptance_criteria:
  - "Uploads is an independent sidebar tab (knowledge-base platform: ingest is core)"
  - "Detail of per-system processing stages: docling / LightRAG / llm_wiki each with their sub-steps"
  - "LightRAG chunk progress (e.g. chunk 12/182) surfaced to the UI"
  - "Task status reflects REAL LightRAG backend state (processing/processed/failed), not a false done"
  - "Uses the global Chat panel (S3) — no separate chat on this page"
---

# G3.S5: Uploads Page (Per-System Ingest Detail)

## Task

Build the Uploads page — an independent tab showing detailed per-system ingest progress (docling / LightRAG / llm_wiki), with LightRAG chunk progress and real backend status. Uses the global Chat panel (S3). This extends the G2 ingest functionality into a first-class page.

## Key Dependencies

- G2 ingest pipeline (docling parse + LightRAG + llm_wiki)
- G3.S3 (global chat panel — used, no separate chat)
- LightRAG document status API (/documents)

## Architecture

```
Uploads page (center content area)
┌──────────────────────────────────────────────┐
│ Upload area: drag/drop/select/URL             │
├──────────────────────────────────────────────┤
│ Task list (one card per upload)              │
│ ┌──────────────────────────────────────────┐ │
│ │ [filename] [status badge] [retry/del]    │ │
│ │ docling  parse  ✅/⏳/❌                  │ │
│ │   ├─ read file                           │ │
│ │   └─ parse + OCR + image desc            │ │
│ │ LightRAG ingest ⏳ chunk 12/182           │ │
│ │   ├─ chunking  ✅ 182 chunks             │ │
│ │   ├─ entity/relation extraction ⏳        │ │
│ │   ├─ graph build                         │ │
│ │   └─ embedding                           │ │
│ │ llm_wiki   ⏳                            │ │
│ │   ├─ classify                            │ │
│ │   ├─ write page                          │ │
│ │   └─ rebuild index                       │ │
│ └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
(Global Chat panel S3 on the right)
```

## UI Placement (Decided)

- Uploads is an independent sidebar tab (like Knowledge/Wiki/Workbench).
- Center content = upload area + detailed task cards.
- Global Chat (S3) on the right.

## Implementation

### 1. Uploads page (frontend)
- Independent sidebar item (Uploads)
- Upload area (drag/drop/select/URL) — reuse G2 Add Data logic
- Task list with detailed per-system progress

### 2. Per-system processing stage model (backend)
- Extend task model with per-system sub-steps:
  - docling: read file / parse+OCR+image desc
  - LightRAG: chunking / entity extraction / graph build / embedding
  - llm_wiki: classify / write page / rebuild index
- Each sub-step has status (pending/running/done/failed)

### 3. LightRAG real status + chunk progress
- Poll LightRAG /documents for real status (processing/processed/failed)
- Chunk progress: parse LightRAG log (`Chunk N of 182`) or a status field
- Task must NOT show false "done" — reflect LightRAG backend reality

### 4. Athena chat integration
- Use global Chat panel (S3); user can ask Athena about ingest while working

## Reference

- Spec: `docs/kanban/G3/Goal.md`
- Requirements: `docs/g3-requirements.md` §2 (Uploads tab) + SUPERSEDED layout
- G2 ingest pipeline (existing)

## How to Locate Reference Docs

- `parent: G3` → `docs/kanban/G3/Goal.md`
- Requirements: `docs/g3-requirements.md` §2
- G2 ingest: `docs/knowledge-rag-design.md`

## Notes

- Extends G2 functionality into a first-class page (G2 is done; this is G3 scope).
- Key fix: task status must reflect real LightRAG backend state (not false done).
- Use **implement** + tdd + code-review

## Dependencies

- G2 ingest pipeline, G3.S3 (global chat)

## Log
