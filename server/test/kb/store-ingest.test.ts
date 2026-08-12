import { test } from "node:test";
import assert from "node:assert/strict";
import type { RefineOutputRef } from "../../src/agents/refine-output.js";
import {
  CHUNK_LABEL,
  DOCUMENT_LABEL,
  ENTITY_LABEL,
  ENTITY_RELATION_TYPE,
  SECTION_LABEL,
  WIKIPAGE_LABEL,
  type Neo4jDriverLike,
} from "../../src/kb/store/schema.js";
import {
  Neo4jIngestService,
  parseHeadingPath,
  mentionPairs,
} from "../../src/kb/store/ingest.js";
import { MENTIONED_IN_TYPE } from "../../src/kb/store/schema.js";

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
    summary: "A BCS consolidation report covering the CALEO group.",
    sections: [{ title: "Intro", summary: "About the BCS report." }],
    mode: "single",
    section_paths: [],
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

test("ingest stores the Document node with topic, type, md_ref, title, keywords and summary", async () => {
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
    summary: "A BCS consolidation report covering the CALEO group.",
  });
});

test("ingest initializes the Document lifecycle fields with COALESCE defaults (G4.S3.T1)", async () => {
  const { driver, calls } = makeDriver();
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [1, 2, 3]) },
    readChunks: async () => [{ id: "c1", text: "x", heading_path: "# X" }],
  });

  await service.ingest({ ref: makeRef(), documentId: "doc", title: "Doc" });

  const docQuery = calls.find(
    (c) =>
      c.query.startsWith("MERGE") &&
      c.query.includes(`:${DOCUMENT_LABEL}`) &&
      !c.query.includes("UNWIND $sections"),
  );
  assert.ok(docQuery, "Document MERGE issued");
  const q = docQuery!.query;
  assert.match(q, /d\.read_count = COALESCE\(d\.read_count, 0\)/, "read_count defaults to 0 without reset");
  assert.match(q, /d\.confidence = COALESCE\(d\.confidence, 1\.0\)/, "confidence defaults to 1.0 without reset");
});

test("ingest stores each section summary on the matching Section node (matched by title)", async () => {
  const { driver, calls } = makeDriver();
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [1, 2, 3]) },
    readChunks: async () => [{ id: "c1", text: "x", heading_path: "Alpha / Beta" }],
  });

  await service.ingest({
    ref: makeRef({ sections: [{ title: "Alpha", summary: "About Alpha." }, { title: "Missing", summary: "No node." }] }),
    documentId: "doc",
    title: "Doc",
    wikiPath: "wiki/events/doc.md",
  });

  const summaryQuery = calls.find(
    (c) => c.query.includes("UNWIND $sectionSummaries") && c.query.includes(`:${SECTION_LABEL}`),
  );
  assert.ok(summaryQuery, "section-summary update query issued");
  assert.equal(summaryQuery!.params!.documentId, "doc");
  assert.deepEqual(summaryQuery!.params!.sectionSummaries, [
    { title: "Alpha", summary: "About Alpha." },
    { title: "Missing", summary: "No node." },
  ]);
  assert.match(summaryQuery!.query, /SET sec\.summary = ss\.summary/, "sets summary on the matched Section");
  assert.match(summaryQuery!.query, /toLower\(trim\(sec\.title\)\)/, "title matched case-insensitively");
});

test("ingest skips the section-summary update when the ref carries no sections", async () => {
  const { driver, calls } = makeDriver();
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [1, 2, 3]) },
    readChunks: async () => [{ id: "c1", text: "x", heading_path: "# X" }],
  });

  await service.ingest({ ref: makeRef({ sections: [] }), documentId: "doc", title: "Doc" });

  const summaryQueries = calls.filter((c) => c.query.includes("$sectionSummaries"));
  assert.equal(summaryQueries.length, 0, "no section-summary query without sections");
});

