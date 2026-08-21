---
id: s1
title: "G4.S1: Post-docling Athena document refinement step"
layer: S
parent: G4
owner: consultant
status: approved
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
decisions are all locked to that deterministic model.

## Athena is the SINGLE full-document LLM pass (decided 2026-08-09)

**Architecture decision:** Athena is the **only** full-document LLM pass in the ingest chain. It reads the
whole document once and emits everything downstream needs, so NO other LLM re-processes the document
(except the final embedding, which is vector encoding, not reasoning):

```
docling parse (ML layout model, no LLM)
  → [Athena refinement — ONE full-doc LLM pass]
       reads:  docling markdown (full doc)
       emits:  { re-leveled markdown, frontmatter(type+topic), chunk segmentation,
                 entity extraction, keyword extraction, quality report }
  → re-leveled markdown + chunks + entities + keywords land on disk/storage
     (NOT passed through further LLM context — refs instead, pi-docparser pattern)
  → downstream consume by reference:
       llm_wiki:  write page + frontmatter + rebuild index (pure I/O, no LLM)
       RAG (G4.S2 self-build): receive Athena-injected chunks/entities/keywords,
                               only embed + index + retrieve (no LLM)
```

### Athena refinement output contract

```jsonc
{
  "markdown": "# ... \n\n## ...",       // re-leveled markdown (header hierarchy fixed)
  "frontmatter": { "type": "event", "topic": "internal/events" },   // classification (folds in llm_wiki classify)
  "chunks": [                          // paragraph-semantic segmentation
    { "id": "c1", "text": "...", "start": 0, "end": 400, "topic": "internal/events" }
  ],
  "entities": [                        // knowledge-graph nodes (was LightRAG internal)
    { "name": "CALEO", "type": "org", "description": "..." }
  ],
  "relations": [                       // knowledge-graph edges (was LightRAG internal)
    { "from": "CALEO", "to": "Sommerseminar", "type": "hosts" }
  ],
  "keywords": [                        // retrieval keywords (was LightRAG internal)
    "sommerseminar", "schedule", "workshop"
  ],
  "quality": {
    "complete": true, "confidence": 0.85,
    "issues": ["table on p3 split"], "action": "auto_accept"   // auto_accept | review_required
  }
}
```

### Big-output handling (pi-docparser pattern, decided 2026-08-09)

Reference: `pi-docparser` (pi.dev) demonstrates the correct pattern for large doc output — the full
`markdown` + `chunks` go to a temp file / storage, and the tool returns only a short preview + refs.
So `refine_document` returns the **small metadata** (frontmatter, entities, keywords, quality, md ref)
into context; the **full markdown + chunks** land on disk/storage for downstream to read by reference.
This keeps the large re-leveled markdown OUT of the LLM context of subsequent steps.

### Single-read size budget (decided 2026-08-09 — exact threshold set by test at impl time)

One Athena call's context = **input (full md) + output (re-leveled md + chunks + entities + keywords +
quality)**. Output ≥ input (rewrite + extracted structured data), so usable input is roughly half the
1M context. Rough guidance, exact threshold to be measured during implementation:

- **English**: 1M token ≈ ~4M chars → safe single read ≈ 2-3 MB md.
- **Chinese**: 1M token ≈ ~1-1.5M chars → safe single read ≈ 1-1.5 MB md.
- **Conservative recommended cap ≈ 500 KB – 1 MB md** per single read (leaves room for output inflation
  and reasoning). Current docs (largest ≈ 12 KB Sommerseminar) are far below this — single read fine.
- **Above the cap**: split by `##` headers into section blocks, refine each independently, then merge +
  one global type/topic/entity pass. NOTE: chunked refinement loses cross-section entity/relation
  correlation, so single-read is preferred; chunking is a fallback strategy.

**Measured reference (2026-08-09)**: the 827-page "Group Reporting SAP Doc.pdf" docling parse produced a
**2.17 MB md (27,917 lines, 3,364 headers, ALL h2 — no h1)**. That's ~55-65k tokens input + output
inflation → near/over the 1M context. A heavy-image doc also grows md further (VLM descriptions add alt text).

