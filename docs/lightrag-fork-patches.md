# LightRAG Local Fork Patches (Hermes)

> Local modifications to the LightRAG library (uv tool install). **These are
> overwritten by `uv tool upgrade lightrag-hku` — re-apply after every upgrade.**
> Location: `/home/hh/.local/share/uv/tools/lightrag-hku/lib/python3.11/site-packages/lightrag/`

## Patch 1: entity-extraction retry-then-skip (2026-08-07)

**File:** `lightrag/lightrag.py` → `_process_extract_entities()`
**Backup:** `lightrag.py.bak` (same dir)

### Problem
A single chunk's entity extraction failing (e.g. `JSONDecodeError: Expecting value`
when the LLM returns malformed JSON for a dense/long chunk) marked the **entire
document as `failed`** — all 182 chunks discarded. Observed on the 353-page
GroupReporting PDF: failures at chunk 7, then 10, then 12 (random LLM JSON output
quality for dense chunks).

### Fix
`_process_extract_entities()` now **retries each chunk up to 3 times**, then
**skips** it (returns `[]`) instead of raising → the document continues with the
remaining chunks. A persistently-bad chunk is logged and skipped rather than
failing the whole document.

### Re-apply after LightRAG upgrade
The patched function is identifiable by the marker comment:
```
# ---- Hermes local patch: retry failed chunk extraction, then skip
```
`grep -c 'Hermes local patch' lightrag.py` → should be ≥ 1.

Re-apply procedure:
1. `cp lightrag.py lightrag.py.bak`
2. Locate `async def _process_extract_entities(` in `lightrag.py`
3. Replace the `try/except ... raise e` body with the retry-loop version
   (see git history of this doc / the patch script used, or re-derive from the
   semantics: 3 attempts → warn+retry → else skip+return `[]`).
4. `python3 -m py_compile lightrag.py`
5. Restart `lightrag-server`.

### Related
- Upstream issue: HKUDS/LightRAG #2016 (long-doc JSONDecodeError, closed not planned)
- HKUDS/LightRAG #2339 (list-type chunks: entity density high, chunk-size doesn't help)
- HKUDS/LightRAG #2442 (delete must also clear LLM cache or re-ingest reuses corrupt data)
