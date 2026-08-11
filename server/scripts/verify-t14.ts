import neo4j from "neo4j-driver";
import { Neo4jIngestService } from "../src/kb/store/ingest.js";
import { Neo4jRetrievalService } from "../src/kb/store/retrieval.js";
import { createNeo4jDriver, neo4jConfigFromEnv } from "../src/kb/store/driver.js";
import { MENTIONED_IN_TYPE } from "../src/kb/store/schema.js";

// Run: NEO4J_PASSWORD=<pw> npx tsx scripts/verify-t14.ts
const config = neo4jConfigFromEnv();
if (!config) {
  console.error("NEO4J_PASSWORD unset — set NEO4J_URI/NEO4J_USER/NEO4J_PASSWORD for the spike store");
  process.exit(1);
}
const documentId = `t14-verify-${Date.now()}`;
const rawDriver = createNeo4jDriver(config);
const driver = neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password));

const DIM = 4096;
// Distinct embeddings so the vector retriever deterministically returns ONLY the two
// unrelated chunks (c3 top, c4 runner-up) for the query — the entity chunk c1 is NOT in
// the vector top-2, so it can only surface through the graph → MENTIONED_IN → RRF path.
const mk = (coeffs: number[]) => {
  const v = Array(DIM).fill(0);
  coeffs.forEach((c, i) => (v[i] = c));
  return v;
};
const E_QUERY = mk([1]); // query "Zentraler Omnibusbahnhof" → matches c3 (sim 1)
const E_C3 = mk([1]); // unrelated c3 — identical to query, sim 1
const E_C4 = mk([0.9, 0.1]); // runner-up unrelated c4 — sim 0.9
const E_C1 = mk([0, 1]); // entity chunk c1 — sim 0 to the query
const E_C2 = mk([0, 0, 1]); // entity chunk c2 — sim 0
const embedder = {
  embed: async (texts: string[]) =>
    texts.map((t) =>
      t.toLowerCase().includes("winter")
        ? t.toLowerCase().includes("lüsen nord")
          ? E_C4
          : E_C3
        : t.toLowerCase().includes("zob")
          ? E_C1
          : t.toLowerCase().includes("mvv")
            ? E_C2
            : E_C3,
    ),
};

try {
  // Clean up any leftover t14-verify test data so vector/BM25 results are deterministic.
  const s0 = driver.session();
  await s0.run(`MATCH (c:Chunk) WHERE c.documentId STARTS WITH 't14-verify-' DETACH DELETE c`);
  await s0.run(`MATCH (s:Section) WHERE s.documentId STARTS WITH 't14-verify-' DETACH DELETE s`);
  await s0.run(`MATCH (d:Document) WHERE d.id STARTS WITH 't14-verify-' DETACH DELETE d`);
  await s0.close();

  const ingest = new Neo4jIngestService({
    driver: rawDriver,
    embedder,
    readChunks: async () => [
      { id: "c1", text: "Der ZOB München liegt zentral neben dem Hauptbahnhof.", heading_path: "# Hub" },
      { id: "c2", text: "Die MVV bedient die Linien am Busbahnhof.", heading_path: "# Tram" },
      { id: "c3", text: "Unrelated winter content in Lüsen.", heading_path: "# Winter" },
      { id: "c4", text: "Unrelated winter content in Lüsen Nord.", heading_path: "# Winter" },
    ],
  });
  const res = await ingest.ingest({
    documentId,
    title: "T14 real-doc verification",
    ref: {
      md_ref: "/tmp/t14.md",
      chunks_ref: "/tmp/t14-chunks.json",
      preview: "preview",
      char_count: 100,
      line_count: 5,
      header_count: 1,
      chunk_count: 4,
      frontmatter: { type: "report", topic: "transport/bus" },
      entities: [
        { name: "ZOB München", type: "place", description: "central bus station", aliases: ["Zentraler Omnibusbahnhof"] },
        { name: "MVV", type: "org", description: "Munich transit", aliases: ["Münchner Verkehrsgesellschaft"] },
      ],
      relations: [{ source: "ZOB München", target: "MVV", keywords: ["bedient"], description: "MVV serves the ZOB" }],
      keywords: ["bus", "transit"],
      quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
      summary: "Bus hub verification doc.",
      mode: "single",
      section_paths: [],
    },
  });
  console.log("ingest:", JSON.stringify(res));

  const s = driver.session();
  const mention = await s.run(
    `MATCH (e:Entity {name: "ZOB München"})-[:${MENTIONED_IN_TYPE}]->(c:Chunk) WHERE c.documentId = $doc
     RETURN e.name AS entity, c.id AS chunkId ORDER BY c.id`,
    { doc: documentId },
  );
  const rows = mention.records.map((r) => ({ entity: String(r.get("entity")), chunkId: String(r.get("chunkId")) }));
  console.log("MENTIONED_IN edges for ZOB München:", JSON.stringify(rows));
  if (!rows.some((r) => r.chunkId === `${documentId}:c1`)) {
    throw new Error("FAIL: MENTIONED_IN edge missing (chunk c1 mentions alias 'Zentraler Omnibusbahnhof')");
  }

  const retrieval = new Neo4jRetrievalService({ driver: rawDriver, embedder, topK: 3 });
  const response = await retrieval.search("Zentraler Omnibusbahnhof");
  console.log(`\nsearch top ${response.hits.length}:`);
  for (const h of response.hits) {
    console.log(`  [${h.source}] ${h.id} score=${h.score.toFixed(3)} related=${JSON.stringify(h.related ?? [])}`);
  }
  const graphOnly = response.hits.find((h) => h.id === `${documentId}:c1` && h.source === "graph");
  if (!graphOnly) {
    throw new Error("FAIL: entity chunk c1 did not fuse via the graph (vector top-2 does not include it)");
  }
  console.log("\nVERIFY OK: MENTIONED_IN edges created + graph-only chunk RRF-fused into results.");
  await s.close();
} catch (err) {
  console.error("VERIFY FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await driver.close();
}
