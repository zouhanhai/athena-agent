import { test } from "node:test";
import assert from "node:assert/strict";
import neo4j from "neo4j-driver";
import { toNeo4jParams } from "../../src/kb/store/driver.js";

test("toNeo4jParams converts integer scalars to Neo4j Integer (LIMIT $topK needs int, not float)", () => {
  const params = toNeo4jParams({ topK: 5 });
  const topK = params.topK as neo4j.Integer;
  assert.ok(neo4j.isInt(topK), "integer param becomes a Neo4j Integer");
  assert.equal(topK.toNumber(), 5);
});

test("toNeo4jParams leaves float arrays (embeddings) and strings untouched", () => {
  const params = toNeo4jParams({
    embedding: [0.1, 0.2, 0.3],
    queryText: "zob münchen",
    topics: ["transport"],
    score: 0.85,
  });
  assert.deepEqual(params.embedding, [0.1, 0.2, 0.3]);
  assert.equal(params.queryText, "zob münchen");
  assert.deepEqual(params.topics, ["transport"]);
  assert.equal(params.score, 0.85);
});
