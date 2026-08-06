---
id: g2
title: "G2: Knowledge Base (LightRAG + llm_wiki + docling Ingestion)"
layer: G
owner: hermes
status: done
created_at: 2026-08-05
milestone: M2
acceptance_criteria:
  - "LightRAG starts with DeepSeek + Postgres(pgvector)"
  - "llm_wiki runs headless providing :19828 API"
  - "docling uniformly parses all file types + URL → Markdown → dual-pipeline ingestion"
  - "Pi retrieves from both knowledge systems via MCP (Agentic RAG routing)"
  - "Frontend has Knowledge graph panel (iframe) + Wiki browse panel"
  - "Frontend has data/document input interface (upload + URL + progress bar)"
---

# G2: Knowledge Base (LightRAG + llm_wiki + docling Ingestion)

## Background / Context

Corresponds to Milestone M2. Objective: Build a team knowledge base for the athena portal — dual knowledge systems (LightRAG vector+graph, llm_wiki wiki pages) + unified document ingestion (docling).

Reference design docs:
- README.md (architecture overview + M2 acceptance criteria)
- docs/knowledge-rag-design.md (knowledge base + RAG routing design, single source of truth)
- docs/adr/0004-llm-wiki-service.md (llm_wiki service decision)
- CONTEXT.md (glossary)

## Goal

1. Deploy LightRAG (DeepSeek + Postgres/pgvector)
2. Deploy llm_wiki headless (:19828 API)
3. Use docling as unified parsing layer: all file types + URL → Markdown → dual-pipeline ingestion
4. Access layer + Pi retrieval routing (knowledge_search/query_graph/wiki_search + Capabilities)
5. Frontend Knowledge graph panel + Wiki browse panel + data input interface (upload/URL/progress bar)

## Architecture

```
Data/Document Input (frontend upload / URL)
  → Backend /api/kb/ingest
    → docling unified parsing (pdf/docx/xlsx/pptx/image/HTML/URL → Markdown)
      → shared input-dir (markdown)
        → LightRAG (vector + graph)
        → llm_wiki (wiki pages + keyword index)
      → return processing progress/status (progress bar)

Pi (AgentSession) → pi-mcp-adapter → each knowledge source MCP
  └─ capabilities routing: wiki / keyword / vector / graph
```

## Confirmed Decisions

- Knowledge systems: LightRAG (vector+graph) + llm_wiki (wiki)
- Unified parsing: docling (supports all formats + URL/HTML, outputs Markdown)
- Ingestion: unified parsing → dual pipeline (LightRAG + llm_wiki)
- Pi retrieval: pi-mcp-adapter + Capabilities routing (AnyOf/AllOf)
- Frontend: Knowledge graph iframe + Wiki custom (CALEO style)
- Input interface: file upload + URL + per-source progress bar

## Tech Stack

```
LightRAG  → Python, DeepSeek LLM, Postgres/pgvector, NetworkX graph
llm_wiki  → Rust compiled, headless (:19828)
docling   → Python, unified parsing
Pi        → pi-mcp-adapter connecting MCP
```

## Completion Criteria

See frontmatter acceptance_criteria. All Specs under G2.S1..S5 and their Tickets must be approved.
