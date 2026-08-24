/**
 * G4.S10.T2 — one-off entity provenance/type migration (report + apply).
 *
 * Two jobs over the EXISTING graph, both idempotent:
 *   1. TYPE normalization — stored synonym types (organization/group/company→org,
 *      place/city→location, unknown→other; the SAME map the LINK engine folds
 *      with) are rewritten onto the closed enum. Out-of-enum values that are NOT
 *      synonyms (code-channel domain types: cds_view/table/abap_unit/…) are
 *      REPORTED but deliberately left untouched.
 *   2. SOURCE provenance backfill — pre-T2 entities have no source_docs/wiki_paths;
 *      their MENTIONED_IN chunks' documentIds (and the bridged WikiPage paths)
 *      rebuild the lists. Existing entries are unioned, never replaced.
 *
 * Dry-run first: `plan` is read-only and IS the report; `apply` executes the
 * plan. The CLI wrapper lives in scripts/migrate-entity-provenance.ts.
 */
import {
  ENTITY_TYPES,
  ENTITY_TYPE_SYNONYM_MAP,
} from "../link/link-engine.js";
import { ENTITY_LABEL, type Neo4jDriverLike } from "./schema.js";

export interface EntityTypeBreakdownEntry {
  type: string | null;
  count: number;
}

export interface EntityTypeChange {
  from: string;
  to: string;
  /** nameUpper keys of the entities that would be rewritten. */
  keys: string[];
}

export interface EntityProvenanceMigrationPlan {
  entitiesScanned: number;
  /** Distinct stored types with counts (the "before" picture). */
  typeBreakdown: EntityTypeBreakdownEntry[];
  /** Synonym-typed entities grouped by rewrite target. */
  typeChanges: EntityTypeChange[];
  /** Non-enum, non-synonym values found — reported only, never rewritten. */
  unrecognizedTypes: Array<{ type: string; count: number }>;
  /** Entities whose source_docs list is missing at least one mentioning documentId. */
  sourceDocsBackfill: Array<{ key: string; merged: string[] }>;
  /** Entities whose wiki_paths list is missing at least one bridged page path. */
  wikiPathsBackfill: Array<{ key: string; merged: string[] }>;
}

export interface EntityProvenanceMigrationReport extends EntityProvenanceMigrationPlan {
  applied: boolean;
  entitiesTypeNormalized: number;
  entitiesSourceDocsBackfilled: number;
  entitiesWikiPathsBackfilled: number;
}

/** One scan row per entity: stored state + everything its mentions imply. */
interface ScanRow {
  key: string;
  name: string;
  type: string | null;
  sourceDocs: string[] | null;
  wikiPaths: string[] | null;
  mentionedDocIds: Array<string | null>;
  mentionedWikiPaths: Array<string | null>;
}

const SCAN_CYPHER =
  `MATCH (e:${ENTITY_LABEL})
   OPTIONAL MATCH (e)-[:MENTIONED_IN]->(c:Chunk)
   OPTIONAL MATCH (d:Document {id: c.documentId})-[:IS_DOCUMENT]->(wp:WikiPage)
   RETURN e.nameUpper AS key, e.name AS name, e.type AS type,
          e.source_docs AS sourceDocs, e.wiki_paths AS wikiPaths,
          collect(DISTINCT c.documentId) AS mentionedDocIds,
          collect(DISTINCT coalesce(wp.id, wp.path)) AS mentionedWikiPaths
   ORDER BY key`;

/** Fold one stored type through the migration policy; null = leave untouched. */
function isOnEnum(value: string): boolean {
  return (ENTITY_TYPES as readonly string[]).includes(value);
}

function toStringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

function dedupeSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

async function readScanRows(driver: Neo4jDriverLike): Promise<ScanRow[]> {
  const session = driver.session();
  try {
    const result = (await session.run(SCAN_CYPHER)) as { records?: Array<{ get(key: string): unknown }> };
    const rows: ScanRow[] = [];
    for (const record of result?.records ?? []) {
      const get = (key: string): unknown => record.get?.(key);
      rows.push({
        key: String(get("key") ?? ""),
        name: String(get("name") ?? ""),
        type: get("type") === undefined || get("type") === null ? null : String(get("type")),
        sourceDocs: Array.isArray(get("sourceDocs")) ? toStringList(get("sourceDocs")) : null,
        wikiPaths: Array.isArray(get("wikiPaths")) ? toStringList(get("wikiPaths")) : null,
        mentionedDocIds: Array.isArray(get("mentionedDocIds")) ? (get("mentionedDocIds") as Array<string | null>) : [],
        mentionedWikiPaths: Array.isArray(get("mentionedWikiPaths"))
          ? (get("mentionedWikiPaths") as Array<string | null>)
          : [],
      });
    }
    return rows.filter((row) => row.key.length > 0);
  } finally {
    await session.close();
  }
}

