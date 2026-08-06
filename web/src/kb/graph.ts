import type { KnowledgeGraph } from "@/api/kb";

export interface ViewGraphNode {
  name: string;
  type?: string;
}

export interface ViewGraphEdge {
  source: string;
  target: string;
}

export interface ViewGraph {
  nodes: Record<string, ViewGraphNode>;
  edges: Record<string, ViewGraphEdge>;
}

export interface Relation {
  other: string;
  weight?: number;
}

export interface NodeRelations {
  incoming: Relation[];
  outgoing: Relation[];
}

/** Map a backend KnowledgeGraph ({nodes, edges}) to the v-network-graph format. */
export function mapKnowledgeGraph(graph: KnowledgeGraph): ViewGraph {
  const nodes: Record<string, ViewGraphNode> = {};
  for (const node of graph.nodes) {
    if (!node.id) continue;
    nodes[node.id] = {
      name: node.label || node.id,
      ...(node.type ? { type: node.type } : {}),
    };
  }

  const edges: Record<string, ViewGraphEdge> = {};
  let edgeIndex = 0;
  graph.edges.forEach((edge) => {
    if (!edge.source || !edge.target) return;
    edges[`e${edgeIndex}`] = { source: edge.source, target: edge.target };
    edgeIndex += 1;
  });

  return { nodes, edges };
}

/** Incoming/outgoing relations of a node, derived from the raw graph edges. */
export function nodeRelations(graph: KnowledgeGraph, nodeId: string): NodeRelations {
  const incoming: Relation[] = [];
  const outgoing: Relation[] = [];
  for (const edge of graph.edges) {
    if (edge.source === nodeId && edge.target) {
      outgoing.push({ other: edge.target, ...(edge.weight !== undefined ? { weight: edge.weight } : {}) });
    }
    if (edge.target === nodeId && edge.source) {
      incoming.push({ other: edge.source, ...(edge.weight !== undefined ? { weight: edge.weight } : {}) });
    }
  }
  return { incoming, outgoing };
}

/** Assign a palette color to each distinct entity type, deterministically. */
export function buildTypeColors(types: string[], palette: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  types.forEach((type, index) => {
    map[type] = palette[index % palette.length];
  });
  return map;
}
