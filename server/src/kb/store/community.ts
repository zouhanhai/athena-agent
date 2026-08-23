/**
 * G4.S9.T1 — Leiden-class community detection over the Entity+RELATION graph.
 *
 * Implementation choice (documented in the ticket Progress Log): the
 * neo4j-spike community container ships NO GDS plugin (`/var/lib/neo4j/plugins`
 * holds only README.txt) and the GDS community edition would add a
 * license-sensitive server dependency — so detection runs IN-PROCESS: the graph
 * is read over the driver, a deterministic Louvain (Blondel et al., seeded by
 * sorted iteration order — no RNG at all) partitions it, and memberships are
 * written back as `e.community_id` through one batched UNWIND per 500 nodes.
 *
 * Incremental strategy (`resolveStrategy`): delete / big ingest → full re-run;
 * small wiki-edit or small ingest above the size threshold → local recompute of
 * the touched entities' closure (touched ∪ neighbours ∪ same-community members,
 * capped); anything below `fullRunThreshold` entities → always full (cheap and
 * simplest). Refreshes run fire-and-forget at the call sites — they NEVER block
 * online retrieval; memberships are eventually consistent.
 *
 * Community ids are STABLE: `c_` + first 12 hex of sha256 over the sorted,
 * case-folded member ids. Identical composition ⇒ identical id across re-runs,
 * so T2's Community nodes don't churn when nothing changed.
 */

import { createHash } from "node:crypto";
import {
  ENTITY_LABEL,
  ENTITY_RELATION_TYPE,
  type Neo4jDriverLike,
} from "./schema.js";

/** Tunables of the incremental strategy (G4.S9 Spec §1). */
export interface CommunityPolicy {
  /** Graphs with fewer entities always take the full re-run (fixture scale). */
  fullRunThreshold: number;
  /** An ingest adding at least this many relations is a "big ingest" → full. */
  bigIngestRelationsThreshold: number;
  /** An ingest adding at least this many entities is a "big ingest" → full. */
  bigIngestEntitiesThreshold: number;
  /** A wiki-edit touching more than this many entities falls back to full. */
  localDiffLimit: number;
  /** A local recompute whose closure exceeds this many nodes falls back to full. */
  localMaxNodes: number;
  /** Modularity resolution used on graphs below `fullRunThreshold`: coarse
   *  topical clusters read better as summary units than fine fragments. */
  smallGraphResolution: number;
}

export const DEFAULT_COMMUNITY_POLICY: CommunityPolicy = {
  fullRunThreshold: 200,
  bigIngestRelationsThreshold: 25,
  bigIngestEntitiesThreshold: 40,
  localDiffLimit: 10,
  localMaxNodes: 500,
  smallGraphResolution: 0.5,
};

export type CommunityRefreshTrigger =
  | { kind: "delete" }
  | { kind: "ingest"; entitiesStored: number; relationsStored: number; touchedEntityNames?: string[] }
  | { kind: "wiki-edit"; touchedEntityNames: string[] };

export type CommunityStrategy = "full" | "local";

/** Pure policy: which refresh strategy a trigger demands at `entityCount` scale. */
export function resolveStrategy(
  entityCount: number,
  trigger: CommunityRefreshTrigger,
  policy: CommunityPolicy = DEFAULT_COMMUNITY_POLICY,
): CommunityStrategy {
  if (trigger.kind === "delete") return "full";
  if (entityCount < policy.fullRunThreshold) return "full";
  if (trigger.kind === "ingest") {
    const bigIngest =
      trigger.relationsStored >= policy.bigIngestRelationsThreshold ||
      trigger.entitiesStored >= policy.bigIngestEntitiesThreshold;
    // A small ingest can recompute locally — but only when the caller names the
    // touched entities (the local closure needs seeds).
    if (
      !bigIngest &&
      trigger.touchedEntityNames &&
      trigger.touchedEntityNames.length <= policy.localDiffLimit
    ) {
      return "local";
    }
    return "full";
  }
  if (trigger.touchedEntityNames.length <= policy.localDiffLimit) return "local";
  return "full";
}

