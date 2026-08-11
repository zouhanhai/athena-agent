import { test } from "node:test";
import assert from "node:assert/strict";
import type { RefineOutputRef } from "../../src/agents/refine-output.js";
import {
  CHUNK_LABEL,
  DOCUMENT_LABEL,
  ENTITY_LABEL,
  ENTITY_RELATION_TYPE,
  WIKIPAGE_LABEL,
  type Neo4jDriverLike,
} from "../../src/kb/store/schema.js";
import { Neo4jIngestService, parseHeadingPath } from "../../src/kb/store/ingest.js";

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

  const chunkQueries = calls.filter(
    (c) => c.query.startsWith("MERGE") && c.query.includes(`${CHUNK_LABEL}`) && !c.query.includes("UNWIND $sections"),
  );
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

  const docQuery = calls.find(
    (c) =>
      c.query.startsWith("MERGE") &&
      c.query.includes(`:${DOCUMENT_LABEL}`) &&
      !c.query.includes("UNWIND $sections"),
  );
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

  const chunkQueries = calls.filter(
    (c) => c.query.startsWith("MERGE") && c.query.includes(`${CHUNK_LABEL}`) && !c.query.includes("UNWIND $sections"),
  );
  const entityQueries = calls.filter((c) => c.query.startsWith("MERGE") && c.query.includes(`:${ENTITY_LABEL}`));
  const docQueries = calls.filter(
    (c) =>
      c.query.startsWith("MERGE") &&
      c.query.includes(`:${DOCUMENT_LABEL}`) &&
      !c.query.includes("UNWIND $sections"),
  );
  for (const q of [...chunkQueries, ...entityQueries, ...docQueries]) {
    assert.match(q.query, /MERGE/, `MERGE used: ${q.query}`);
  }
  assert.equal(docQueries.length, 1);
});

test("parseHeadingPath splits a heading_path on '/' and strips markdown markers", () => {
  assert.deepEqual(parseHeadingPath("Alpha / Beta / Gamma"), ["Alpha", "Beta", "Gamma"]);
  assert.deepEqual(parseHeadingPath("  Sommerseminar  /  Workshops  "), ["Sommerseminar", "Workshops"]);
  assert.deepEqual(parseHeadingPath("# Alpha"), ["Alpha"]);
  assert.deepEqual(parseHeadingPath(""), []);
});

test("ingest creates the WikiPage node and bridges Document → WikiPage (IS_DOCUMENT)", async () => {
  const { driver, calls } = makeDriver();
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [1, 2, 3]) },
    readChunks: async () => [{ id: "c1", text: "x", heading_path: "# Alpha" }],
  });

  await service.ingest({
    ref: makeRef(),
    documentId: "doc",
    title: "Sommerseminar",
    wikiPath: "wiki/events/doc.md",
  });

  const wpQuery = calls.find((c) => c.query.includes(`:${WIKIPAGE_LABEL}`) && c.query.includes("MERGE"));
  assert.ok(wpQuery, "WikiPage MERGE issued");
  const params = wpQuery!.params!;
  assert.equal(params.wikiPath, "wiki/events/doc.md", "WikiPage id = the wiki page path");
  assert.equal(params.documentId, "doc");
  assert.equal(params.title, "Sommerseminar");
  assert.ok(wpQuery!.query.includes("IS_DOCUMENT"), "Document -[:IS_DOCUMENT]-> WikiPage bridge");
});

test("ingest skips WikiPage when no wikiPath is known (legacy direct ingest)", async () => {
  const { driver, calls } = makeDriver();
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [1, 2, 3]) },
    readChunks: async () => [{ id: "c1", text: "x", heading_path: "# X" }],
  });

  await service.ingest({ ref: makeRef(), documentId: "doc", title: "Doc" });

  const wpQueries = calls.filter((c) => c.query.includes(`:${WIKIPAGE_LABEL}`) && c.query.includes("MERGE"));
  assert.equal(wpQueries.length, 0, "no WikiPage nodes without a wiki path");
});

test("ingest parses heading_path into a Section chain and links Chunk → deepest Section", async () => {
  const { driver, calls } = makeDriver();
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [1, 2, 3]) },
    readChunks: async () => [{ id: "c1", text: "x", heading_path: "Alpha / Beta / Gamma" }],
  });

  await service.ingest({ ref: makeRef(), documentId: "doc", title: "Doc", wikiPath: "wiki/events/doc.md" });

  const chainQuery = calls.find((c) => c.query.includes("UNWIND $sections"));
  assert.ok(chainQuery, "section chain query issued");
  assert.deepEqual(chainQuery!.params!.sections, [
    { id: "doc:Alpha", title: "Alpha", path: "Alpha", documentId: "doc" },
    { id: "doc:Alpha / Beta", title: "Beta", path: "Alpha / Beta", documentId: "doc" },
    { id: "doc:Alpha / Beta / Gamma", title: "Gamma", path: "Alpha / Beta / Gamma", documentId: "doc" },
  ]);
  assert.equal(chainQuery!.params!.chunkId, "doc:c1", "Chunk linked to the deepest Section");
  const q = chainQuery!.query;
  assert.match(q, /HAS_SECTION/, "Document -[:HAS_SECTION]-> first Section");
  assert.match(q, /HAS_SUBSECTION/, "Section -[:HAS_SUBSECTION]-> child Section");
  assert.match(q, /PART_OF/, "Chunk -[:PART_OF]-> deepest Section");
  assert.match(q, /MERGE/, "idempotent (MERGE) section chain");
});

test("ingest links a single-segment heading_path (# heading) to one Section", async () => {
  const { driver, calls } = makeDriver();
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [1, 2, 3]) },
    readChunks: async () => [{ id: "c1", text: "x", heading_path: "# Alpha" }],
  });

  await service.ingest({ ref: makeRef(), documentId: "doc", title: "Doc", wikiPath: "wiki/events/doc.md" });

  const chainQuery = calls.find((c) => c.query.includes("UNWIND $sections"));
  assert.ok(chainQuery, "section chain query issued");
  assert.deepEqual(chainQuery!.params!.sections, [
    { id: "doc:Alpha", title: "Alpha", path: "Alpha", documentId: "doc" },
  ]);
  assert.equal(chainQuery!.params!.chunkId, "doc:c1");
});
