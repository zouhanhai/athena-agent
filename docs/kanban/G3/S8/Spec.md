---
id: g3_s8
title: "G3.S8: Knowledge Graph UX (remove Add Data from Knowledge, topic/localized graph views)"
layer: S
parent: G3
owner: pm
status: active
milestone: M3
acceptance_criteria:
  - "Add Data panel removed from Knowledge page (ingestion already lives in Uploads)"
  - "Graph 'all' view no longer dumps 1000+ nodes — show topic or deeper, or search-node-local graph"
---

# G3.S8: Knowledge Graph UX (remove Add Data, topic/localized graph views)

## Task

Improve the Knowledge Graph page UX:
1. Remove the **Add Data** panel (file/URL ingestion already exists on the Uploads page — duplicated here is confusing).
2. Fix the **"all" graph view**: with 1000+ nodes the 2D force layout is unreadable. Prefer:
   - showing a **topic** (or a deeper sub-topic) only, OR
   - **search a node → show that node's local neighborhood subgraph** (node + its 1-2 hop relations).

## Background

The Knowledge graph holds 1000+ nodes; rendering all of them in v-network-graph's force layout is useless. Users need a focused view: pick a topic or search a node to see its local neighborhood. Also the old KnowledgeView has an "Add Data" panel that duplicates the Uploads page — remove it.

## Implementation

- `web/src/views/KnowledgeView.vue`:
  - Remove the Add Data panel block (drop-zone / URL row / task list) — the header "Add Data" toggle button too. Ingestion stays on Uploads.
  - Keep topic filter; when a topic is selected only that topic's subgraph loads (already does via `getGraph(undefined, topic)`).
  - Add **search-node → local neighborhood**: when the user searches a node name (or clicks a node), show only that node + its incoming/outgoing relations (1-2 hops) instead of the whole graph.
- Default view: a topic or an empty/compact state — never auto-load all nodes.

## Reference
- `docs/kanban/G3/S7/Spec.md`
- `web/src/views/KnowledgeView.vue`
- `web/src/api/kb.ts` (getGraph / searchKnowledge)
- `web/src/kb/graph.ts` (mapKnowledgeGraph / nodeRelations)

## Log
