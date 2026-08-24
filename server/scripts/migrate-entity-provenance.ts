/**
 * G4.S10.T2 — one-off entity provenance/type migration runner.
 *
 * DRY RUN (default — report only, writes nothing):
 *   NEO4J_PASSWORD=<pw> npx tsx scripts/migrate-entity-provenance.ts
 *
 * APPLY (normalizes stored synonym types + backfills source_docs/wiki_paths
 * from MENTIONED_IN chunks' documentIds and the bridged WikiPage paths):
 *   NEO4J_PASSWORD=<pw> npx tsx scripts/migrate-entity-provenance.ts --apply
 *
 * Idempotent: re-running after an apply reports an empty delta.
 */
import neo4j from "neo4j-driver";
import { neo4jConfigFromEnv } from "../src/kb/store/driver.js";
import {
  applyEntityProvenanceMigration,
  planEntityProvenanceMigration,
} from "../src/kb/store/provenance-migration.js";

const config = neo4jConfigFromEnv();
if (!config) {
  console.error("NEO4J_PASSWORD unset — set NEO4J_URI/NEO4J_USER/NEO4J_PASSWORD for the store");
  process.exit(1);
}
const apply = process.argv.includes("--apply");

// One RAW driver for everything — closing it lets the process exit (the
// createNeo4jDriver wrapper hides an unclosable pool, fine for long-running
// services, wrong for a one-shot CLI).
const driver = neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password));
try {
  const report = apply
    ? await applyEntityProvenanceMigration(driver)
    : { ...(await planEntityProvenanceMigration(driver)), applied: false };

  console.log(`# Entity provenance/type migration — ${apply ? "APPLY" : "DRY RUN (report only)"}`);
  console.log(JSON.stringify(report, null, 2));

  const delta =
    report.typeChanges.reduce((n, change) => n + change.keys.length, 0) +
    report.sourceDocsBackfill.length +
    report.wikiPathsBackfill.length;
  if (!apply && delta > 0) {
    console.log(`\n${delta} entity update(s) pending — re-run with --apply to write them.`);
  }
} finally {
  await driver.close();
}