/** Stable community key: sha256 over sorted, trimmed, case-folded member ids. */
export function communityIdForMembers(members: string[]): string {
  const canonical = [...members].map((m) => m.trim().toUpperCase()).sort().join("\u0000");
  const hash = createHash("sha256").update(canonical).digest("hex");
  return `c_${hash.slice(0, 12)}`;
}

export interface CommunityGraphInput {
  /** Folded entity ids (Entity.nameUpper). */
  nodeIds: string[];
  edges: Array<{ source: string; target: string; weight?: number }>;
  /** Modularity resolution γ (GDS-style). <1 merges more aggressively — used
   *  on small graphs to favour coarse topical clusters over fragmentation.
   *  Default 1 (standard modularity). */
  resolution?: number;
}

export interface CommunityPartition {
  /** nodeId → stable community key (every input node assigned exactly once). */
  assignment: Map<string, string>;
  /** community key → its member ids (sorted ascending). */
  communities: Map<string, string[]>;
}

interface LevelGraph {
  nodes: string[];
  adjacency: Map<string, Map<string, number>>;
}

const EPSILON = 1e-12;
const MAX_LEVELS = 20;
const MAX_PASSES = 30;

function buildLevelGraph(nodes: string[], edges: CommunityGraphInput["edges"]): LevelGraph {
  const sorted = [...new Set(nodes.map((n) => n.toUpperCase()))].sort();
  const adjacency = new Map<string, Map<string, number>>();
  for (const node of sorted) adjacency.set(node, new Map());
  for (const edge of edges) {
    const a = edge.source.toUpperCase();
    const b = edge.target.toUpperCase();
    if (a === b || !adjacency.has(a) || !adjacency.has(b)) continue;
    const weight = edge.weight ?? 1;
    if (weight <= 0) continue;
    const adjA = adjacency.get(a)!;
    const adjB = adjacency.get(b)!;
    adjA.set(b, (adjA.get(b) ?? 0) + weight);
    adjB.set(a, (adjB.get(a) ?? 0) + weight);
  }
  return { nodes: sorted, adjacency };
}

/**
 * Deterministic Louvain (no RNG): modularity-optimising node moves iterate in
 * sorted order, ties break toward the smaller community key, aggregation
 * relabels communities by their smallest member. Equivalent partitions on the
 * same graph always produce identical output regardless of input order.
 */
function louvainPartition(graphInput: CommunityGraphInput): Map<string, string> {
  let level = buildLevelGraph(graphInput.nodeIds, graphInput.edges);
  const gamma = graphInput.resolution ?? 1;
  // node at level L → root community chain resolved at the end.
  let mapping = new Map<string, string>(level.nodes.map((n) => [n, n]));

  for (let depth = 0; depth < MAX_LEVELS; depth += 1) {
    const { partition, moved } = oneLevelMoves(level, gamma);
    const distinctComms = new Set(partition.values()).size;
    if (!moved || distinctComms === level.nodes.length) break;

    // Relabel communities by their smallest member (deterministic).
    const membersByComm = new Map<string, string[]>();
    for (const [node, comm] of partition) {
      const list = membersByComm.get(comm) ?? [];
      list.push(node);
      membersByComm.set(comm, list);
    }
    const commOrder = [...membersByComm.keys()].sort((a, b) =>
      (membersByComm.get(a)![0] ?? a).localeCompare(membersByComm.get(b)![0] ?? b),
    );
    const relabel = new Map(commOrder.map((comm, index) => [comm, `C${index}`]));

    const nextMapping = new Map<string, string>();
    for (const [orig, current] of mapping) {
      nextMapping.set(orig, relabel.get(partition.get(current)!) ?? partition.get(current)!);
    }
    mapping = nextMapping;

    level = aggregate(level, partition, membersByComm, relabel);
  }

  const result = new Map<string, string>();
  for (const node of graphInput.nodeIds) {
    result.set(node.toUpperCase(), mapping.get(node.toUpperCase()) ?? node.toUpperCase());
  }
  return result;
}

