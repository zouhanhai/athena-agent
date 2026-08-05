---
id: g2_s4
title: "G2.S4: Frontend Knowledge Panels"
layer: S
parent: G2
owner: eng-director
status: active
milestone: M2
acceptance_criteria:
  - "Knowledge panel displays LightRAG knowledge graph (iframe embed built-in UI or custom rendered)"
  - "Wiki panel displays llm_wiki pages (Vue custom rendered, CALEO style)"
  - "Knowledge search box (calls backend knowledge API)"
  - "Graph and wiki data come from backend kb/ service layer"
  - "Coordinates with existing sidebar/CALEO theme"
---

# G2.S4: Frontend Knowledge Panels

## Task

Implement the portal frontend Knowledge (graph) and Wiki panels.

## Key Dependencies

- G2.S3 (knowledge access layer, backend kb/ service + retrieval API)
- G2.S1/S2 (LightRAG graph + llm_wiki data)

## Implementation

### 1. Knowledge Graph Panel (/knowledge)
- LightRAG knowledge graph visualization:
  - Preferred: iframe embed LightRAG built-in graph UI (server deployed in G2.S1)
  - Or: backend /api/kb/graph returns graph data → Vue custom render (CALEO style)
- Display entity relationship graph

### 2. Wiki Panel (/wiki)
- llm_wiki page browsing:
  - Backend /api/kb/wiki reads llm_wiki API → markdown
  - Vue custom render (CALEO style, reference G1.S2 layout)
- Page list + content rendering (markdown)

### 3. Knowledge Search
- Search box: input → backend knowledge retrieval API → display results
- Calls G2.S3 knowledge APIs

## Reference

- Spec: `docs/kanban/G2/Goal.md`
- Design: `docs/knowledge-rag-design.md`
- Existing frontend: `web/src/views/KnowledgeView.vue`, `WikiView.vue` (G1.S2 placeholders)
- Layout: G1.S2 (CALEO theme + sidebar)

## How to Locate Reference Docs

- `parent: G2` → `docs/kanban/G2/Goal.md`
- Existing views: `web/src/views/`

## Notes

- Reuse G1.S2's API layer + store layering (web/src/api/, stores/)
- Graph prefers iframe (simple), can custom render later
- CALEO style: orange #ff6633 + dark blue #2d3142 + sky blue #69b3e7
- Use **implement** + tdd + code-review

## Dependencies

- G2.S3

## Log
