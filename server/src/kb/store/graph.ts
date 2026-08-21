/**
 * Neo4j graph-query service (G4.S8.T12) — the SE80-style code-object browser's
 * read path over the entity-relation graph.
 *
 * Exposes two query operations on `Entity` nodes using a read-only session:
 *   - `listEntities({ type?, q?, limit? })` — entities filtered by type and a
 *     case-insensitive name substring, ordered by name.
 *   - `getEntity(name)` — one entity + its directed edge lists (outgoing =
 *     "uses", incoming = "used by"/WHERE-USED) with the wiki page deep-link for
 *     each related endpoint, resolved via `Entity -[:MENTIONED_IN]-> Chunk ->
 *     Document -[:IS_DOCUMENT]-> WikiPage`.
 *
 * Each relation entry resolves to the wiki page(s) whose chunks mention the
 * endpoint entity (its `MENTIONED_IN` chunks namespaced by `documentId`); an
 * endpoint with no wiki page renders without a link.
 *
 * The driver is injected through the same minimal `Neo4jDriverLike` seam as the
 * ingest/retrieval services so tests use doubles and production uses the real
 * neo4j-driver.
 */
import {
  CHUNK_LABEL,
  DOCUMENT_LABEL,
  ENTITY_LABEL,
  ENTITY_RELATION_TYPE,
  IS_DOCUMENT_TYPE,
  MENTIONED_IN_TYPE,
  WIKIPAGE_LABEL,
  type Neo4jDriverLike,
} from "./schema.js";

export interface EntityListEntry {
  name: string;
  type?: string;
  description?: string;
}

export interface EntityRelationEntry {
  /** The relationship keyword(s) (e.g. READS_FROM / CALLS / BINDS_TO). */
  keywords: string[];
  description?: string;
  /** The counterpart entity name (target for outgoing, source for incoming). */
  entity: string;
  type?: string;
  /** Wiki page path(s) whose chunks mention the counterpart — deep-link targets.
   *  Empty when no page resolves (render without a link). */
  wikiPaths: string[];
}

export interface EntityDetail {
  name: string;
  type?: string;
  description?: string;
  /** Edges where this entity is the source: what it USES. */
  outgoing: EntityRelationEntry[];
  /** Edges where this entity is the target: what USES it (WHERE-USED). */
  incoming: EntityRelationEntry[];
}

interface RawEdgeRow {
  keywords?: string[] | string;
  description?: string;
  name: string;
  type?: string;
}

export interface EntityGraphOptions {
  driver: Neo4jDriverLike;
}

function str(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return String(value);
}

function strList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

function mapEdge(row: { get(key: string): unknown }): EntityRelationEntry {
  const keywords = strList(row.get("keywords"));
  const entity = str(row.get("name")) ?? "";
  const type = str(row.get("type"));
  const description = str(row.get("description"));
  return {
    keywords,
    ...(type !== undefined ? { type } : {}),
    ...(description !== undefined ? { description } : {}),
    entity,
    wikiPaths: [],
  };
}

export class EntityGraphService {
  private readonly driver: Neo4jDriverLike;

  constructor(options: EntityGraphOptions) {
    this.driver = options.driver;
  }

  /** `GET /api/kb/graph/entities?type=&q=&limit=` → entities filtered by an
   *  exact type and a case-insensitive name substring, ordered by name. */
  async listEntities(options: {
    type?: string;
    q?: string;
    limit?: number;
  } = {}): Promise<EntityListEntry[]> {
    const clauses: string[] = [`MATCH (e:${ENTITY_LABEL})`];
    const params: Record<string, unknown> = { limit: options.limit ?? 50 };
    const wheres: string[] = [];
    if (options.type) {
      wheres.push("e.type = $type");
      params.type = options.type;
    }
    if (options.q) {
      wheres.push("toUpper(e.name) CONTAINS toUpper($q)");
      params.q = options.q;
    }
    if (wheres.length > 0) clauses.push(`WHERE ${wheres.join(" AND ")}`);
    clauses.push(
      `RETURN e.name AS name, e.type AS type, e.description AS description`,
      `ORDER BY e.name`,
      `LIMIT $limit`,
    );
    const records = await this.run(clauses.join("\n"), params);
    return records.map((r) => ({
      name: str(r.get("name")) ?? "",
      ...(str(r.get("type")) !== undefined ? { type: str(r.get("type")) } : {}),
      ...(str(r.get("description")) !== undefined ? { description: str(r.get("description")) } : {}),
    }));
  }

