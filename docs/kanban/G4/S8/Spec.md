---
id: G4.S8
title: "G4.S8: Ingest pipeline robustness — docling cache, key separation, refine delta contract"
layer: S
parent: G4
owner: consultant
status: approved
milestone: M4
acceptance_criteria:
  - "Parse caching: re-uploading an identical local PDF skips docling (SHA-256 sidecar), keyed on source content, not filename"
  - "Refinement provider is Pi-resolvable and key-separated from chat; contextWindow corrected to the real model value; large-doc output no longer truncates"
  - "LLM refinement output contract shrinks to extraction + optional patches (no full markdown re-emission); chunks are built locally"
  - "Uploads of >10MiB multipart files arrive intact (self-overwrite race fixed/document upload tests green)"
  - "llm_wiki API 413 on huge pages no longer crashes the ingest pipeline"
---
# G4.S8: Ingest pipeline robustness

## Background (2026-08-20, GR 2.4MB ingest debugging session)

While getting Group-Reporing-SAP-Doc.pdf (2.4MB) through the ingest pipeline, the following real
defects surfaced together:

1. **Stale/broken OpenRouter key** (`c62a69` deleted in the OpenRouter console but still baked into
   `~/.bashrc` base64 + start-all.sh) → all refinement calls 401'd silently → "no structured output"
   fallback.
2. **Key separation impossible-ish**: Pi's ModelRuntime does NOT resolve arbitrary custom provider ids
   added to `auth.json`/`models.json` (`athena-ingest`, `athenaingest` both returned "Provider is not
   configured"). Only the already-known `athena` provider resolves. The dedicated ingest key (aba...a55)
   exists but Pi refuses the custom id — design decision needed on how to use per-purpose keys.
3. **contextWindow lie**: models.json said 131072 for deepseek-v4-flash-latest; OpenRouter reports
   1310720. Any >131K-token input was implicitly refused → refinement never ran an honest full read.
4. **Output truncation**: two-stage stage-2 emits the FULL rebuilt markdown as tool args (10-60K
   tokens) — with maxTokens 8192 it truncated → contract mismatch → fallback. S8.T1 changes the contract
   to delta/extraction.
5. **Upload race**: `curl -F file=@/tmp/<name>` to the server writing the SAME path as the source
   (source path == server target) truncates the file (17MiB→1.8MiB): the server overwrites the file
   curl is still reading. Frontend uploads (browser memory) are unaffected. Fix: source file must not
   share the server target path; server-side temp-naming documented.
6. **llm_wiki 413**: reading a >limit wiki page during dedup crashed the whole server (uncaught 413 in
   listWikiPages walk) — patched to skip unreadable pages; should be covered by a test + CR.

## Out-of-scope (this spec)

- Remote agent federation (G4.S7), worker tracking (G4.S4), GDD decoupling (G4.S6).
- LightRAG details (G4.S2 done; self-built Neo4j store is the consumer).

## Structure

- **T1** — Stage-2 delta/extraction contract (was drafted as G4.S1.T7 — moved here)
- (more tickets to be split from the defect list: cache test, upload temp-name doc, key-separation ADR)

## Progress Log

| UTC timestamp | status | one-line progress |
| --- | --- | --- |
| 2026-08-20T17:50:00Z | in_progress | Spec created from the GR ingest debugging session; absorbs draft S1.T7 as S8.T1 |