/** One Louvain level: repeated local moves until no improving move remains. */
function oneLevelMoves(level: LevelGraph, gamma = 1): { partition: Map<string, string>; moved: boolean } {
  const { nodes, adjacency } = level;
  const communityOf = new Map<string, string>(nodes.map((n) => [n, n]));
  const degrees = new Map<string, number>();
  for (const node of nodes) {
    let degree = 0;
    for (const weight of adjacency.get(node)!.values()) degree += weight;
    degrees.set(node, degree);
  }
  const m2 = [...degrees.values()].reduce((sum, d) => sum + d, 0);

  // sigmaTot(C): sum of degrees in C. sigmaIn(C): Σ ordered-pair internal weight
  // (each intra-edge twice, self-loop once). Initial communities are singletons.
  const sigmaTot = new Map<string, number>();
  const sigmaIn = new Map<string, number>();
  for (const node of nodes) {
    sigmaTot.set(node, degrees.get(node)!);
    sigmaIn.set(node, selfLoop(adjacency, node));
  }

  const linksTo = (node: string, comm: string): number => {
    let total = 0;
    for (const [other, weight] of adjacency.get(node)!) {
      if (other !== node && communityOf.get(other) === comm) total += weight;
    }
    return total;
  };

  const internalPairsWeight = (node: string, comm: string): number => {
    // Weight lost/gained inside C when node joins/leaves (ordered pairs).
    return 2 * linksTo(node, comm);
  };

  let movedAny = false;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    let movedThisPass = 0;
    for (const node of nodes) {
      const oldComm = communityOf.get(node)!;
      const degree = degrees.get(node)!;

      // Remove node from its community.
      sigmaTot.set(oldComm, (sigmaTot.get(oldComm) ?? 0) - degree);
      sigmaIn.set(oldComm, (sigmaIn.get(oldComm) ?? 0) - internalPairsWeight(node, oldComm) - selfLoop(adjacency, node));

      const candidateComms = new Set<string>();
      for (const other of adjacency.get(node)!.keys()) {
        if (other !== node) candidateComms.add(communityOf.get(other)!);
      }
      candidateComms.add(oldComm);

      const gainFor = (comm: string): number => {
        const sigmaInC = sigmaIn.get(comm) ?? 0;
        const sigmaTotC = sigmaTot.get(comm) ?? 0;
        const kiIn = linksTo(node, comm);
        // Generalized modularity gain with resolution γ: γ < 1 shrinks the
        // expected-degree penalty and thus favours coarser communities.
        return (
          (sigmaInC + 2 * kiIn) / m2 -
          gamma * ((sigmaTotC + degree) / m2) ** 2 -
          (sigmaInC / m2 - gamma * (sigmaTotC / m2) ** 2 - gamma * (degree / m2) ** 2)
        );
      };

      let bestComm = oldComm;
      let bestGain = gainFor(oldComm);
      for (const comm of [...candidateComms].sort()) {
        const gain = gainFor(comm);
        if (gain > bestGain + EPSILON) {
          bestGain = gain;
          bestComm = comm;
        }
      }

      // Re-insert into the chosen community.
      sigmaTot.set(bestComm, (sigmaTot.get(bestComm) ?? 0) + degree);
      sigmaIn.set(bestComm, (sigmaIn.get(bestComm) ?? 0) + internalPairsWeight(node, bestComm) + selfLoop(adjacency, node));
      if (bestComm !== oldComm) {
        communityOf.set(node, bestComm);
        movedThisPass += 1;
      }
    }
    if (movedThisPass > 0) movedAny = true;
    if (movedThisPass === 0) break;
  }

  return { partition: communityOf, moved: movedAny };
}

