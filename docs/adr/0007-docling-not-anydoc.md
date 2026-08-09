# ADR-0007: Continue using docling for document parsing (not anydoc)

## Status

Accepted (2026-08-08). Recorded to avoid re-litigating the choice.

## Context

We evaluated **firecrawl/anydoc** (Rust, 12.2k stars) as a possible replacement for **docling**
(our current parser) for converting office documents / PDFs to Markdown before LightRAG + llm_wiki.

anydoc strengths:
- Extremely fast (median ~4.4ms/doc vs docling ~513ms/doc)
- Native Rust parsing of 14 formats (Word/PPT/Excel/ODF/RTF/EPUB/CSV/PDF), one consistent GFM output
- Node/Python/WASM bindings, ships an Agent Skill

docling strengths (why we keep it):
- **Image content capture**: docling runs layout/OCR models + our **OpenRouter VLM** picture
  descriptions (`parse_doc.py` `PictureDescriptionApiOptions`), so **figures, charts, and
  screenshot content become searchable text**. This is critical for SAP/finance documents
  (consolidation reports, BW dashboards, table screenshots).
- **Scanned PDF OCR** support.
- Broad format support already wired: PDF, DOCX/XLS, PPTX, images, HTML, EPUB, CSV, MD/TXT, LaTeX,
  OpenDocument, etc. (see `server/scripts/parse_doc.py` `SUPPORTED_EXTENSIONS`).

anydoc limitations for us:
- **Does NOT interpret images** — embedded images become alt-text placeholders + raw bytes; image
  content is lost (not retrievable via RAG).
- Text-only PDF support (scanned PDFs need the hosted OCR service).

## Decision

**Keep docling** as the document parsing layer. Its image/OCR + VLM description capability is more
important to us than parsing speed. Slow conversion (~2.5h for a 353-page file) is acceptable because
**complete information preservation matters more than speed** (user decision).

anydoc is noted as a possible future **supplement** for pure-text Office documents if conversion
quality/speed ever becomes a bottleneck — not a replacement.

## Consequences

- No parser swap needed; existing ingest pipeline (docling → frontmatter → LightRAG + llm_wiki) unchanged.
- Revisit only if image-content capture becomes unnecessary or docling quality degrades.
