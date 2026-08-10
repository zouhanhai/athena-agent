import { test } from "node:test";
import assert from "node:assert/strict";
import type { RefineOutputRef } from "../../src/agents/refine-output.js";
import {
  CHUNK_LABEL,
  DOCUMENT_LABEL,
  ENTITY_LABEL,
  ENTITY_RELATION_TYPE,
  type Neo4jDriverLike,
} from "../../src/kb/store/schema.js";
import { Neo4jIngestService } from "../../src/kb/store/ingest.js";

interface RecordedCall {
  query: string;
  params?: Record<string, unknown>;
}

function makeDriver(): { driver: Neo4jDriverLike; calls: RecordedCall[]; closed: boolean } {
  const calls: RecordedCall[] = [];
  const state = { closed: false };
  const driver: Neo4jDriverLike = {
    session() {
      return {
        run: async (query: string, params?: Record<string, unknown>) => {
          calls.push({ query, params });
          return { records: [] };
        },
        close: async () => {
          state.closed = true;
        },
      };
    },
  };
  return { driver, calls, closed: state.closed };
}

function makeRef(overrides: Partial<RefineOutputRef> = {}): RefineOutputRef {
  return {
    md_ref: "/storage/doc/markdown.md",
    chunks_ref: "/storage/doc/chunks.json",
    preview: "preview",
    char_count: 100,
    line_count: 10,
    header_count: 2,
    chunk_count: 2,
    frontmatter: { type: "report", topic: "sap/consolidation/bcs" },
    entities: [
      { name: "CALEO", type: "org", description: "the company", aliases: ["Caleo GmbH"] },
      { name: "ZOB München", type: "place", description: "central bus station", aliases: ["Zentraler Omnibusbahnhof"] },
    ],
    relations: [
      { source: "CALEO", target: "ZOB München", keywords: ["organisiert"], description: "CALEO runs the ZOB" },
    ],
    keywords: ["bcs", "consolidation"],
    quality: { complete: true, confidence: 0.95, issues: [], action: "auto_accept" },
    mode: "single",
    sections: [],
    ...overrides,
  };
}

test("ingest applies the store schema before storing refinement output", async () => {
  const { driver, calls } = makeDriver();
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map((_, i) => [i, i + 1]) },
    readChunks: async () => [{ id: "c1", text: "first chunk", heading_path: "# A" }],
  });

  await service.ingest({ ref: makeRef(), documentId: "doc", title: "Doc" });

  const joined = calls.map((c) => c.query).join("\n");
  assert.ok(joined.includes("CREATE CONSTRAINT"), "schema DDL applied before ingest");
  assert.ok(joined.includes("CREATE VECTOR INDEX"), "vector index DDL applied");
});

test("ingest stores Chunk nodes with embedding, text, topic and heading_path", async () => {
  const { driver, calls } = makeDriver();
  const chunks = [
    { id: "c1", text: "alpha chunk", heading_path: "# Alpha" },
    { id: "c2", text: "beta chunk", heading_path: "# Beta" },
  ];
  const service = new Neo4jIngestService({
    driver,
    embedder: {
      embed: async (texts) => texts.map((_, i) => [0.1 * i, 0.2 * i, 0.3 * i]),
    },
    readChunks: async () => chunks,
  });

  await service.ingest({ ref: makeRef(), documentId: "doc", title: "Doc" });

  const chunkQueries = calls.filter((c) => c.query.startsWith("MERGE") && c.query.includes(`${CHUNK_LABEL}`));
  assert.equal(chunkQueries.length, 2, "one MERGE per chunk");
  const first = chunkQueries[0]!.params!;
  assert.equal(first.id, "doc:c1", "chunk id namespaced by document id");
  assert.equal(first.text, "alpha chunk");
  assert.deepEqual(first.embedding, [0.1 * 0, 0.2 * 0, 0.3 * 0]);
  assert.equal(first.topic, "sap/consolidation/bcs");
  assert.equal(first.heading_path, "# Alpha");
  const second = chunkQueries[1]!.params!;
  assert.equal(second.id, "doc:c2");
  assert.deepEqual(second.embedding, [0.1 * 1, 0.2 * 1, 0.3 * 1]);
});

