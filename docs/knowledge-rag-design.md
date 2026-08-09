# athena-agent — Knowledge Base & RAG Routing Design

> Core: llm_wiki + LightRAG dual-system, using Capabilities declarations + Pi(ReAct) deterministic routing for Agentic RAG.
> Referencing WeKnora's Capabilities mechanism (see analysis below).
> This document is the sole reference for subsequent implementation of knowledge base, retrieval, and Pi query routing.

## 1. Overall Architecture

```
Knowledge sources (two independent systems, sharing raw file directory):
  llm_wiki  → capabilities: ["wiki", "keyword"]
  LightRAG  → capabilities: ["vector", "graph"]

Pi (AgentSession) → pi-mcp-adapter → each knowledge source MCP
  └─ Determines query strategy based on user intent + tool descriptions + capability declarations
```

## 2. File Ingestion (Plan C: Shared Raw Files, Dual Pipeline Processing)

```
Upload one document to shared input-dir:
  ├─ llm_wiki: read file → generate wiki pages (md) + keyword index
  └─ LightRAG: read same file → chunk → vector store (pgvector) + knowledge graph (NetworkX)

Raw files stored only once; each system produces its own processing artifacts independently.
```

### 2.1 Precise Ingest Flow (implemented, G2.S5)

The actual dual-pipeline ingest (server/src/kb/tasks.ts run()) executes in order:

```
Upload file / URL
  → POST /api/kb/ingest (multipart) or /api/kb/ingest-url → task queue (taskId)
  → run(): stages tracked per-system
    ① parsing (docling):
       parsed = parser.parse(input)     # docling → Markdown string
       markdown = parsed.markdown        # in-memory string
       (also written to shared input-dir ~/athena-data/input as artifact)
    ② classify FIRST (shared by both systems, G3.S8.T2):
       prepareForIngest → llm_wiki built-in agent classifies doc against the
         CALEO taxonomy (docs/taxonomy.md): 13 kinds of `type` + hierarchical `topic`
         (e.g. internal/events) → { category, topic, frontmatter }
    ③ LightRAG ‖ llm_wiki run IN PARALLEL (Promise.all):
       ingestLightRag(frontmatterContent, fileName)
         → lightrag.ingestText(content)  # LightRAG native /documents/text
           # chunking (paragraph_semantic) → embedding (qwen3-embedding-8b) → vector (pgvector) + entity graph
           # frontmatter (type+topic) carried in content_summary for topic filtering
       ingestLlmWiki(fileName, markdown, preclassified)
         → write wiki/<topic>/<file>.md (frontmatter type + topic)
         → rebuild wiki/index.md (pages grouped by type)
    ④ any system ok → task status=done, progress 100 (recomputed from both stages)
```

### 2.1.1 docling Picture-Description Limitation (known, 2026-08-07)

docling only runs picture-description (VLM image → text) for **PDF and IMAGE**
inputs. Every other format is handled by `SimplePipeline`, which extracts text
and document structure but has **no picture-description capability**:

| Input | Pipeline | Picture description |
|-------|----------|---------------------|
| PDF   | StandardPdfPipeline | ✅ yes |
| IMAGE (png/jpg) | StandardPdfPipeline | ✅ yes |
| DOCX / DOC | SimplePipeline | ❌ no |
| PPTX / PPT | SimplePipeline | ❌ no |
| XLSX / XLS / ODS | SimplePipeline | ❌ no |
| HTML / MD / CSV / ODT / ODP / EPUB / ASCIIDOC | SimplePipeline | ❌ no |

Implications:
- **PPTX is the biggest gap**: many slide decks carry their content inside
  images (product shot decks, design mockups, scanned slides). docling extracts
  only the slide *text* (titles, bullets, table cells) and drops the image
  content as `<!-- image -->` placeholders → such decks yield little usable
  knowledge. Same for DOCX/XLSX files whose meaningful content lives in images.
