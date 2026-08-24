/**
 * G4.S10.T2 — one-off entity provenance/type migration (report + apply).
 *
 * Fixture-driven: the scan reads every entity's stored type + provenance and
 * the MENTIONED_IN chunks' documentIds / bridged WikiPage paths; the report
 * plans synonym-type rewrites and provenance backfills; apply writes them.
 * Out-of-enum NON-synonym types (code channel: cds_view/table/abap_unit) are
 * reported but deliberately LEFT UNTOUCHED.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { Neo4jDriverLike } from "../../src/kb/store/schema.js";
import {
  applyEntityProvenanceMigration,
  planEntityProvenanceMigration,
} from "../../src/kb/store/provenance-migration.js";

interface Row {
  key: string;
  name: string;
  type: string | null;
  sourceDocs: string[] | null;
  wikiPaths: string[] | null;
  mentionedDocIds: string[];
  mentionedWikiPaths: string[];
}

function makeMigrationDriver(rows: Row[]) {
  const writes: Array<{ query: string; params: Record<string, unknown> }> = [];
  const driver: Neo4jDriverLike = {
    session() {
      return {
        run: async (query: string, params: Record<string, unknown> = {}) => {
          if (query.includes("collect(DISTINCT c.documentId)")) {
            return {
              records: rows.map((row) => ({
                get: (key: string) => {
                  switch (key) {
                    case "key":
                      return row.key;
                    case "name":
                      return row.name;
                    case "type":
                      return row.type;
                    case "sourceDocs":
                      return row.sourceDocs;
                    case "wikiPaths":
                      return row.wikiPaths;
                    case "mentionedDocIds":
                      return row.mentionedDocIds;
                    case "mentionedWikiPaths":
                      return row.mentionedWikiPaths;
                    default:
                      return null;
                  }
                },
              })),
            };
          }
          if (query.includes("UNWIND")) {
            writes.push({ query, params });
          }
          return { records: [] };
        },
        close: async () => {},
      };
    },
  };
  return { driver, writes };
}

function fixtureRows(): Row[] {
  return [
    // Synonym type + missing doc-b/wiki path in provenance.
    {
      key: "CALEO",
      name: "CALEO",
      type: "organization",
      sourceDocs: ["doc-a"],
      wikiPaths: null,
      mentionedDocIds: ["doc-a", "doc-b"],
      mentionedWikiPaths: ["wiki/b/b.md"],
    },
    // Synonym type, NO provenance at all, mention-only history.
    {
      key: "ZOB MÜNCHEN",
      name: "ZOB München",
      type: "place",
      sourceDocs: null,
      wikiPaths: null,
      mentionedDocIds: ["doc-c"],
      mentionedWikiPaths: [],
    },
    // Code-channel domain type: reported as unrecognized, NEVER rewritten.
    {
      key: "FICOMPUTE",
      name: "FICOMPUTE",
      type: "abap_unit",
      sourceDocs: [],
      wikiPaths: [],
      mentionedDocIds: [],
      mentionedWikiPaths: [],
    },
    // Already canonical + fully backfilled → untouched.
    {
      key: "SOMMERSEMINAR",
      name: "Sommerseminar",
      type: "event",
      sourceDocs: ["doc-a"],
      wikiPaths: ["wiki/a.md"],
      mentionedDocIds: ["doc-a"],
      mentionedWikiPaths: ["wiki/a.md"],
    },
  ];
}

test("migration PLAN reports synonym type rewrites, unrecognized types and provenance gaps without writing", async () => {
  const { driver, writes } = makeMigrationDriver(fixtureRows());

  const plan = await planEntityProvenanceMigration(driver);

  assert.equal(plan.entitiesScanned, 4);
  assert.deepEqual(plan.typeBreakdown, [
    { type: "organization", count: 1 },
    { type: "place", count: 1 },
    { type: "abap_unit", count: 1 },
    { type: "event", count: 1 },
  ]);
  assert.deepEqual(plan.typeChanges.sort((a, b) => a.from.localeCompare(b.from)), [
    { from: "organization", to: "org", keys: ["CALEO"] },
    { from: "place", to: "location", keys: ["ZOB MÜNCHEN"] },
  ]);
  assert.deepEqual(plan.unrecognizedTypes, [{ type: "abap_unit", count: 1 }]);
  const byKey = new Map(plan.sourceDocsBackfill.map((entry) => [entry.key, entry.merged]));
  assert.deepEqual(byKey.get("CALEO"), ["doc-a", "doc-b"]);
  assert.deepEqual(byKey.get("ZOB MÜNCHEN"), ["doc-c"]);
  assert.equal(plan.sourceDocsBackfill.length, 2, "FICOMPUTE/SOMMERSEMINAR need no backfill");
  assert.deepEqual(
    plan.wikiPathsBackfill.map((entry) => entry.key),
    ["CALEO"],
  );
  assert.equal(writes.length, 0, "planning is read-only");
});

test("migration APPLY normalizes types and backfills source_docs/wiki_paths", async () => {
  const { driver, writes } = makeMigrationDriver(fixtureRows());

  const report = await applyEntityProvenanceMigration(driver);

  assert.equal(report.applied, true);
  assert.equal(report.entitiesTypeNormalized, 2);
  assert.equal(report.entitiesSourceDocsBackfilled, 2);
  assert.equal(report.entitiesWikiPathsBackfilled, 1);

  const typeWrite = writes.find((w) => w.params.changes !== undefined);
  assert.ok(typeWrite, "type normalization write issued");
  const changes = typeWrite!.params.changes as Array<{ key: string; to: string }>;
  assert.deepEqual(changes.sort((a, b) => a.key.localeCompare(b.key)), [
    { key: "CALEO", to: "org" },
    { key: "ZOB MÜNCHEN", to: "location" },
  ]);

  const provenanceWrite = writes.find((w) => w.params.updates !== undefined);
  assert.ok(provenanceWrite, "provenance backfill write issued");
  const updates = provenanceWrite!.params.updates as Array<{
    key: string;
    sourceDocs: string[];
    wikiPaths: string[];
  }>;
  const updateByKey = new Map(updates.map((u) => [u.key, u]));
  assert.deepEqual(updateByKey.get("CALEO")?.sourceDocs, ["doc-a", "doc-b"]);
  assert.deepEqual(updateByKey.get("CALEO")?.wikiPaths, ["wiki/b/b.md"]);
  assert.deepEqual(updateByKey.get("ZOB MÜNCHEN")?.sourceDocs, ["doc-c"]);
});