test("ingest streams chunk progress {done,total} after each embed+write batch (G4.S3.T8)", async () => {
  const { driver, calls } = makeDriver();
  const embedCalls: string[][] = [];
  const chunks = Array.from({ length: 5 }, (_, i) => ({
    id: `c${i + 1}`,
    text: `chunk ${i + 1}`,
    heading_path: "# H",
  }));
  const service = new Neo4jIngestService({
    driver,
    batchSize: 2,
    embedder: {
      embed: async (texts) => {
        embedCalls.push(texts);
        return texts.map(() => [1, 2, 3]);
      },
    },
    readChunks: async () => chunks,
  });

  const progress: Array<{ chunksStored: number; chunksTotal: number; progress: number }> = [];
  await service.ingest({
    ref: makeRef({ chunk_count: 5 }),
    documentId: "doc",
    title: "Doc",
    onProgress: (p) => progress.push({ ...p }),
  });

  assert.deepEqual(
    progress,
    [
      { chunksStored: 1, chunksTotal: 5, progress: 0.2 },
      { chunksStored: 2, chunksTotal: 5, progress: 0.4 },
      { chunksStored: 3, chunksTotal: 5, progress: 0.6 },
      { chunksStored: 4, chunksTotal: 5, progress: 0.8 },
      { chunksStored: 5, chunksTotal: 5, progress: 1 },
    ],
    "one progress report per chunk (cumulative done against the chunk total), so the frontend can show a live per-chunk ETA",
  );
  assert.deepEqual(embedCalls, [
    ["chunk 1", "chunk 2"],
    ["chunk 3", "chunk 4"],
    ["chunk 5"],
  ], "embed runs per batch (not once for all chunks), so writes stream through");
  const chunkWrites = calls.filter(
    (c) => c.query.startsWith("MERGE") && c.query.includes(`${CHUNK_LABEL}`) && !c.query.includes("UNWIND $sections"),
  );
  assert.equal(chunkWrites.length, 5, "every chunk is still stored");
});

test("ingest fires onProgress per chunk AFTER the chunk is MERGE'd + section-linked (G4.S3.T9)", async () => {
  const { driver, calls } = makeDriver();
  const chunks = Array.from({ length: 3 }, (_, i) => ({
    id: `c${i + 1}`,
    text: `chunk ${i + 1}`,
    heading_path: "Alpha / Beta",
  }));
  const service = new Neo4jIngestService({
    driver,
    batchSize: 1,
    embedder: { embed: async (texts) => texts.map(() => [1, 2, 3]) },
    readChunks: async () => chunks,
  });

  const seenAt: number[] = [];
  await service.ingest({
    ref: makeRef({ chunk_count: 3 }),
    documentId: "doc",
    title: "Doc",
    onProgress: (p) => {
      // Invocation order must trail the current chunk's MERGE + section-link queries.
      const chunkMerges = calls.filter(
        (c) => c.query.startsWith("MERGE") && c.query.includes(`${CHUNK_LABEL}`) && !c.query.includes("UNWIND $sections"),
      ).length;
      const sectionLinks = calls.filter((c) => c.query.includes("UNWIND $sections")).length;
      seenAt.push(chunkMerges);
      assert.equal(sectionLinks, p.chunksStored, "section links complete before progress for the chunk");
      assert.equal(chunkMerges, p.chunksStored, "chunk MERGE complete before progress for the chunk");
    },
  });

  assert.deepEqual(seenAt, [1, 2, 3], "one onProgress invocation per chunk, after its write");
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

test("mentionPairs links each entity to the chunks whose text mentions its name or aliases (case-insensitive)", () => {
  const entities = [
    { name: "ZOB München", type: "place", description: "bus station", aliases: ["Zentraler Omnibusbahnhof"] },
    { name: "CALEO", type: "org", description: "company" },
  ];
  const chunks = [
    { id: "c1", text: "Der ZOB München liegt zentral.", heading_path: "# A" },
    { id: "c2", text: "Zentraler Omnibusbahnhof wird saniert.", heading_path: "# B" },
    { id: "c3", text: "Die Firma CALEO plant.", heading_path: "# C" },
    { id: "c4", text: "Kein Erwaehnen hier.", heading_path: "# D" },
  ];

  const pairs = mentionPairs(entities, chunks, "doc");

  assert.deepEqual(
    pairs.sort((a, b) => a.entityName.localeCompare(b.entityName) || a.chunkId.localeCompare(b.chunkId)),
    [
      { entityName: "CALEO", chunkId: "doc:c3" },
      { entityName: "ZOB München", chunkId: "doc:c1" },
      { entityName: "ZOB München", chunkId: "doc:c2" },
    ],
    "entity canonical name + aliases match chunks case-insensitively; unmatched chunks get no link",
  );
});

test("ingest links each Entity to the Chunks that mention it via MENTIONED_IN (idempotent MERGE)", async () => {
  const { driver, calls } = makeDriver();
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [1, 2, 3]) },
    readChunks: async () => [
      { id: "c1", text: "ZOB München guide", heading_path: "# X" },
      { id: "c2", text: "CALEO is hiring", heading_path: "# Y" },
      { id: "c3", text: "nothing", heading_path: "# Z" },
    ],
  });

  await service.ingest({ ref: makeRef(), documentId: "doc", title: "Doc" });

  const mentionQuery = calls.find((c) => c.query.includes(`:${MENTIONED_IN_TYPE}`));
  assert.ok(mentionQuery, "MENTIONED_IN linking query issued");
  assert.match(mentionQuery!.query, /MERGE/, "idempotent (MERGE) entity→chunk link");
  assert.deepEqual(
    mentionQuery!.params!.mentions,
    [
      { entityName: "CALEO", chunkId: "doc:c2" },
      { entityName: "ZOB München", chunkId: "doc:c1" },
    ],
    "only entity-mentioning chunks are linked, id namespaced by document id",
  );
});