function selfLoop(adjacency: Map<string, Map<string, number>>, node: string): number {
  return adjacency.get(node)?.get(node) ?? 0;
}

/** Build the next-level graph: communities become super-nodes. */
function aggregate(
  level: LevelGraph,
  partition: Map<string, string>,
  _membersByComm: Map<string, string[]>,
  relabel: Map<string, string>,
): LevelGraph {
  const superNodes = [...new Set([...partition.values()].map((c) => relabel.get(c) ?? c))].sort();
  const superAdjacency = new Map<string, Map<string, number>>(
    superNodes.map((n) => [n, new Map()]),
  );
  for (const [a, neighbors] of level.adjacency) {
    const commA = relabel.get(partition.get(a)!)!;
    for (const [b, w] of neighbors) {
      const commB = relabel.get(partition.get(b)!)!;
      const row = superAdjacency.get(commA)!;
      row.set(commB, (row.get(commB) ?? 0) + w);
    }
  }
  return { nodes: superNodes, adjacency: superAdjacency };
}

/** Cluster the graph deterministically and derive stable community keys. */
export function detectCommunities(graphInput: CommunityGraphInput): CommunityPartition {
  const labels = louvainPartition(graphInput);
  const membersByKey = new Map<string, string[]>();
  for (const [node, label] of labels) {
    const list = membersByKey.get(label) ?? [];
    list.push(node);
    membersByKey.set(label, list);
  }
  const communities = new Map<string, string[]>();
  const assignment = new Map<string, string>();
  for (const [, members] of membersByKey) {
    const key = communityIdForMembers(members);
    communities.set(key, members.sort());
    for (const member of members) assignment.set(member, key);
  }
  return { assignment, communities };
}

// ---------------------------------------------------------------------------
// Neo4j-backed service
// ---------------------------------------------------------------------------

/** Outcome of one refresh run (surfaced in logs / future admin endpoints). */
export interface CommunityRunResult {
  strategy: "full" | "local" | "skipped";
  /** Entities that received a `community_id` in this run. */
  entitiesAssigned: number;
  /** Number of distinct communities after the run (full runs only). */
  communities?: number;
  /** Set when the run failed — callers already returned; never blocks retrieval. */
  error?: string;
}

interface EdgeRow {
  source: string;
  target: string;
  weight: number;
  sourceCommunity: string | null;
  targetCommunity: string | null;
}

const WRITE_BATCH_SIZE = 500;

const READ_ENTITIES_CYPHER =
  `MATCH (e:${ENTITY_LABEL})\n` +
  `RETURN e.nameUpper AS id, e.community_id AS communityId`;

const READ_EDGES_CYPHER =
  `MATCH (a:${ENTITY_LABEL})-[r:${ENTITY_RELATION_TYPE}]-(b:${ENTITY_LABEL})\n` +
  `RETURN a.nameUpper AS source, b.nameUpper AS target,\n` +
  `       coalesce(r.weight, 1) AS weight,\n` +
  `       a.community_id AS sourceCommunity, b.community_id AS targetCommunity`;

const CO_MENTION_CYPHER =
  `MATCH (a:${ENTITY_LABEL})-[:MENTIONED_IN]->(c:Chunk)<-[:MENTIONED_IN]-(b:${ENTITY_LABEL})\n` +
  `WHERE a.nameUpper < b.nameUpper\n` +
  `RETURN a.nameUpper AS source, b.nameUpper AS target, count(c) AS weight`;

const WRITE_MEMBERSHIPS_CYPHER =
  `UNWIND $memberships AS m\n` +
  `MATCH (e:${ENTITY_LABEL} {nameUpper: m.id})\n` +
  `SET e.community_id = m.communityId`;

