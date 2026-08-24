/**
 * G4.S10.T3 — the Neo4j graph port behind the weekly full-graph re-link.
 *
 * Read side:  `listEntities` snapshots every entity (identity, provenance,
 *             degree) as the pre-scan input; `entitiesChangedSince` resolves
 *             the incremental sweep's "source_docs changed since last audit"
 *             set from Document.ingested_at watermarks.
 * Write side: `applyMerges` + `createEdges` run under the SAME
 *             globalGraphWriteMutex as the ingest-time LINK write phase (spec
 *             §4) with the SAME validation rules (both endpoints must exist,
 *             no self-merges, phantom endpoints dropped) and truthful applied
 *             counts. Every merge is a fixed statement sequence per pair —
 *             redirect RELATION edges both directions, move MENTIONED_IN,
 *             fold identity/provenance into the survivor, DETACH DELETE the
 *             shadowed node.
 */
import {
  CHUNK_LABEL,
  DOCUMENT_LABEL,
  ENTITY_LABEL,
  ENTITY_RELATION_TYPE,
  MENTIONED_IN_TYPE,
  type Neo4jDriverLike,
  foldName,
} from "./schema.js";
import { globalGraphWriteMutex } from "./mutex.js";
import type { LinkMerge, LinkNewEdge } from "../link/link-engine.js";
import type { RelinkEntitySnapshot } from "../relink/relink-scan.js";

interface Row {
  get(key: string): unknown;
}

export class Neo4jRelinkGraphPort {
  private readonly driver: Neo4jDriverLike;

  constructor(options: { driver: Neo4jDriverLike }) {
    this.driver = options.driver;
  }

  /** Snapshot of every graph entity for the deterministic pre-scan. */
  async listEntities(): Promise<RelinkEntitySnapshot[]> {
    const session = this.driver.session();
    try {
      const result = (await session.run(
        `MATCH (e:${ENTITY_LABEL})
         OPTIONAL MATCH (e)-[r:${ENTITY_RELATION_TYPE}]-()
         WITH e, count(r) AS degree
         RETURN e.name AS name, e.nameUpper AS nameUpper, e.type AS type,
                e.description AS description, e.aliases AS aliases,
                e.source_docs AS sourceDocs, degree`,
      )) as { records?: Row[] };
      const out: RelinkEntitySnapshot[] = [];
      for (const row of (result?.records ?? []) as Row[]) {
        const name = strOf(row, "name");
        if (!name) continue;
        out.push({
          name,
          nameUpper: strOf(row, "nameUpper") ?? foldName(name),
          ...(strOf(row, "type") ? { type: strOf(row, "type") } : {}),
          ...(strOf(row, "description") !== undefined
            ? { description: strOf(row, "description") }
            : {}),
          aliases: strList(row.get("aliases")),
          sourceDocs: strList(row.get("sourceDocs")),
          degree: Number(row.get("degree") ?? 0),
        });
      }
      return out.sort((a, b) => a.nameUpper.localeCompare(b.nameUpper));
    } finally {
      await session.close();
    }
  }

  /** Entities whose provenance lists touch any document ingested/overwritten
   *  after the watermark ISO timestamp ("source_docs changed since last audit"). */
  async entitiesChangedSince(sinceIso: string): Promise<string[]> {
    const session = this.driver.session();
    try {
      const result = (await session.run(
        `MATCH (d:${DOCUMENT_LABEL})
         WHERE coalesce(d.ingested_at, '') > $since
         WITH collect(d.id) AS ids
         MATCH (e:${ENTITY_LABEL})
         WHERE e.source_docs IS NOT NULL AND any(x IN e.source_docs WHERE x IN ids)
         RETURN collect(DISTINCT e.nameUpper) AS names`,
        { since: sinceIso },
      )) as { records?: Row[] };
      const row = ((result?.records ?? []) as Row[])[0];
      return row ? strList(row.get("names")) : [];
    } finally {
      await session.close();
    }
  }