- This is a **docling architecture constraint** (`WordFormatOption` /
  `PowerpointFormatOption` / `ExcelFormatOption` → `SimplePipeline`), not a bug
  in our ingestion.
- Small images: `picture_area_threshold` was lowered from 0.05 → **0.01** (fraction of
  page area) in `server/scripts/parse_doc.py` (2026-08-08), so images down to 1% of the page
  now get a VLM description (not just 5%+). Logos/decoration below 1% still become placeholders.
- **Possible future work** (not scoped): to get picture descriptions for
  DOCX/PPTX, convert to PDF first (e.g. LibreOffice headless) and re-run the
  PDF pipeline; or extract embedded images and describe them separately.

### 2.1.2 Image preservation in llm_wiki pages (G3.S5.T5)

Goal: when reading a wiki `.md` page in llm_wiki (WikiView), show **both the text AND the original
document images** (at the same relative position as the source), while **LightRAG stays pure text**.

- `parse_doc.py` supports `--images-dir <dir>` → `export_to_markdown(image_export_dir=...)` writes
  extracted images to disk and references them in the markdown as `![<VLM alt>](images/<name>.png)`.
- Ingest split is naturally correct:
  - `ingestLlmWiki` writes the **full markdown** (with image refs) to `wiki/<topic>/<name>.md`; the
    image files are **copied beside it** (`wiki/<topic>/images/`) so the reader renders them.
  - `ingestLightRag` sends the **same markdown** to LightRAG, which stores **text only** (image refs
    collapse to the alt-text = VLM description) — chunking is unaffected.
- Frontend: `GET /api/kb/wiki/image?path=` serves image bytes (guarded like `readWikiPage`);
  `WikiView` rewrites `<img src="images/...">` → served URL.
- Implements the "view the source as Markdown, with images" experience without polluting LightRAG.
- **Long docs**: the renderer also adds heading anchors (`markdown-it-anchor`) + a table of contents
  (`markdown-it-table-of-contents`) so a large multi-section page can jump directly to a fixed chapter
  via `#id` links / a TOC list at the top. Pure renderer change — LightRAG + stored markdown untouched.



**Key points:**
- **Docling produces an in-memory Markdown string** that is dispatched to both pipelines;
  the input-dir file is a stored artifact, not the ingest source.
- **LightRAG pipeline is native/unmodified**: `ingestText` (chunking → embedding → pgvector
  vector + NetworkX entity graph). It has NO agent — it uses the LLM only for embedding + entity extraction.
- **llm_wiki pipeline uses its own built-in agent** (NOT Pi) to classify the doc into a category
  dir; both systems run on **OpenRouter** (`~deepseek/deepseek-v4-flash-latest` main).
- **Independent pipelines**: changing llm_wiki ingest (e.g. classification) does NOT affect
  LightRAG ingest (`ingestLightRag` is separate from `ingestLlmWiki`).

### 2.2 Wiki auto-hierarchy (llm_wiki built-in agent, CALEO taxonomy)

llm_wiki's built-in agent classifies each ingested doc against the CALEO taxonomy
(`docs/taxonomy.md`): a `type` (13 kinds) and a hierarchical `topic` (slash path). The wiki page
is written to `wiki/<topic>/<file>.md`; `index.md` groups pages by type. Examples:

```
wiki/internal/events/Sommerseminar-Mallorca-2023.pdf.md   (type: event, topic: internal/events)
wiki/sap/consolidation/GroupReporting.pdf.md              (type: report, topic: sap/consolidation)
```

- `type` = 13 kinds: report / minute / spec / manual / proposal / contract / policy / presentation /
  event / source / person / entity / concept (disambiguation in docs/taxonomy.md).
- `topic` = hierarchical slash path (e.g. `sap/s4hana/consolidation`), `isValidTopic` supports
  arbitrary depth. Reuses existing topics for consistency.
