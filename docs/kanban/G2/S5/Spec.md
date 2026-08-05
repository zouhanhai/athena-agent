---
id: g2_s5
title: "G2.S5: Data/Document Input Interface (docling Parsing + Progress Bar)"
layer: S
parent: G2
owner: eng-director
status: active
milestone: M2
acceptance_criteria:
  - "Frontend Knowledge panel has 'Add Data' area: file upload + URL input"
  - "Supports all docling formats (pdf/docx/xlsx/pptx/image/HTML/URL etc.)"
  - "docling uniformly parses raw files/URLs → Markdown → dual-pipeline ingestion"
  - "Each source has processing progress bar (pending/parsing/ingesting/done/failed)"
  - "Backend has /api/kb/ingest (files) + /api/kb/ingest-url (URL)"
  - "Task status pollable (progress bar)"
---

# G2.S5: Data/Document Input Interface (docling Parsing + Progress Bar)

## Task

Implement knowledge base data/document input interface — frontend upload/URL + docling unified parsing + dual-pipeline ingestion + progress bar.

## Key Dependencies

- G2.S3 (dual-pipeline ingestion service)
- G2.S4 (frontend Knowledge panel)

## Architecture

```
Frontend 'Add Data' area (file drag/drop/select + URL)
  → Backend /api/kb/ingest (files) / /api/kb/ingest-url (URL)
    → docling unified parsing (pdf/docx/xlsx/pptx/image/HTML/URL → Markdown)
      → Save to shared input-dir (markdown)
      → Dual pipeline: LightRAG (S1) + llm_wiki (S2)
    → Task status tracking (pending/parsing/ingesting/done/failed)
  → Frontend progress bar polls /api/kb/task/:id
```

## Implementation

### 1. docling Unified Parsing Layer (6900XT Python)
- Install docling (pip install docling, Python 3.10+)
- Supported formats: PDF/DOCX/XLSX/PPTX/images(PNG/JPEG/TIFF/BMP/WEBP)/HTML/EPUB/CSV/Markdown/LaTeX etc.
- URL: docling directly fetches web pages → Markdown
- (Optional) Legacy DOC/XLS/PPT need LibreOffice
- Parsing result → Markdown → shared input-dir

### 2. Backend Ingestion API (server/src/routes/kb.ts)
- `POST /api/kb/ingest` (multipart file upload) → docling parse → dual pipeline
- `POST /api/kb/ingest-url` (URL) → docling fetch → dual pipeline
- Task queue: maintain per-source status (id, source, status, progress)
- `GET /api/kb/task/:id` (poll progress)

### 3. Frontend (Knowledge panel)
- 'Add Data' area: file drag/drop/select + URL input box + supported format hints
- Per-source progress bar (pending/parsing/ingesting/done/failed)
- Poll backend task status

## Reference

- Spec: `docs/kanban/G2/Goal.md`
- Design: `docs/knowledge-rag-design.md` (dual-pipeline Plan C)
- docling: https://github.com/docling-project/docling (supported formats)

## How to Locate Reference Docs

- `parent: G2` → `docs/kanban/G2/Goal.md`
- Dual pipeline: `docs/knowledge-rag-design.md` Plan C

## Notes

- docling unified parsing, avoids installing separate parsers for each format
- Task status in-memory queue suffices (POC), can persist later
- Progress bar: parsing(docling) + ingesting(dual pipeline) two stages
- Use **implement** + tdd + code-review

## Dependencies

- G2.S3 (dual pipeline), G2.S4 (frontend panel)

## Log