  /**
   * Apply merge decisions to the EXISTING graph: each accepted pair redirects
   * its edges onto the survivor, unions aliases + provenance and removes the
   * shadowed node. Returns how many merges actually landed.
   */
  async applyMerges(merges: LinkMerge[]): Promise<number> {
    let applied = 0;
    await globalGraphWriteMutex.runExclusive(async () => {
      const session = this.driver.session();
      try {
        for (const merge of merges) {
          const fromUpper = foldName(merge.from);
          const toUpper = foldName(merge.to);
          if (!fromUpper || !toUpper || fromUpper === toUpper) continue;
          const exists = (await session.run(ENDPOINTS_EXIST_CYPHER, {
            fromUpper,
            toUpper,
          })) as { records?: Row[] };
          if (((exists?.records ?? []) as Row[]).length === 0) continue;
          await session.run(REDIRECT_OUTGOING_CYPHER, { fromUpper, toUpper });
          await session.run(REDIRECT_INCOMING_CYPHER, { fromUpper, toUpper });
          await session.run(MOVE_MENTIONS_CYPHER, { fromUpper, toUpper });
          await session.run(FOLD_AND_DELETE_CYPHER, { fromUpper, toUpper });
          applied += 1;
        }
      } finally {
        await session.close();
      }
    });
    return applied;
  }

  /**
   * Create cross-document typed edges between EXISTING nodes. Edges already
   * present are skipped (no duplicate writes); endpoints that do not exist are
   * dropped (phantom guard). Returns how many edges were created.
   */
  async createEdges(edges: LinkNewEdge[]): Promise<number> {
    if (edges.length === 0) return 0;
    return globalGraphWriteMutex.runExclusive(async () => {
      const session = this.driver.session();
      try {
        const candidates = edges
          .map((edge) => ({
            edge,
            sourceUpper: foldName(edge.source),
            targetUpper: foldName(edge.target),
          }))
          .filter(
            (candidate) =>
              candidate.sourceUpper.length > 0 &&
              candidate.targetUpper.length > 0 &&
              candidate.sourceUpper !== candidate.targetUpper,
          );
        if (candidates.length === 0) return 0;

        const endpointNames = [
          ...new Set(candidates.flatMap((c) => [c.sourceUpper, c.targetUpper])),
        ];
        const found = (await session.run(EXISTING_ENDPOINTS_CYPHER, {
          names: endpointNames,
        })) as { records?: Row[] };
        const existingNames = new Set(
          ((found?.records ?? []) as Row[])
            .map((row) => strOf(row, "name"))
            .filter((value): value is string => Boolean(value)),
        );

        const pairs = candidates.map((candidate) => ({
          key: `${candidate.sourceUpper}|${candidate.targetUpper}`,
          ...candidate,
        }));
        const existing = (await session.run(EXISTING_EDGES_CYPHER, {
          pairs: pairs.map(({ key, sourceUpper, targetUpper }) => ({
            key,
            sourceUpper,
            targetUpper,
          })),
        })) as { records?: Row[] };
        const existingKeys = new Set<string>();
        for (const row of (existing?.records ?? []) as Row[]) {
          const key = strOf(row, "key");
          if (key && row.get("exists") === true) existingKeys.add(key);
        }

        let created = 0;
        for (const { edge, key, sourceUpper, targetUpper } of pairs) {
          if (existingKeys.has(key)) continue;
          if (!existingNames.has(sourceUpper) || !existingNames.has(targetUpper)) continue;
          await session.run(CREATE_EDGE_CYPHER, {
            sourceUpper,
            targetUpper,
            source: edge.source,
            target: edge.target,
            relation: edge.relation.slice(0, 60),
            evidenceQuote: edge.evidence_quote.slice(0, 80),
          });
          created += 1;
        }
        return created;
      } finally {
        await session.close();
      }
    });
  }
}

// --- cypher ---------------------------------------------------------------------

const ENDPOINTS_EXIST_CYPHER =
  `// relink_endpoints_exist
   MATCH (from:${ENTITY_LABEL} {nameUpper: $fromUpper})
   MATCH (to:${ENTITY_LABEL} {nameUpper: $toUpper})
   RETURN 1 LIMIT 1`;