- Classification prompt uses the **llm_wiki built-in agent** (OpenRouter `~deepseek/deepseek-v4-flash-latest`).
- Fallback: local heuristic `localClassify` (also taxonomy-based) if the agent fails.
- WikiView has **topic view** and **type view**; no flat "All" view.
- Cross-page wikilinks ([[ ]]) relationships are built by llm_wiki's graph index later (not in ingest).

### 2.3 Model unification (all systems on OpenRouter, auto-follow latest)

| System | Main model | Provider |
|--------|-----------|----------|
| llm_wiki built-in agent | `~deepseek/deepseek-v4-flash-latest` | OpenRouter |
| LightRAG | `~deepseek/deepseek-v4-flash-latest` (LLM) + `qwen/qwen3-embedding-8b` (embedding) | OpenRouter |
| Pi / athena server | `~deepseek/deepseek-v4-flash-latest` | OpenRouter |
| Local Hermes | `~deepseek/deepseek-v4-flash-latest` | OpenRouter |

Using `~...-latest` so all systems auto-follow the newest DeepSeek V4 Flash without manual updates.

## 3. Capabilities Pattern (Core Routing Mechanism, Referencing WeKnora)

### 1. Each knowledge source declares its own capability surface

```
llm_wiki  → ["wiki", "keyword", "graph"]  (wiki pages + keyword/BM25 + built-in wikilinks graph)
LightRAG  → ["vector", "graph"]           (vector index + entity-relation knowledge graph)
```

**Two independent graphs — not unified at the data layer.**

| | LightRAG graph | llm_wiki graph |
|--|---------------|----------------|
| Type | Entity-relation graph (NetworkX) | Built-in 4-signal knowledge graph (wikilinks) |
| Nodes | Entities extracted from documents | Wiki pages |
| Edges | Entity relationships | Page links ([[wikilinks]]) |
| Storage | NetworkX (POC, file) | llm_wiki internal |
| Vector | Postgres/pgvector | LanceDB |

**Rationale**: unifying both graphs into one is impractical (different node granularity:
entities vs pages; different storage engines). "Unification" happens at the **retrieval
orchestration layer (Pi routing)** — each graph serves its own query type, and Pi fuses
multi-source results when a complex query spans both.

**Capabilities are deterministic declarations at the "knowledge source level"** (not probing). Pi sees them and knows what's possible.

### 2. Each Pi tool declares what capability it needs (ToolRequirement)

```typescript
// Register Pi's tools in the athena backend
const tools = [
  // RAG tools: need vector OR keyword
  { name: 'knowledge_search',  requireCapability: { anyOf: ['vector', 'keyword'] } },
  { name: 'query_graph',       requireCapability: { anyOf: ['vector', 'graph'] } },
  // Wiki tools: must have wiki
  { name: 'wiki_search',       requireCapability: { allOf: ['wiki'] } },
  { name: 'wiki_read_page',    requireCapability: { allOf: ['wiki'] } },
  // llm_wiki wikilinks graph traversal (optional, distinguishes from LightRAG entity graph)
  { name: 'wiki_graph',        requireCapability: { allOf: ['wiki', 'graph'] } },
]
```

**Two operators**:
- **AnyOf**: any one suffices (e.g. vector OR keyword)
- **AllOf**: all must be present (e.g. wiki tools require wiki capability)

### 3. Pi's Routing Logic (Agentic RAG)

```
user query → Pi (ReAct agent):
  1. Inspect each knowledge source's capability declaration + tool descriptions
  2. Judge user intent:
     ├─ "What does the process doc say"     → wiki_search (llm_wiki)
     ├─ "Which entities relate to X"        → query_graph (LightRAG entity graph)
     ├─ "Which wiki pages link to Y"        → wiki_graph (llm_wiki wikilinks graph)
     ├─ "Materials about Z"                 → knowledge_search (LightRAG)
     ├─ "Compare A and B implementations"   → query multiple (wiki + RAG) then fuse
     └─ Simple question / chit-chat        → don't query, answer directly
  3. Collect results → summarize → answer
```