test("ingest issues no MENTIONED_IN query when no entity is mentioned in any chunk", async () => {
  const { driver, calls } = makeDriver();
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [1, 2, 3]) },
    readChunks: async () => [{ id: "c1", text: "nothing relevant", heading_path: "# X" }],
  });

  await service.ingest({ ref: makeRef(), documentId: "doc", title: "Doc" });

  const mentionQueries = calls.filter((c) => c.query.includes(`:${MENTIONED_IN_TYPE}`));
  assert.equal(mentionQueries.length, 0, "no MENTIONED_IN query without any mention");
});

interface OverwriteRecord {
  id: string;
  text?: string;
  hasEmbedding?: boolean;
}

/** Driver that answers the overwrite's lookup queries (resolve-doc + existing chunks). */
function makeOverwriteDriver(opts: {
  wikiPathRecord?: OverwriteRecord | null;
  existingChunks?: OverwriteRecord[];
} = {}) {
  const calls: RecordedCall[] = [];
  const record = (value: OverwriteRecord): { get(key: string): unknown } => ({
    get: (key) => {
      if (key === "id") return value.id;
      if (key === "text") return value.text ?? "";
      if (key === "hasEmbedding") return value.hasEmbedding ?? false;
      return null;
    },
  });
  const driver: Neo4jDriverLike = {
    session() {
      return {
        run: async (query: string, params?: Record<string, unknown>) => {
          calls.push({ query, params });
          if (query.includes("IS_DOCUMENT")) {
            return { records: opts.wikiPathRecord ? [record(opts.wikiPathRecord)] : [] };
          }
          if (query.includes("c.embedding IS NOT NULL")) {
            return { records: (opts.existingChunks ?? []).map(record) };
          }
          return { records: [] };
        },
        close: async () => {},
      };
    },
  };
  return { driver, calls };
}

test("overwrite resolves the Document via the wikiPath bridge and namespaces chunks by its id", async () => {
  const { driver, calls } = makeOverwriteDriver({ wikiPathRecord: { id: "existing-doc-id" } });
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [1]) },
    readChunks: async () => [{ id: "c1", text: "corrected text", heading_path: "# X" }],
  });

  const result = await service.overwrite({
    ref: makeRef(),
    documentId: "new-derived-id",
    title: "Doc",
    wikiPath: "wiki/ops/runbook.md",
  });

  assert.equal(result.documentId, "existing-doc-id", "the old Document id is reused");
  const chunkWrites = calls.filter(
    (c) => c.query.startsWith("MERGE") && c.query.includes(CHUNK_LABEL) && typeof c.params?.id === "string",
  );
  assert.equal(chunkWrites[0]!.params!.id, "existing-doc-id:c1", "chunk ids stay namespaced by the resolved id");
});