function recordGet(record: unknown, key: string): unknown {
  return (record as { get?: (key: string) => unknown }).get?.(key);
}

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * Runs Leiden-class community detection against the Neo4j entity graph and
 * persists memberships as `e.community_id`. All failures are caught by
 * `refresh` and reported on the result — a broken detector must never break an
 * ingest/delete flow or online retrieval (eventual consistency).
 */
export class Neo4jCommunityService {
  private readonly driver: Neo4jDriverLike;
  private readonly policy: CommunityPolicy;
  /** Weight multiplier applied to shared-chunk co-mention pairs (0 = off). */
  private readonly coMentionWeight: number;

  constructor(options: {
    driver: Neo4jDriverLike;
    policy?: CommunityPolicy;
    coMentionWeight?: number;
  }) {
    this.driver = options.driver;
    this.policy = options.policy ?? DEFAULT_COMMUNITY_POLICY;
    // Co-mention weighting defaults ON: entities sharing chunks are topically
    // tied (G4.S9 half-orphan motivation) and sparse RELATION-only trees would
    // otherwise fragment under modularity optimisation.
    this.coMentionWeight = options.coMentionWeight ?? 1;
  }

  /** Run the refresh demanded by `trigger`. Resolves even on failure. */
  async refresh(trigger: CommunityRefreshTrigger): Promise<CommunityRunResult> {
    try {
      const { ids, edges } = await this.loadGraph();
      const strategy = resolveStrategy(ids.length, trigger, this.policy);

      if (strategy === "local" && trigger.kind !== "delete") {
        const touched = (trigger.touchedEntityNames ?? []).map((n) =>
          n.trim().toUpperCase(),
        );
        const closure = localClosure(ids, edges, touched, this.policy.localMaxNodes);
        if (closure.size < ids.length) {
          const subgraph: CommunityGraphInput = {
            nodeIds: [...closure],
            edges: edges.filter((e) => closure.has(e.source) && closure.has(e.target)),
          };
          return await this.writePartition(subgraph, "local");
        }
      }

      // Full re-run: whole graph, isolated entities become singletons. Below
      // the size threshold the coarser small-graph resolution applies.
      const resolution = ids.length < this.policy.fullRunThreshold
        ? this.policy.smallGraphResolution
        : undefined;
      return await this.writePartition({ nodeIds: ids, edges, ...(resolution !== undefined ? { resolution } : {}) }, "full");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[kb:community] refresh failed (${trigger.kind}): ${message}`);
      return { strategy: "skipped", entitiesAssigned: 0, error: message };
    }
  }

  /** Read entities + undirected RELATION edges (deduplicated, weights summed). */
  private async loadGraph(): Promise<{ ids: string[]; edges: EdgeRow[] }> {
    const session = this.driver.session();
    try {
      const entityResult = await session.run(READ_ENTITIES_CYPHER);
      const ids: string[] = [];
      for (const record of (entityResult as { records?: unknown[] }).records ?? []) {
        const id = str(recordGet(record, "id"));
        if (id) ids.push(id.toUpperCase());
      }
      const uniqueIds = [...new Set(ids)].sort();

      const edgeRows = new Map<string, EdgeRow>();
      for (const cypher of this.edgeReadQueries()) {
        const edgeResult = await session.run(cypher.query);
        for (const record of (edgeResult as { records?: unknown[] }).records ?? []) {
          const source = str(recordGet(record, "source"))?.toUpperCase();
          const target = str(recordGet(record, "target"))?.toUpperCase();
          if (!source || !target || source === target) continue;
          const weight = Number(recordGet(record, "weight") ?? 1) * cypher.multiplier;
          if (!Number.isFinite(weight) || weight <= 0) continue;
          const [a, b] = source < target ? [source, target] : [target, source];
          const key = `${a}\u0000${b}`;
          const existing = edgeRows.get(key);
          if (existing) existing.weight += weight;
          else {
            edgeRows.set(key, {
              source: a,
              target: b,
              weight,
              sourceCommunity:
                source === a ? str(recordGet(record, "sourceCommunity")) : str(recordGet(record, "targetCommunity")),
              targetCommunity:
                source === a ? str(recordGet(record, "targetCommunity")) : str(recordGet(record, "sourceCommunity")),
            });
          }
        }
      }
      return { ids: uniqueIds, edges: [...edgeRows.values()] };
    } finally {
      await session.close();
    }
  }

  private edgeReadQueries(): Array<{ query: string; multiplier: number }> {
    const queries = [{ query: READ_EDGES_CYPHER, multiplier: 1 }];
    if (this.coMentionWeight > 0) queries.push({ query: CO_MENTION_CYPHER, multiplier: this.coMentionWeight });
    return queries;
  }

  /** Detect over `subgraph` and write `community_id` back in batches. */
  private async writePartition(
    subgraph: CommunityGraphInput,
    strategy: "full" | "local",
  ): Promise<CommunityRunResult> {
    const partition = detectCommunities(subgraph);
    const entries = [...partition.assignment.entries()].map(([id, communityId]) => ({
      id,
      communityId,
    }));

    const session = this.driver.session();
    try {
      for (let start = 0; start < entries.length; start += WRITE_BATCH_SIZE) {
        await session.run(WRITE_MEMBERSHIPS_CYPHER, {
          memberships: entries.slice(start, start + WRITE_BATCH_SIZE),
        });
      }
    } finally {
      await session.close();
    }
    return {
      strategy,
      entitiesAssigned: entries.length,
      ...(strategy === "full" ? { communities: partition.communities.size } : {}),
    };
  }
}

/**
 * Bounded local-recompute scope (documented heuristic): the touched entities ∪
 * every member of their CURRENT communities ∪ their direct RELATION neighbours.
 * When no touched entity exists, or the closure would cover the whole graph
 * anyway / exceed `cap`, the caller falls back to a full re-run. Limitation:
 * boundary drift between the recomputed sub-partition and untouched communities
 * is possible — eventual consistency is restored by the next full run
 * (delete/big ingest triggers), never at the cost of blocking retrieval.
 */
export function localClosure(
  allIds: string[],
  edges: Pick<EdgeRow, "source" | "target" | "sourceCommunity" | "targetCommunity">[],
  touchedUpper: string[],
  cap: number,
): Set<string> {
  const known = new Set(allIds);
  const seeds = touchedUpper.filter((id) => known.has(id));
  if (seeds.length === 0 || seeds.length >= allIds.length) return new Set(allIds);

  // Node → current community id, rebuilt from the last persisted memberships.
  const communityOfNode = new Map<string, string>();
  for (const edge of edges) {
    if (edge.sourceCommunity && !communityOfNode.has(edge.source)) {
      communityOfNode.set(edge.source, edge.sourceCommunity);
    }
    if (edge.targetCommunity && !communityOfNode.has(edge.target)) {
      communityOfNode.set(edge.target, edge.targetCommunity);
    }
  }

  const closure = new Set<string>(seeds);

  // 1. Members sharing a current community with any touched entity.
  const seedCommunities = new Set(
    seeds.map((seed) => communityOfNode.get(seed)).filter((c): c is string => Boolean(c)),
  );
  if (seedCommunities.size > 0) {
    for (const [node, comm] of communityOfNode) {
      if (seedCommunities.has(comm)) closure.add(node);
    }
  }

  // 2. Direct neighbours of the touched entities (one hop, non-transitive).
  const neighbours = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!neighbours.has(edge.source)) neighbours.set(edge.source, new Set());
    if (!neighbours.has(edge.target)) neighbours.set(edge.target, new Set());
    neighbours.get(edge.source)!.add(edge.target);
    neighbours.get(edge.target)!.add(edge.source);
  }
  for (const seed of seeds) {
    for (const other of neighbours.get(seed) ?? []) closure.add(other);
  }

  if (closure.size >= allIds.length || closure.size > cap) return new Set(allIds);
  return closure;
}