  /** `GET /api/kb/graph/entities/:name` → the entity + its Uses (outgoing) and
   *  Used-by (incoming) relation lists, each entry deep-linking to the wiki
   *  page(s) that mention the counterpart entity. Returns null when the entity
   *  does not exist. */
  async getEntity(name: string): Promise<EntityDetail | null> {
    const nameUpper = name.toUpperCase();
    const entityRows = await this.run(
      `MATCH (e:${ENTITY_LABEL} {nameUpper: $nameUpper})
       RETURN e.name AS name, e.type AS type, e.description AS description`,
      { nameUpper },
    );
    const entityRow = entityRows[0];
    if (!entityRow) return null;

    const [outgoing, incoming] = await Promise.all([
      this.run(
        `MATCH (a:${ENTITY_LABEL} {nameUpper: $nameUpper})-[r:${ENTITY_RELATION_TYPE}]->(b:${ENTITY_LABEL})
         RETURN r.keywords AS keywords, r.description AS description, b.name AS name, b.type AS type`,
        { nameUpper },
      ),
      this.run(
        `MATCH (a:${ENTITY_LABEL} {nameUpper: $nameUpper})<-[r:${ENTITY_RELATION_TYPE}]-(b:${ENTITY_LABEL})
         RETURN r.keywords AS keywords, r.description AS description, b.name AS name, b.type AS type`,
        { nameUpper },
      ),
    ]);

    const outgoingEntries = outgoing.map(mapEdge);
    const incomingEntries = incoming.map(mapEdge);
    await this.attachWikiPaths([...outgoingEntries, ...incomingEntries]);

    return {
      name: str(entityRow.get("name")) ?? name,
      ...(str(entityRow.get("type")) !== undefined ? { type: str(entityRow.get("type")) } : {}),
      ...(str(entityRow.get("description")) !== undefined ? { description: str(entityRow.get("description")) } : {}),
      outgoing: outgoingEntries,
      incoming: incomingEntries,
    };
  }

  /** Resolve + attach the wiki page paths for every distinct counterpart entity
   *  in a batch: `Entity -[:MENTIONED_IN]-> Chunk -> Document -[:IS_DOCUMENT]->
   *  WikiPage.path` (chunk ids are namespaced by `documentId`). Endpoints with
   *  no mention / no bridged page keep an empty `wikiPaths`. */
  private async attachWikiPaths(entries: EntityRelationEntry[]): Promise<void> {
    const byNameUpper = new Map<string, EntityRelationEntry>();
    for (const entry of entries) {
      if (entry.entity && !byNameUpper.has(entry.entity.toUpperCase())) {
        byNameUpper.set(entry.entity.toUpperCase(), entry);
      }
    }
    const names = Array.from(byNameUpper.keys());
    if (names.length === 0) return;

    const rows = await this.run(
      `MATCH (e:${ENTITY_LABEL}) WHERE e.nameUpper IN $names
       OPTIONAL MATCH (e)-[:${MENTIONED_IN_TYPE}]->(c:${CHUNK_LABEL})
       OPTIONAL MATCH (d:${DOCUMENT_LABEL} {id: c.documentId})-[:${IS_DOCUMENT_TYPE}]->(wp:${WIKIPAGE_LABEL})
       RETURN e.nameUpper AS nameUpper, collect(DISTINCT wp.path) AS wikiPaths`,
      { names },
    );
    const wikiByUpper = new Map<string, string[]>();
    for (const row of rows) {
      const upper = str(row.get("nameUpper"));
      if (!upper) continue;
      wikiByUpper.set(
        upper,
        strList(row.get("wikiPaths")).filter((p) => p.length > 0),
      );
    }
    for (const entry of entries) {
      const paths = wikiByUpper.get(entry.entity.toUpperCase());
      if (paths) entry.wikiPaths = paths;
    }
  }

  private async run(query: string, params: Record<string, unknown>): Promise<Array<{ get(key: string): unknown }>> {
    const session = this.driver.session() as {
      run(
        query: string,
        params?: Record<string, unknown>,
      ): Promise<{ records?: Array<{ get(key: string): unknown }> }>;
      close(): Promise<void>;
    };
    try {
      const result = await session.run(query, params);
      return Array.isArray(result?.records) ? (result.records as Array<{ get(key: string): unknown }>) : [];
    } finally {
      await session.close();
    }
  }
}
