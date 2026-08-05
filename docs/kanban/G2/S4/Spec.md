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

### 1. Knowledge Graph Panel (/knowledge) — 2D graph
- LightRAG knowledge graph visualization (entity-relation graph):
  - Data: backend `/api/kb/graph` returns `{nodes, edges}` from LightRAG `/graphs`
  - Render: **2D force-directed graph** in Vue (e.g. `v-network-graph` or `3d-force-graph` 2D mode / `sigma` Vue wrapper)
  - Nodes = entities, edges = relationships; click node to see details
- CALEO style colors (orange primary, sky blue links)
- Optionally show llm_wiki wikilinks graph as a separate tab/view

### 2. Wiki Panel (/wiki) — wiki tree
- llm_wiki page browsing:
  - Data: backend `/api/kb/wiki` reads llm_wiki API → page tree + markdown content
  - Render: **wiki tree** (Vue TDesign Tree component) — click to expand each level until files, click file to open content
  - Content: markdown rendering (CALEO style)
- Left: wiki tree navigation; Right: page content viewer

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
- Graph: **2D force-directed** (not 3D, for readability); use a Vue graph lib feeding LightRAG `/graphs` data
- Wiki: TDesign Tree for navigation + markdown renderer for content
- **Design consistency (mandatory)**: all new pages must follow the existing frontend design language —
  use `--caleo-*` + TDesign `--td-*` CSS variables (no hardcoded colors), card layout matching ChatView,
  CALEO palette (orange #ff6633 primary, dark #2d3142, sky #69b3e7), dark/light theme toggle aware,
  consistent header/empty/loading/error states. Reference ChatView.vue + SidebarNav.vue + theme/index.ts.
- Use **implement** + tdd + code-review

## Dependencies

- G2.S3

## Log