test("ingest stores Entity nodes with aliases and folded nameUpper", async () => {
  const { driver, calls } = makeDriver();
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [1, 2, 3]) },
    readChunks: async () => [{ id: "c1", text: "x", heading_path: "# X" }],
  });

  await service.ingest({ ref: makeRef(), documentId: "doc", title: "Doc" });

  const entityQueries = calls.filter((c) => c.query.startsWith("MERGE") && c.query.includes(`:${ENTITY_LABEL}`));
  assert.equal(entityQueries.length, 2, "one MERGE per entity");
  const first = entityQueries.find((c) => c.params!.name === "CALEO")!.params!;
  assert.deepEqual(first.aliases, ["Caleo GmbH"]);
  assert.equal(first.nameUpper, "CALEO");
  const second = entityQueries.find((c) => c.params!.name === "ZOB München")!.params!;
  assert.equal(second.nameUpper, "ZOB MÜNCHEN");
  assert.deepEqual(second.aliases, ["Zentraler Omnibusbahnhof"]);
});

test("ingest creates RELATION edges between entities (case-insensitive by nameUpper)", async () => {
  const { driver, calls } = makeDriver();
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [1, 2, 3]) },
    readChunks: async () => [{ id: "c1", text: "x", heading_path: "# X" }],
  });

  await service.ingest({ ref: makeRef(), documentId: "doc", title: "Doc" });

  const relationQuery = calls.find((c) => c.query.includes(`MERGE (a)-[r:${ENTITY_RELATION_TYPE}]`));
  assert.ok(relationQuery, "relation MERGE issued");
  const params = relationQuery!.params!;
  assert.equal(params.sourceUpper, "CALEO");
  assert.equal(params.targetUpper, "ZOB MÜNCHEN");
  assert.deepEqual(params.keywords, ["organisiert"]);
});

test("ingest stores the Document node with topic, type, md_ref, title and keywords", async () => {
  const { driver, calls } = makeDriver();
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [1, 2, 3]) },
    readChunks: async () => [{ id: "c1", text: "x", heading_path: "# X" }],
  });

  await service.ingest({ ref: makeRef(), documentId: "doc", title: "Sommerseminar" });

  const docQuery = calls.find((c) => c.query.startsWith("MERGE") && c.query.includes(`:${DOCUMENT_LABEL}`));
  assert.ok(docQuery, "Document MERGE issued");
  assert.deepEqual(docQuery!.params, {
    id: "doc",
    topic: "sap/consolidation/bcs",
    type: "report",
    mdRef: "/storage/doc/markdown.md",
    title: "Sommerseminar",
    keywords: ["bcs", "consolidation"],
  });
});

test("ingest is idempotent-safe: MERGE (not CREATE) for chunks, entities and document", async () => {
  const { driver, calls } = makeDriver();
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [1, 2, 3]) },
    readChunks: async () => [{ id: "c1", text: "x", heading_path: "# X" }],
  });

  await service.ingest({ ref: makeRef(), documentId: "doc", title: "Doc" });

  const chunkQueries = calls.filter((c) => c.query.startsWith("MERGE") && c.query.includes(`${CHUNK_LABEL}`));
  const entityQueries = calls.filter((c) => c.query.startsWith("MERGE") && c.query.includes(`:${ENTITY_LABEL}`));
  const docQueries = calls.filter((c) => c.query.startsWith("MERGE") && c.query.includes(`:${DOCUMENT_LABEL}`));
  for (const q of [...chunkQueries, ...entityQueries, ...docQueries]) {
    assert.match(q.query, /MERGE/, `MERGE used: ${q.query}`);
  }
  assert.equal(docQueries.length, 1);
});