**Two-stage refinement for large docs (decided 2026-08-09)** — header re-leveling does NOT need the full
doc. This solves the size problem:

1. **Stage 1 — header re-level (local, per header+batch)**: judge each header's semantic level using only
   the header text + a few following paragraphs (tens of KB per batch), NOT the full doc. Produces the
   corrected h1/h2/h3 hierarchy. docling often emits ALL h2 (flat) — e.g. this SAP doc has 3,364 h2, no
   h1 — so header re-leveling gives the true structure.
2. **Stage 2 — split by the refined h1 boundary** into semantically-complete sections, each sized to fit
   context (~<1MB). Then per section: chunk segmentation + entity + keyword + type/topic judgment.

This means `refine_document` for large docs is a two-pass process: local header pass → split → per-section
full pass. Sub-1MB docs skip the split and do one full-doc pass. The old "split by size then refine"
idea is superseded by "refine headers locally, THEN split by the correct h1 boundaries".

### Downstream needs no LLM (decided 2026-08-09)

- **llm_wiki**: only writes the page + frontmatter + rebuilds index → pure I/O, no LLM.
  The `classify` step is folded into Athena refinement (type+topic already decided).
- **RAG (G4.S2)**: receives Athena-injected chunks/entities/keywords, only embeds + indexes + retrieves →
  no LLM. This solves the LightRAG black-box problem: we no longer depend on LightRAG's hardcoded
  internal entity/keyword/chunk LLM passes (which had no injection interface).
- **embedding**: the only remaining non-LLM transform (vector encoding), kept.

### Dedicated OpenRouter keys for Athena refinement + embedding + docling (decided 2026-08-09)

Athena's document-refinement LLM pass uses a **dedicated OpenRouter key** registered as an **`athena`
provider in the Pi `auth.json`** (6900XT `~/.pi/agent/auth.json`), separate from the shared `openrouter`
provider — so refinement cache-hit-rate and cost are independently observable/controllable, and Athena
refinement context/cost doesn't mix with other work. `refine_document` (a Pi custom tool) uses
`modelRuntime.getModel("athena", "~deepseek/deepseek-v4-flash-latest")`.

The **embedding** step uses its own `EMBEDDING_OPENROUTER_KEY` (stored in `server/.env.local`,
git-ignored; also on 6900XT). This is consumed by the **G4.S2 self-built RAG interface** (embedding is
part of the RAG engine, not the Pi agent) — the self-built interface reads it; it's not used by the Pi
agent.

**docling** VLM picture descriptions use their own `DOCLING_OPENROUTER_KEY` (`server/.env.local`,
git-ignored; also on 6900XT). `parse_doc.py:resolve_openrouter_key()` prefers it, falls back to
`OPENROUTER_API_KEY`. So each OpenRouter-consuming subsystem (docling VLM / Athena refinement / embedding /
Pi) has an independent key for independent cache-hit-rate + cost tracking.

**Impl note (S1)**: `~/.pi/agent/models.json` `providers` must also gain an **`athena`** entry (same
model set as `openrouter`, e.g. `~deepseek/deepseek-v4-flash-latest`) so `ModelRuntime.getModel("athena",
"~deepseek/deepseek-v4-flash-latest")` resolves. Register when implementing `refine_document`.

## How general RAG extracts chunk / entity / relation / keyword (reference, 2026-08-09)

Studied LightRAG's actual implementation (`prompt.py` + `chunker/paragraph_semantic.py`) as the
reference. This informs `refine_document`'s output contract:

- **Chunking**: `paragraph_semantic` — split by paragraph boundaries + semantic completeness (NOT fixed
  token). Params `chunk_token_size` (~1200 tokens) + `chunk_overlap_token_size` (~100). Each chunk
  carries its **heading path** (`_clean_heading_text`) so downstream entity extraction knows the section.
- **Entity extraction** (per-chunk LLM, then merged): fields `entity_name` (capitalize title case for
  consistent naming — avoids "CALEO"/"caleo" variants), `entity_type` (preset types org/person/product…,
  else `Other`), `entity_description`.
