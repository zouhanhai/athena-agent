import type { KnowledgeGraph } from "@/api/kb";

export interface ViewGraphNode {
  name: string;
  type?: string;
  /** Node size in px. v-network-graph renders the node circle with this size;
   *  without it the shape gets zero/null dimensions and the dot is invisible in
   *  the default (non-hover) state (only the label shows). */
  size?: number;
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
      size: 14,
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

/** Extract the local neighborhood of `rootId`: the root node plus every node
 *  reachable within `hops` edges, keeping only edges between included nodes.
 *  Used to render a small focused subgraph instead of the full 1000+ graph. */
export function localSubgraph(
  graph: KnowledgeGraph,
  rootId: string,
  hops = 2,
): KnowledgeGraph {
  const included = new Set<string>([rootId]);
  let frontier = new Set<string>([rootId]);
  for (let hop = 0; hop < hops; hop++) {
    const next = new Set<string>();
    for (const edge of graph.edges) {
      if (!edge.source || !edge.target) continue;
      if (frontier.has(edge.source) && !included.has(edge.target)) {
        next.add(edge.target);
      }
      if (frontier.has(edge.target) && !included.has(edge.source)) {
        next.add(edge.source);
      }
    }
    for (const id of next) included.add(id);
    frontier = next;
  }

  return {
    nodes: graph.nodes.filter((node) => node.id && included.has(node.id)),
    edges: graph.edges.filter(
      (edge) =>
        edge.source &&
        edge.target &&
        included.has(edge.source) &&
        included.has(edge.target),
    ),
  };
}

/** Assign a palette color to each distinct entity type, deterministically. */
export function buildTypeColors(types: string[], palette: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  types.forEach((type, index) => {
    map[type] = palette[index % palette.length];
  });
  return map;
}
