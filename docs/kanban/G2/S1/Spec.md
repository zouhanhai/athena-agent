---
id: g2_s1
title: "G2.S1: LightRAG Knowledge Service Deployment"
layer: S
parent: G2
owner: eng-director
status: active
milestone: M2
acceptance_criteria:
  - "LightRAG installed on 6900XT and can start"
  - "Configured DeepSeek as LLM (embedding + generation)"
  - "Configured Postgres + pgvector as vector storage"
  - "NetworkX as graph storage (POC)"
  - "Can ingest documents (Markdown) and retrieve (semantic queries return results)"
  - "Can produce knowledge graph data (for frontend iframe use)"
  - "Service bound to 0.0.0.0 for Tailscale access"
---

# G2.S1: LightRAG Knowledge Service Deployment

## Task

Deploy LightRAG knowledge service (vector + knowledge graph) on 6900XT.

## Key Dependencies

- Python 3.12 (already on 6900XT)
- DeepSeek API key (available in ~/.pi/agent/auth.json)
- Postgres + pgvector (already installed, weknora/qm database)
- NetworkX graph (default)

## Implementation

1. **Install**: pip install lightrag (LightRAG core, includes Server mode)
   - Optional: `pip install lightrag[api]` for server with UI
2. **Configure**:
   - LLM: DeepSeek (deepseek-v4-flash or deepseek-chat) + embedding
   - vector_storage: pgvector (use existing Postgres)
   - kv_storage + doc_status: Postgres
   - graph_storage: NetworkX (POC, file storage)
3. **Start**: LightRAG API server (lightrag-server) listening on port, bound 0.0.0.0
   - Reference: `lightrag-server --host 0.0.0.0 --port <port>`
4. **Verify**:
   - Ingest a Markdown document
   - Semantic query returns results
   - Graph data exportable (LightRAG built-in /graphs or graph_visual_with_html)
5. **Service binding**: 0.0.0.0 (for Tailscale access from employee computers)

## Reference

- Spec: `docs/kanban/G2/Goal.md`
- Design: `docs/knowledge-rag-design.md`
- 6900XT: requires SSH operation (username hh)

## How to Locate Reference Docs

- `parent: G2` → `docs/kanban/G2/Goal.md`
- Design: `docs/knowledge-rag-design.md`

## Notes

- LightRAG has built-in UI (graph visualization) for frontend iframe embedding
- POC uses NetworkX graph; migrate to Neo4j at larger scale
- DeepSeek handles both embedding + generation (LightRAG supports)
- Use **implement** + tdd (verification scripts) + code-review

## Dependencies

- None (G2 first spec)

## Log
