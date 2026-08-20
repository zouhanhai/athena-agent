---
name: document-refinement
description: Athena document-refinement pass (G4.S1) — re-level headers, classify type/topic (docs/taxonomy.md), chunk paragraph-semantic, extract entities/relations/keywords, emit file-level + per-section summaries, and quality-check a docling markdown document in ONE full-document LLM read, emitting the structured refinement output contract.
---

# document-refinement — Athena refinement pass (G4.S1)

Athena is the **single full-document LLM pass** of the athena ingest chain. It reads the whole docling
markdown once and emits everything downstream needs — re-leveled markdown, frontmatter(type+topic),
chunks, entities, relations, keywords, quality, and file-level + per-section summaries — in **ONE
full-doc read**. No other LLM re-reads the
document (only the final embedding, which is vector encoding, not reasoning).

Output is constrained by the refinement JSON contract (see §8) via OpenRouter `response_format.json_schema`
wrapped around the TypeBox contract, so it is always schema-conformant. The direct-HTTP path has no
tools — you return the JSON object itself.

## 1. Header re-level (semantic hierarchy) → patches

Restore a semantic `#` / `##` / `###` hierarchy from the document **structure**, not the raw docling
levels. docling is a fixed ML layout model — it often emits **flat** headers (e.g. everything is `h2`).
Known example: the Sommerseminar doc came out with **16× `h2`**; the 827-page "Group Reporting SAP Doc"
has 3,364 headers, **ALL `h2`, no `h1`**.

Rules:

- Exactly **one** `#` (the document title). Promote the real title from a flat `h2` if needed.
- Major sections → `##`; subsections → `###`; deeper nesting only when the document genuinely implies it.
- Decide levels by **meaning** (what the heading introduces), not by position or original mark level.
- Do **not** invent heading levels the document does not imply; do not collapse real structure.
- Keep heading text verbatim (trim whitespace / stray markdown artifacts only).

Your corrections are expressed as **patches** (`refactor_heading`/`retitle_heading`), not as re-emitted
markdown. Patch `index` is the 0-based block grid position (headings + paragraphs, in document order).

## 2. Classification (type + topic) — from docs/taxonomy.md

Pick exactly **one** document type and **one** hierarchical topic. `docs/taxonomy.md` is authoritative.
The type criteria + counterexamples and the allowed topic tree are embedded in the refinement prompt
(also mirrored in `server/src/kb/taxonomy.ts`).

- **type**: what the document *is* — report / minute / spec / manual / proposal / contract / policy /
  presentation / event / source / person / entity / concept. Use the criteria + counterexamples.
- **topic**: what the document is *about* — most-specific hierarchical slash path
  (e.g. `sap/consolidation/group-reporting`, `internal/events`). Reuse an existing topic; only create a
  new one when nothing fits.

## 3. Chunking (LOCAL — paragraph-semantic, ~1200 tokens)

Chunks are built **locally by Athena** from the final rebuilt markdown
(`splitParagraphSemantic`, paragraph-semantic style, NOT fixed token windows):

- Target ~1200 tokens per chunk, ~100 token overlap.
- Prefer whole paragraphs / semantically complete sections.
- Each chunk carries a stable `id` (`c1`, `c2`, ...) and `heading_path` — the heading path of its
  section (e.g. `Sommerseminar / Workshops`).

You do **NOT** emit chunk text or ids — never include a `chunks` field.

## 4. Entity extraction (knowledge-graph nodes)

Extract the entities actually named in the document:

- **name**: TITLE-CASE, consistent naming — "CALEO", not "caleo"/"CALEO" variants (one canonical form).
  `name` is the **document-language canonical** form.
- **type**: `org` | `person` | `product` | `event` | `location` | `concept` | `other` (preset types).
- **description**: one concise sentence stating what it is in this document's context.
- **aliases**: bilingual (DE+EN) variant names of the **same node** — the node must be findable in
  **both languages** (RAG bilingual retrieval). `name` is the document-language canonical form;
  `aliases` are the other-language (and alternate) terms for the same entity. E.g. `name: "ZOB
  München"` → `aliases: ["Zentraler Omnibusbahnhof", "Munich central bus station"]`; `name: "Lüsen"`
  → `aliases: ["Lüsen"]`. Omit aliases only when no useful variant exists.