/** Build the full migration plan from a live scan (read-only). */
export async function planEntityProvenanceMigration(driver: Neo4jDriverLike): Promise<EntityProvenanceMigrationPlan> {
  const rows = await readScanRows(driver);

  const breakdown = new Map<string, number>();
  const changesByKey = new Map<string, EntityTypeChange>();
  const unrecognized = new Map<string, number>();
  const sourceDocsBackfill: EntityProvenanceMigrationPlan["sourceDocsBackfill"] = [];
  const wikiPathsBackfill: EntityProvenanceMigrationPlan["wikiPathsBackfill"] = [];

  for (const row of rows) {
    const rawType = row.type?.trim().toLowerCase() ?? "";
    breakdown.set(row.type ?? "(none)", (breakdown.get(row.type ?? "(none)") ?? 0) + 1);

    if (rawType) {
      const target = ENTITY_TYPE_SYNONYM_MAP[rawType];
      if (target) {
        const changeKey = `${rawType}→${target}`;
        const existing = changesByKey.get(changeKey);
        if (existing) existing.keys.push(row.key);
        else changesByKey.set(changeKey, { from: rawType, to: target, keys: [row.key] });
      } else if (!isOnEnum(rawType)) {
        unrecognized.set(row.type!, (unrecognized.get(row.type!) ?? 0) + 1);
      }
    }

    const mentionDocIds = dedupeSorted(row.mentionedDocIds.filter((d): d is string => Boolean(d)));
    const existingDocs = dedupeSorted(row.sourceDocs ?? []);
    const mergedDocs = dedupeSorted([...existingDocs, ...mentionDocIds]);
    if (mergedDocs.length > existingDocs.length && mentionDocIds.length > 0) {
      sourceDocsBackfill.push({ key: row.key, merged: mergedDocs });
    }

    const mentionWikiPaths = dedupeSorted(row.mentionedWikiPaths.filter((p): p is string => Boolean(p)));
    const existingWikis = dedupeSorted(row.wikiPaths ?? []);
    const mergedWikis = dedupeSorted([...existingWikis, ...mentionWikiPaths]);
    if (mergedWikis.length > existingWikis.length && mentionWikiPaths.length > 0) {
      wikiPathsBackfill.push({ key: row.key, merged: mergedWikis });
    }
  }

  return {
    entitiesScanned: rows.length,
    typeBreakdown: [...breakdown.entries()].map(([type, count]) => ({ type, count })),
    typeChanges: [...changesByKey.values()],
    unrecognizedTypes: [...unrecognized.entries()].map(([type, count]) => ({ type, count })),
    sourceDocsBackfill,
    wikiPathsBackfill,
  };
}

/**
 * Execute the migration: normalize synonym types + backfill provenance lists.
 * Idempotent — re-running yields an empty delta.
 */
export async function applyEntityProvenanceMigration(
  driver: Neo4jDriverLike,
): Promise<EntityProvenanceMigrationReport> {
  const plan = await planEntityProvenanceMigration(driver);
  const session = driver.session();
  try {
    // 1. Type normalization: one UNWIND over every affected entity key.
    let entitiesTypeNormalized = 0;
    const typeUpdates = plan.typeChanges.flatMap((change) =>
      change.keys.map((key) => ({ key, to: change.to })),
    );
    if (typeUpdates.length > 0) {
      await session.run(
        `UNWIND $changes AS ch
         MATCH (e:${ENTITY_LABEL} {nameUpper: ch.key})
         SET e.type = ch.to`,
        { changes: typeUpdates },
      );
      entitiesTypeNormalized = typeUpdates.length;
    }

    // 2. Provenance backfill: write the FULL merged list per entity (union of
    //    what is stored + what the mentions imply) — idempotent by construction.
    const docKeys = new Set(plan.sourceDocsBackfill.map((entry) => entry.key));
    const wikiKeys = new Set(plan.wikiPathsBackfill.map((entry) => entry.key));
    const allKeys = new Set([...docKeys, ...wikiKeys]);

    // Re-read the current values for the affected keys so both properties land
    // consistent in ONE write per entity.
    const updates: Array<{ key: string; sourceDocs: string[]; wikiPaths: string[] }> = [];
    for (const key of allKeys) {
      const docEntry = plan.sourceDocsBackfill.find((entry) => entry.key === key);
      const wikiEntry = plan.wikiPathsBackfill.find((entry) => entry.key === key);
      const current = await readEntityLists(session, key);
      updates.push({
        key,
        sourceDocs: docEntry ? docEntry.merged : current.sourceDocs,
        wikiPaths: wikiEntry ? wikiEntry.merged : current.wikiPaths,
      });
    }
    if (updates.length > 0) {
      await session.run(
        `UNWIND $updates AS u
         MATCH (e:${ENTITY_LABEL} {nameUpper: u.key})
         SET e.source_docs = u.sourceDocs, e.wiki_paths = u.wikiPaths`,
        { updates },
      );
    }

    return {
      ...plan,
      applied: true,
      entitiesTypeNormalized,
      entitiesSourceDocsBackfilled: docKeys.size,
      entitiesWikiPathsBackfilled: wikiKeys.size,
    };
  } finally {
    await session.close();
  }
}

async function readEntityLists(
  session: ReturnType<Neo4jDriverLike["session"]>,
  key: string,
): Promise<{ sourceDocs: string[]; wikiPaths: string[] }> {
  const result = (await session.run(
    `MATCH (e:${ENTITY_LABEL} {nameUpper: $key})
     RETURN e.source_docs AS sourceDocs, e.wiki_paths AS wikiPaths`,
    { key },
  )) as { records?: Array<{ get(key: string): unknown }> };
  const record = result?.records?.[0];
  if (!record) return { sourceDocs: [], wikiPaths: [] };
  return {
    sourceDocs: toStringList(record.get?.("sourceDocs")),
    wikiPaths: toStringList(record.get?.("wikiPaths")),
  };
}