const REDIRECT_OUTGOING_CYPHER =
  `MATCH (from:${ENTITY_LABEL} {nameUpper: $fromUpper})-[r:${ENTITY_RELATION_TYPE}]->(x:${ENTITY_LABEL})
   WHERE x.nameUpper <> $toUpper
   MATCH (to:${ENTITY_LABEL} {nameUpper: $toUpper})
   MERGE (to)-[nr:${ENTITY_RELATION_TYPE}]->(x)
   ON CREATE SET nr = r,
                 nr.source = to.name, nr.target = x.name,
                 nr.sourceUpper = to.nameUpper, nr.targetUpper = x.nameUpper
   DELETE r`;

const REDIRECT_INCOMING_CYPHER =
  `MATCH (x:${ENTITY_LABEL})-[r:${ENTITY_RELATION_TYPE}]->(from:${ENTITY_LABEL} {nameUpper: $fromUpper})
   WHERE x.nameUpper <> $toUpper
   MATCH (to:${ENTITY_LABEL} {nameUpper: $toUpper})
   MERGE (x)-[nr:${ENTITY_RELATION_TYPE}]->(to)
   ON CREATE SET nr = r,
                 nr.source = x.name, nr.target = to.name,
                 nr.sourceUpper = x.nameUpper, nr.targetUpper = to.nameUpper
   DELETE r`;

const MOVE_MENTIONS_CYPHER =
  `MATCH (from:${ENTITY_LABEL} {nameUpper: $fromUpper})-[m:${MENTIONED_IN_TYPE}]->(c:${CHUNK_LABEL})
   MATCH (to:${ENTITY_LABEL} {nameUpper: $toUpper})
   MERGE (to)-[:${MENTIONED_IN_TYPE}]->(c)
   DELETE m`;

const FOLD_AND_DELETE_CYPHER =
  `MATCH (from:${ENTITY_LABEL} {nameUpper: $fromUpper})
   MATCH (to:${ENTITY_LABEL} {nameUpper: $toUpper})
   SET to.aliases =
         [a IN coalesce(to.aliases, []) WHERE toUpper(a) <> to.nameUpper]
       + [x IN coalesce(from.aliases, []) + from.name
          WHERE toUpper(x) <> to.nameUpper
            AND NOT toUpper(x) IN [a IN coalesce(to.aliases, []) | toUpper(a)]],
       to.source_docs = CASE WHEN to.source_docs IS NULL THEN coalesce(from.source_docs, [])
                             ELSE to.source_docs +
                                  [d IN coalesce(from.source_docs, []) WHERE NOT d IN to.source_docs] END,
       to.wiki_paths = CASE WHEN to.wiki_paths IS NULL THEN coalesce(from.wiki_paths, [])
                            ELSE to.wiki_paths +
                                 [w IN coalesce(from.wiki_paths, []) WHERE NOT w IN to.wiki_paths] END,
       to.description = coalesce(to.description, from.description)
   DETACH DELETE from`;

const EXISTING_ENDPOINTS_CYPHER =
  `UNWIND $names AS name
   MATCH (e:${ENTITY_LABEL} {nameUpper: name})
   RETURN DISTINCT e.nameUpper AS name`;

const EXISTING_EDGES_CYPHER =
  `UNWIND $pairs AS p
   OPTIONAL MATCH (s:${ENTITY_LABEL} {nameUpper: p.sourceUpper})-[r:${ENTITY_RELATION_TYPE}]->(t:${ENTITY_LABEL} {nameUpper: p.targetUpper})
   RETURN p.key AS key, r IS NOT NULL AS exists`;

const CREATE_EDGE_CYPHER =
  `MATCH (s:${ENTITY_LABEL} {nameUpper: $sourceUpper})
   MATCH (t:${ENTITY_LABEL} {nameUpper: $targetUpper})
   CREATE (s)-[r:${ENTITY_RELATION_TYPE}]->(t)
   SET r.source = $source, r.target = $target,
       r.sourceUpper = $sourceUpper, r.targetUpper = $targetUpper,
       r.keywords = [$relation], r.description = $evidenceQuote, r.created_by = 'relink'`;

function strOf(row: Row, key: string): string | undefined {
  const value = row.get(key);
  return value === null || value === undefined ? undefined : String(value);
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry)).filter((entry) => entry.length > 0);
}