- Only direct, clearly-stated entities. Do not invent.

## 5. Relation extraction (binary edges)

Extract **binary** relations only, `source -> target`:

- `source` / `target`: must match an emitted entity name **exactly** (consistent naming).
- `keywords`: relationship keywords (the verbs/phrases expressing the edge).
- `description`: one concise sentence.
- Decompose multi-entity statements into individual binary edges.
- Include **only direct, clearly-stated, meaningful** relations (cross-RAG best practice —
  GraphRAG / LightRAG / LlamaIndex all converge on binary, direct edges). Skip speculative ones.

## 6. Keywords (relationship + query)

Emit retrieval keywords: **relationship** keywords (edge vocabulary, e.g. "hosts", "part of") **and**
**query** keywords, high-level + low-level (e.g. "sommerseminar", "schedule", "workshop").

## 7. Document summary (file-level + per-section) — G4.S2.T13

You already read the whole document, so summarize it in the same pass at two levels:

- **summary**: a FILE-LEVEL summary of ~2-3 sentences stating what the document is about and its
  most important points.
- **sections**: ONE entry per TOP-LEVEL section — `title` = the top-level H1 heading text (verbatim),
  `summary` = a concise 1-2 sentence summary of that section. This enables layered/hierarchical
  retrieval: search the file summary to locate the document, then a section summary to locate the
  section, then its chunks. Emit sections for every top-level section; use an empty array only for a
  sectionless document.

## 8. Quality checklist

- **Completeness**: does the refined markdown capture the whole source — all sections, tables, figures?
- **Tables/figures**: note any table split across pages, figure/caption dropped, image alt missing.
- **Garbled text**: flag OCR/layout garbage, encoding issues.
- **confidence**: 0..1 — how sure you are.
- **issues**: concrete list (e.g. "table on p3 split", "image caption missing").
- **action**: `auto_accept` (clean) or `review_required` (any doubt).

## 9. Output contract (JSON — DELTA/extraction, constrained sampling)

You never re-emit the markdown or the chunk texts — Athena rebuilds them locally from the original
text plus your optional patches. Emit:

```jsonc
{
  "summary": "...",                        // file-level, ~2-3 sentences
  "sections": [{ "title": "...", "summary": "..." }],  // one per top-level H1 section
  "frontmatter": { "type": "...", "topic": "..." },   // from docs/taxonomy.md
  "entities": [{ "name": "...", "type": "org|person|...", "description": "...", "aliases": ["..."] }],
  "relations": [{ "source": "...", "target": "...", "keywords": ["..."], "description": "..." }],
  "keywords": ["..."],                     // relationship + query keywords
  "quality": { "complete": true, "confidence": 0.85, "issues": ["..."], "action": "auto_accept|review_required" },
  "patches": [                             // OPTIONAL — the only text-level edits you propose
    { "op": "retitle_heading",   "index": 4, "text": "..." },
    { "op": "refactor_heading",  "index": 2, "level": 3 },
    { "op": "replace_paragraph", "index": 12, "text": "..." },
    { "op": "insert_paragraph",  "index": 15, "text": "..." },
    { "op": "delete_paragraph",  "index": 18 }
  ]
}
```

Do not truncate; but do not pad with text Athena already has.

## 10. Size budget (single read)

One Athena call's context = input (full md) + output (re-leveled md + chunks + entities + keywords +
quality). Output ≥ input, so usable input ≈ half the context. Conservative single-read cap ≈
**500 KB – 1 MB md**. Sub-1MB docs (current docs ≈ 12 KB max) → one full-doc pass. Above the cap →
two-stage refinement (local header pass → split by refined h1 → per-section full pass) — see G4.S1 Spec.