test("overwrite deletes the old document's stale chunks and sections (idempotent via wikiPath)", async () => {
  const { driver, calls } = makeOverwriteDriver({
    wikiPathRecord: { id: "doc" },
    existingChunks: [
      { id: "doc:c1", text: "old text", hasEmbedding: true },
      { id: "doc:stale", text: "stale chunk", hasEmbedding: true },
    ],
  });
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [1]) },
    readChunks: async () => [{ id: "c1", text: "old text", heading_path: "# X" }],
  });

  await service.overwrite({ ref: makeRef(), documentId: "doc", title: "Doc", wikiPath: "wiki/ops/runbook.md" });

  const staleDelete = calls.find((c) => c.query.includes("WHERE NOT c.id IN $ids"));
  assert.ok(staleDelete, "stale-chunk DETACH DELETE issued");
  assert.deepEqual(staleDelete!.params!.ids, ["doc:c1"], "the stale chunk id is NOT in the keep list");
  const sectionDelete = calls.find((c) => c.query.includes("MATCH (s:") && c.query.includes("DETACH DELETE s"));
  assert.ok(sectionDelete, "the old document's Section nodes are deleted");
  assert.equal(sectionDelete!.params!.documentId, "doc");
});

test("overwrite reuses embeddings for unchanged chunks — a localized edit avoids a full re-embed", async () => {
  let embedBatches = 0;
  const { driver } = makeOverwriteDriver({
    wikiPathRecord: { id: "doc" },
    existingChunks: [
      { id: "doc:c1", text: "unchanged", hasEmbedding: true },
      { id: "doc:c2", text: "old description", hasEmbedding: true },
    ],
  });
  const service = new Neo4jIngestService({
    driver,
    embedder: {
      embed: async (texts) => {
        embedBatches += 1;
        return texts.map((_, i) => [i]);
      },
    },
    readChunks: async () => [
      { id: "c1", text: "unchanged", heading_path: "# X" },
      { id: "c2", text: "corrected description", heading_path: "# Y" },
    ],
  });

  const result = await service.overwrite({ ref: makeRef(), documentId: "doc", title: "Doc" });
  assert.equal(embedBatches, 1, "only the changed chunk is embedded (one batch)");
  assert.equal(result.chunksStored, 2);
  assert.equal(result.documentId, "doc");
});

test("overwrite without a prior Document falls back to the provided documentId (fresh ingest)", async () => {
  const { driver } = makeOverwriteDriver({ wikiPathRecord: null });
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [1]) },
    readChunks: async () => [{ id: "c1", text: "text", heading_path: "# X" }],
  });

  const result = await service.overwrite({
    ref: makeRef(),
    documentId: "doc",
    title: "Doc",
    wikiPath: "wiki/ops/runbook.md",
  });
  assert.equal(result.documentId, "doc");
  assert.equal(result.chunksStored, 1);
});

test("overwrite cleans stale RELATION edges between entities no longer mentioned + orphan entities", async () => {
  const { driver, calls } = makeOverwriteDriver({ wikiPathRecord: { id: "doc" } });
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [1]) },
    readChunks: async () => [{ id: "c1", text: "CALEO hires", heading_path: "# X" }],
  });

  await service.overwrite({ ref: makeRef(), documentId: "doc", title: "Doc" });

  const staleRelation = calls.find((c) => c.query.includes("WHERE NOT (a)") && c.query.includes("DELETE r"));
  assert.ok(staleRelation, "stale relation cleanup issued after the new mentions are written");
  const orphan = calls.find((c) => c.query.includes("NOT (e)--()"));
  assert.ok(orphan, "orphaned entity cleanup issued");
});

test("overwrite fires onProgress per chunk (G4.S3.T9 reuse)", async () => {
  const progress: number[] = [];
  const { driver } = makeOverwriteDriver({ wikiPathRecord: { id: "doc" } });
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map((_, i) => [i]) },
    readChunks: async () => [
      { id: "c1", text: "one", heading_path: "# X" },
      { id: "c2", text: "two", heading_path: "# Y" },
    ],
  });

  await service.overwrite({
    ref: makeRef(),
    documentId: "doc",
    title: "Doc",
    onProgress: (p) => progress.push(p.chunksStored),
  });

  assert.deepEqual(progress, [1, 2], "one progress report per chunk processed");
});