**Multi-graph fusion**: when a query spans both graphs (e.g. "how does concept A relate
to topic B"), Pi queries the relevant graph(s) and **fuses the answers** into one coherent
response — unification happens here at the orchestration layer, not at the storage layer.

**Decision factors** (Pi considers holistically):
| Factor                | Impact                                           |
|-----------------------|--------------------------------------------------|
| User query intent     | Decides which to query (wiki vs vector vs graph) |
| Tool descriptions     | Helps Pi judge when to use which tool            |
| Knowledge source capabilities | Deterministic: which tool is available    |
| Cost / efficiency     | Simple questions query one; complex ones query many |

## 4. Intent → Query Strategy Mapping

| User intent                          | Query strategy    | Knowledge source |
|--------------------------------------|-------------------|------------------|
| Process / standards / concept definitions | wiki_search    | llm_wiki         |
| Specific facts / fuzzy semantics / materials | knowledge_search | LightRAG      |
| Entity relationships / dependencies | query_graph       | LightRAG (entity graph) |
| Page / topic links exploration       | wiki_graph        | llm_wiki (wikilinks graph) |
| Comprehensive comparison / complex reasoning | multi-source hybrid | Query all, Pi fuses |
| Simple / chit-chat                   | No retrieval      | -                |

### Role of topic in retrieval / agentic RAG (2026-08-09)

Topic (the hierarchical slash path from the wiki frontmatter, e.g. `internal/events/sommerseminar`)
is a **navigation/organization dimension, NOT a semantic-search accelerator**:

- **Graph browsing** (`GET /api/kb/graph?topic=…`): topic filters graph nodes. The filter is
  driven by `buildTopicMap()` which reads `topic` from **wiki page frontmatter**, then
  `filterGraphByTopic()` keeps nodes whose file_path maps to that topic (or a sub-topic).
  LightRAG's chunks/embeddings/entities are **never re-run** when a topic changes — only the wiki
  frontmatter + file location change (see M4 incremental re-curation).
- **Semantic search** (`POST /api/kb/search`): currently **topic-agnostic** — LightRAG hybrid query
  is over the whole corpus; llm_wiki keyword search too. topic does not narrow the search.
- **Agentic RAG (Athena)**: topic is a **knowledge-navigation tool for the agent**. Athena judges
  intent → picks a topic → uses it to focus graph exploration / scope which docs to read → then
  fuses LightRAG (semantic recall) + llm_wiki (keyword/topic map) into the answer. So topic guides
  *where to look*; LightRAG does the *semantic recall*; they are complementary.

**Enhancement (M4, topic-scoped search)**: optionally let a query search **within** a topic domain
(e.g. "only docs under `sap/`"), by pre-filtering candidate docs/chunks by their wiki frontmatter
topic before semantic scoring. Currently not supported — full-corpus search only.

## 5. Tool Descriptions (Helping Pi Decide)

```
wiki_search: "Search accumulated wiki pages (suitable for: processes, standards, concept definitions)"
knowledge_search: "Semantic search over raw document chunks (suitable for: specific facts, fuzzy semantics, material lookup)"
query_graph: "Query entity relationship graph (suitable for: who relates to whom, dependency relationships)"
wiki_graph: "Traverse wiki page wikilinks graph (suitable for: which pages link to a topic, knowledge exploration)"
```

## 6. Differences vs WeKnora

| Dimension             | WeKnora                        | Our approach                       |
|-----------------------|--------------------------------|------------------------------------|
| Capability surface distribution | One KB, multiple capability surfaces | Two systems, one capability surface each |
| Routing basis         | Inspect KB.Capabilities()      | Inspect knowledge source capabilities declaration |
| Tools                 | Built-in agent calls multiple  | Pi calls multiple MCP tools        |
| Wiki storage          | DB rows (Postgres)             | md files (llm_wiki, Karpathy pattern) |
| Graph                 | Built-in                       | Two independent: LightRAG entity graph (NetworkX) + llm_wiki wikilinks graph |

**Different paths, same destination**: shared raw files + layered processing artifacts + capability-declaration routing.

## 7. Implementation Essentials

1. Upload document → shared input-dir → dual pipeline processing
2. Pi connects to llm_wiki + LightRAG MCP via pi-mcp-adapter
3. Each tool registers capability requirements (AnyOf/AllOf)
4. Pi routes deterministically based on intent + capabilities + cost
5. Simple questions go through a single knowledge source first; complex questions go multi-source

## 8. RAG System Selection & Self-Build Direction (M4 research, 2026-08-09)

### 8.1 Problem: LightRAG is a black box

LightRAG's entity extraction / keyword extraction / paragraph-semantic chunking are **hardcoded internal
LLM calls** (`extract_entities` in operate.py) with **no external-injection interface**. So Athena can't
drive them (would need a fork). Its storage, however, already uses PG + pgvector 0.6 + a graph (NetworkX)
— the pieces we'd build on.

### 8.2 Evaluated options

| System | Verdict |
|--------|---------|
| **RAGFlow** (86.9k★) | Not a match: full platform on ES/MinIO/MySQL (NOT pgvector); its GraphRAG is internal (not injectable); heavy new infra. |
| **Haystack / LlamaIndex** | Modular libs, injectable + pgvector, but still need to build GraphRAG ourselves. |
| **Neo4j `neo4j-graphrag` (official)** | **Strong fit.** HybridRetriever (vector+full-text fusion), VectorRetriever, Text2Cypher, **ToolsRetriever** (combine retrievers, LLM picks — fits "fuse wiki+topic+vector+graph"). SimpleKGPipeline builds KG (or inject Athena entities). |
| **Self-build** | Most controllable; Athena injection natural; pgvector already present. |

### 8.3 Neo4j has a native vector index (confirmed)

- `CREATE VECTOR INDEX` / `db.index.vector.createNodeIndex` — HNSW (Lucene), cosine + euclidean.
- **Cypher `SEARCH` clause** (2026.01+) and **vector search with in-index filters** (`SEARCH…WHERE`,
  GA 2026.02) — applies topic/tenant predicates inside the index. **Community Edition supports these.**
- Native `VECTOR` data type (block format) is Enterprise/Aura; **Community uses `LIST<INTEGER|FLOAT>`
  properties** (functionally equivalent for indexing).
- So **Neo4j 2026 Community (Docker) is enough** — no pgvector needed. 6900XT (Docker 29, 31GB) fits.

### 8.4 Self-build architecture (lean toward single-store Neo4j)

- **Neo4j** holds: `Chunk` nodes (embedding LIST property + topic + text), `Entity`/`Relation` graph,
  `Document`/`WikiPage`. One store for vector + graph + topic.
- **Athena** pre-computes: re-leveled markdown (headers), topic, chunk segments, entity/relation
  extraction — injected directly into Neo4j (no LightRAG fork).
- **Retrieval** via `neo4j-graphrag`: HybridRetriever (vector+full-text) + graph traversal
  (Text2Cypher / VectorCypherRetriever) + **ToolsRetriever** to fuse wiki + topic + vector + graph.
- **topic-scoped search** = in-index filter (`SEARCH…WHERE` on chunk.topic) — M4 enhancement.

### 8.5 Open items for M4

- Deployment spike: run Neo4j 2026 Community in Docker on 6900XT, verify vector index + SEARCH + filters.
- Decide: single Neo4j store (option B) vs PG+pgvector (vector) + Neo4j (graph) (option A).
- Wiki integration: how `buildTopicMap` / wiki frontmatter topic maps onto Neo4j chunk.topic.
- Keep llm_wiki for page storage + TOC; LightRAG either replaced (self-build) or kept (accept internal LLM).

## 9. To Be Verified

- Whether llm_wiki's MCP exposes retrieval tools (wiki_search equivalent)
- LightRAG's MCP/API retrieval capability confirmation
- Pi's ReAct routing performance in real queries
