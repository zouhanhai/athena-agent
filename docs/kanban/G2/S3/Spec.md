---
id: g2_s3
title: "G2.S3: Knowledge Access Layer + Pi Retrieval Routing"
layer: S
parent: G2
owner: eng-director
status: active
milestone: M2
acceptance_criteria:
  - "athena backend has kb/ service layer encapsulation (LightRAG + llm_wiki clients)"
  - "Dual-pipeline ingestion service: receives Markdown → feeds LightRAG + llm_wiki"
  - "Pi models switched to OpenRouter (deepseek-v4-flash main, qwen vision/embedding/image)"
  - "pi-mcp-adapter connects both knowledge source MCPs"
  - "Pi registers knowledge tools (knowledge_search/query_graph/wiki_search/wiki_read_page/wiki_graph)"
  - "Capabilities routing (AnyOf/AllOf) takes effect"
  - "Pi can retrieve from both systems via MCP (Agentic RAG)"
---

# G2.S3: Knowledge Access Layer + Pi Retrieval Routing

## Task

Build knowledge access layer (athena backend encapsulating both knowledge sources) + Pi retrieval routing mechanism via MCP.

## Key Dependencies

- G2.S1 (LightRAG service) + G2.S2 (llm_wiki service) deployed

## Implementation

## 1. Backend Knowledge Service Layer (server/src/kb/)
- `kb/lightrag.ts`: LightRAG API client (ingestion + retrieval + graph)
- `kb/llmwiki.ts`: llm_wiki API client (file tree + search + graph + read page)
- `kb/ingest.ts`: dual-pipeline ingestion service (Markdown → LightRAG + llm_wiki)

> **Scope note**: docling parsing (raw files/URL → Markdown) belongs to **G2.S5** (input interface),
> NOT here. S3's ingest consumes already-parsed Markdown.

## 2. Capabilities Declaration (knowledge-rag-design.md)
- LightRAG → ["vector", "graph"]
- llm_wiki → ["wiki", "keyword", "graph"]

### 3. Pi Tool Registration + Routing
- Use pi-mcp-adapter to connect both knowledge source MCPs
- Register tools (knowledge_search/query_graph/wiki_search/wiki_read_page) + Capability requirements
- Pi (ReAct) does deterministic routing by intent + capability declaration + cost

### 5. Pi Model Configuration (OpenRouter unified)
Pi (AgentSession) models must use **OpenRouter** (base_url `https://openrouter.ai/api/v1`):
- Main model: `deepseek/deepseek-v4-flash` (conversation/reasoning)
- Vision: `qwen/qwen3.7-flash` (image recognition)
- Embedding: `qwen/qwen3-embedding-8b` (LightRAG/llm_wiki embedding)
- Image generation: `qwen/qwen-image-3` (M5 output)
Update `~/.pi/agent/models.json` (+ models-store.json) and `auth.json` so Pi uses
`openrouter/deepseek-v4-flash` instead of the direct DeepSeek API.

### 4. Verification
- Dual-pipeline ingest a document → both systems have it
- Pi retrieves from LightRAG + llm_wiki via MCP
- Intent routing correct (process questions → wiki, facts → RAG, relationships → graph)

## Reference

- Spec: `docs/kanban/G2/Goal.md`
- Design: `docs/knowledge-rag-design.md` (single source of truth, Capabilities pattern)
- Existing: `server/src/agents/agent.ts` (Pi encapsulation)

## How to Locate Reference Docs

- `parent: G2` → `docs/kanban/G2/Goal.md`
- Capabilities routing: `docs/knowledge-rag-design.md`

## Notes

- Pi tool registration uses @earendil-works/pi-coding-agent (AgentSession)
- Retrieval routing follows knowledge-rag-design.md's intent→strategy mapping
- Use **implement** + tdd + code-review

## Dependencies

- G2.S1, G2.S2

## Log
