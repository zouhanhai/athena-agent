import { test } from "node:test";
import assert from "node:assert/strict";
import { neo4jIngestSkipReason } from "../src/kb/tasks.js";

/**
 * G4.S8.T19 pipeline review — server restart losing NEO4J_* env.
 *
 * The production incident: the server was started OUTSIDE scripts/start-all.sh
 * (which exports NEO4J_URI/USER/PASSWORD), so `neo4jConfigFromEnv` returned
 * undefined, every ingest marked the Neo4j stage done as a silent NO-OP
 * ("neo4j ingest: ok"), and the graph stayed empty for days. The server must
 * tolerate the missing env gracefully BUT shed light on it.
 */

test("no skip reason when the store is wired AND refinement output exists", () => {
  assert.equal(neo4jIngestSkipReason(true, true), undefined);
});

test("missing store (NEO4J_PASSWORD unset) yields an actionable skip reason", () => {
  const reason = neo4jIngestSkipReason(false, true)!;
  assert.match(reason, /NEO4J/);
  assert.match(reason, /not wired|unset/i);
  assert.match(reason, /start-all\.sh|NEO4J_/i);
});

test("wired store but no refinement output yields a different reason", () => {
  const reason = neo4jIngestSkipReason(true, false)!;
  assert.match(reason, /refinement/i);
  assert.doesNotMatch(reason, /NEO4J_PASSWORD/);
});