- **Relation extraction** (binary, per-chunk): `source_entity`/`target_entity` (consistent naming),
  `relationship_keywords`, `relationship_description`. Multi-entity statements decompose into binary edges.
  Only "direct, clearly-stated, meaningful" relations.
- **Keyword extraction**: relationship keywords + query keywords (high-level + low-level) for retrieval.
- **Flow**: chunk → per-chunk LLM extract (map) → cross-chunk entity merge/dedup + relation link (reduce) →
  entity/relation desc compression if oversize.

**Advantage of Athena single-read over LightRAG's per-chunk map-reduce**: one full-doc LLM pass extracts
ALL entities/relations with **global consistent naming** and **retains cross-chunk relations** that
LightRAG's map-reduce can miss (each chunk only sees its local slice). This is core value of G4.S1.

## Cross-RAG extraction mechanism comparison (reference, 2026-08-09)

Studied 5 RAG projects' extraction approaches to inform `refine_document`:

| Project | Chunking | Entity | Relation | Keyword | Notable |
|---------|----------|--------|----------|----------|---------|
| LightRAG (ours) | paragraph_semantic, ~1200tok, heading path | name(title-case)+type+desc | binary src/tgt/keywords/desc | relationship + query kw | per-chunk map→reduce |
| Microsoft GraphRAG | text units | entity+desc | entity rel + desc | - | **Leiden community detection** → hierarchical community reports for global queries |
| neo4j-graphrag | FixedSize (500,overlap100) | `LLMEntityRelationExtractor`, **`use_structured_output=True`** (JSON-schema enforced) | same extractor, schema: node_types+relationship_types+patterns | - | **structured-output constraint** — validates our Pi `constrainedSampling` approach |
| RAGFlow | **template-based per doc type** (pdf/table/slide/code) | GraphRAG or LightRAG prompt | same | - | doc-type-aware chunk templates |
| LlamaIndex | chunk+embed | `extract_triplets` → (subject,predicate,object) | same triplets | - | max_triplets/chunk limit; simple triplet form |

**Key takeaways for `refine_document`**:
1. **Structured output constraint** (neo4j-graphrag `use_structured_output`, GraphRAG/others) — confirms
   using Pi tool `constrainedSampling` (JSON schema) instead of relying on LLM free-text JSON.
2. **Community detection** (GraphRAG Leiden) — future option for G4.S2 graph (hierarchical clusters for
   global queries).
3. **Entity name normalization** (LightRAG title-case) + **binary relations** (LightRAG) + **triplet form**
   (LlamaIndex) are the common denominator — adopt these.
4. **Template-based chunking** (RAGFlow) — could reuse for doc-type-aware chunk segmentation.

## Full design (original spec reference)

See `docs/spec-m4-docling-refinement.md` for the original problem statement + context-efficiency
analysis. Key original points:

- **One Athena LLM pass** after docling: re-header, quality, topic, chunk.
- **Context-efficiency**: folds ALL full-doc LLM passes (llm_wiki classify + this step) into one read.
- **Fallback**: if the LLM step fails, use the raw docling output (no regression).

## Where it fits

Current pipeline (tasks.ts): `parsing (docling)` → `ingesting_lightrag ‖ ingesting_llmwiki`.
New: `parsing (docling)` → **`refinement (Athena: re-header + quality + topic + entity + keyword)`** → parallel stages.

## Dependencies

- G4.S2 (RAG self-build) consumes this step's output contract (chunks/entities/keywords/topic).
  This is why S1 precedes S2 — the refinement output contract is decided here first.

## Deliverables

- Server refinement step in the ingest pipeline (tasks.ts) — new `refinement` stage.
- `refine_document` as a Pi custom tool (customTools + skill + constrainedSampling), model
  deepseek-v4-flash-latest, thinkingLevel high.
- Output contract schema (markdown/frontmatter/chunks/entities/relations/keywords/quality).
- Big-output handling (full md + chunks to storage; small metadata + refs in context).
- Fallback path (raw docling on LLM failure) + tests.
