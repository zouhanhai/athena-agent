# TOC-first header grading (G4.S10.T6)

When a document ships a real table of contents, the document's own hierarchy is the
ground truth for the refinement header-grading step: it beats LLM re-grading, which is
non-deterministic and reconstructs hierarchy worse than the source does (2026-08-26
empirical evidence on the SAP "CDS Views for Finance" extract: 14150 flat docling
headers; LLM grading produced a wildly wrong hierarchy + ~12000 template pseudo-headers,
while a deterministic TOC pre-order match reproduced D4→h1 … D8→h5 cleanly).

The refine pipeline (`refine_document`) now prefers a TOC when available and falls back
to the existing LLM `judgeHeaderLevelsLLM` path only when there is none.

## The three TOC sources (in priority order)

| Provider | `headerGrading.source` | Where it comes from |
|---|---|---|
| Docling outline (PDF bookmark layer) | `pdf-outline` | `parse_doc.py` exports the docling section tree to `<stem>.outline.json` next to the parsed markdown; `DoclingParser.parse()` reads it and the ingest task passes it into the refine tool (`outline` param). |
| Markdown TOC preamble | `markdown-toc-preamble` | A contiguous run of ≥3 bullet entries near the top of the markdown, default requiring the link form `- [Title](…)` (the pattern at the top of SAP exports). Indentation (2 spaces/level) encodes the hierarchy. Configurable via `MarkdownTocPreambleOptions`. |
| External TOC at refine time | `external` | Anything passed as `toc` in the `refine_document` tool call (or the 4th arg of `createAthenaRefiner`'s refiner) — e.g. the SAP Help Portal `fullToc` fetched by the uploader. |

Accepted TOC shapes (`parseTocInput`): a JSON string, a flat array of strings or
`{title|text|name}` entries, nested `{title|text, children}` entries (the SAP `fullToc`
shape), a `{toc|tree|items|children: [...]}` wrapper, or a single node used as root.
Levels are **structural** (root = 0, first section level = 1) — explicit `level` fields
are ignored so malformed data can never skew the walk.

## Deterministic grading

- The TOC is flattened into its **pre-order walk** (root excluded).
- Each md heading is normalized (`normalizeHeadingText`: strip trailing page numbers
  "Title, 12", trailing parenthesized suffixes "(ABAP)", leading numbering "1.2.3 ",
  markdown emphasis/code markers, punctuation + whitespace, case-fold) and matched with
  a **forward-only cursor** over the pre-order walk — duplicate TOC titles bind to their
  document-order occurrences.
- Matched heading → `tocDepthToMdLevel(depth)`: first section level after root → h1, each
  deeper level +1, clamped at h5 (default). Parameterized via `tocDepthMapping`
  (`baseLevel`/`maxLevel`, e.g. for a 6-level cap).
- Unmatched headings keep their **conservative ORIGINAL (docling) level** — never worse,
  no LLM.
- A detected-but-zero-match TOC (false positive, e.g. a stray link list) is treated as
  "no TOC": the next provider is tried, then the LLM judge.

## Fallback

- No TOC anywhere → `judgeHeaderLevelsLLM` unchanged (mode `llm`).
- Partial TOC → matched sections per TOC, unmatched keep conservative defaults.
- A throwing provider is logged and skipped — TOC detection never blocks refinement.

## Report

The refinement report (tool `details.headerGrading`) and the stored ref
(`ref.header_grading`) carry:

```jsonc
{
  "mode": "toc",            // "toc" | "llm"
  "source": "external",     // "pdf-outline" | "markdown-toc-preamble" | "external"
  "tocMatched": 1927,       // (ref field: toc_matched) md headings matched
  "tocTotal": 1977          // (ref field: toc_total) TOC nodes in the pre-order walk
}
```

## Wiring an SAP Help Portal `fullToc` as the external TOC

The SAP Help Portal exposes the deliverable TOC over HTTP:

```
GET /http.svc/pagecontent?deliverableInfo=1&deliverable_id=<deliverable id>
  → data.deliverable.fullToc   // nested [{"title": "...", "children": [...]}] array
```

A helper in the uploader-side skill (`sap-help-docs-bulk-download`) can fetch `fullToc`
for a delivered doc and pass it to refine. Two wiring points — either is enough:

1. **Upload refiner** (production pipeline): `createAthenaRefiner`'s refiner accepts the
   docling outline as the 4th argument. For the SAP API TOC, call the refiner (or the
   `refine_document` tool) with `toc: <fullToc payload>`. The ingest task passes the
   docling outline automatically; the external TOC is passed by the caller.
2. **Direct tool call**: the Pi agent can call `refine_document` with an extra
   `toc` parameter (any accepted shape, e.g. `data.deliverable.fullToc`):

```json
{
  "markdown": "...",
  "toc": [
    { "title": "CDS Views for Finance", "children": [
      { "title": "Prerequisites" },
      { "title": "Data Model", "children": [ { "title": "07-CDS Views" } ] }
    ]}
  ]
}
```

No preprocessing required: page numbers, "(2023)"-style suffixes and punctuation are
normalized during matching; unmatched headings keep their original levels.

## Implementation

- `server/src/agents/header-toc.ts` — TOC model, providers, normalization, deterministic
  pre-order grading (`gradeHeadersFromToc`), the composed judge (`tocFirstJudge`) and the
  single-pass helper (`applyTocToMarkdown`).
- `server/src/agents/refine-document.ts` — `refine_document` wiring: two-stage stage-1
  judge is TOC-first; single-pass applies the TOC deterministically after the LLM pass;
  mode + counts reported in `details.headerGrading` and the stored ref.
- `server/scripts/parse_doc.py` + `server/src/kb/docling.ts` — docling outline
  (`<stem>.outline.json`) export + read.
- Tests: `server/test/header-toc.test.ts` (TOC-parse fixtures, mis/partial TOC, no-TOC
  regression), `server/test/refine-toc-first.test.ts` (pipeline: two-stage + single-pass),
  `server/test/kb/docling.test.ts` (outline sidecar).