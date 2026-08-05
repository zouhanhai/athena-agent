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

## 8. To Be Verified

- Whether llm_wiki's MCP exposes retrieval tools (wiki_search equivalent)
- LightRAG's MCP/API retrieval capability confirmation
- Pi's ReAct routing performance in real queries
