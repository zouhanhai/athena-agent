/**
 * G4.S10.T4 — KNOWN ENTITIES baseline for the wiki-edit delta-refine.
 *
 * Before an edit's diff-refine runs, the pipeline reads the document's CURRENT
 * entities from the graph (WikiPage → IS_DOCUMENT → Document; entities bound to
 * it via provenance OR a MENTIONED_IN edge into one of its chunks) and injects
 * them into the refine prompt as the BASELINE. The LLM then emits only a delta
 * over that baseline instead of re-extracting the document from scratch — the
 * root-cause fix for the GALILEO Office orphaning incident.
 *
 * Kept deliberately cheap: ONE round-trip per edit (the WikiPage→Document
 * resolve and the entity fetch collapse into a single query), hard-capped.
 */
import { ENTITY_LABEL, type Neo4jDriverLike } from "./schema.js";

/** Hard cap on baseline entities injected into the wiki-edit prompt. */
export const WIKI_KNOWN_ENTITIES_CAP = 100;

/** One baseline entity as injected into the wiki-edit refine prompt. */
export interface KnownEntity {
  name: string;
  type: string;
  description?: string;
  /** Documents currently recording this entity (provenance list on the node). */
  source_docs?: string[];
  aliases?: string[];
}

interface RowReader {
  get(key: string): unknown;
}

/**
 * Read the entities currently stored for a wiki page's document. Returns []
 * when the page has no ingested Document yet (first ingest happens later) or
 * the graph is unavailable — the refine then simply runs with no baseline.
 */
export async function readWikiKnownEntities(
  driver: Neo4jDriverLike,
  wikiPath: string,
  cap: number = WIKI_KNOWN_ENTITIES_CAP,
): Promise<KnownEntity[]> {
  if (!wikiPath.trim()) return [];
  const session = driver.session();
  try {
    const result = (await session.run(
      `MATCH (wp:WikiPage {id: $wikiPath})<-[:IS_DOCUMENT]-(d:Document)
       MATCH (e:${ENTITY_LABEL})
       WHERE (e.source_docs IS NOT NULL AND d.id IN e.source_docs)
          OR EXISTS { MATCH (e)-[:MENTIONED_IN]->(:Chunk {documentId: d.id}) }
       RETURN e.name AS name, e.type AS type, e.description AS description,
              e.source_docs AS source_docs, e.aliases AS aliases
       ORDER BY size(coalesce(e.source_docs, [])) DESC, e.name
       LIMIT $cap`,
      { wikiPath, cap },
    )) as { records?: RowReader[] };
    return (result?.records ?? [])
      .map((row) => {
        const name = strOf(row, "name") ?? "";
        const known: KnownEntity = {
          name,
          type: strOf(row, "type") ?? "other",
        };
        const description = strOf(row, "description");
        if (description) known.description = description;
        const sourceDocs = strList(row, "source_docs");
        if (sourceDocs) known.source_docs = sourceDocs;
        const aliases = strList(row, "aliases");
        if (aliases && aliases.length > 0) known.aliases = aliases;
        return known;
      })
      .filter((known) => known.name.length > 0);
  } catch {
    // Baseline reads must never break an edit — degrade to "no baseline".
    return [];
  } finally {
    await session.close();
  }
}

function strOf(row: RowReader, key: string): string | undefined {
  const value = row.get(key);
  return value === null || value === undefined ? undefined : String(value);
}

function strList(row: RowReader, key: string): string[] | undefined {
  const value = row.get(key);
  return Array.isArray(value) ? value.map((item) => String(item)) : undefined;
}
