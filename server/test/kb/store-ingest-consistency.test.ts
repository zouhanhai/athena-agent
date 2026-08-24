import { test } from "node:test";
import assert from "node:assert/strict";
import type { RefineOutputRef } from "../../src/agents/refine-output.js";
import {
  ENTITY_LABEL,
  ENTITY_RELATION_TYPE,
  type Neo4jDriverLike,
} from "../../src/kb/store/schema.js";
import { Neo4jIngestService } from "../../src/kb/store/ingest.js";

/**
 * G4.S8.T16 — Neo4j consistency layer: missing relation endpoints are
 * MERGE-created (never silently dropped), counters are TRUTHFUL
 * ({relationsInput, relationsStored, endpointEntitiesCreated}), and chunk
 * context flows onto Chunk nodes + into the embed input.
 */

interface RecordedCall {
  query: string;
  params?: Record<string, unknown>;
}

/** Driver that simulates the Entity nameUpper population for endpoint resolution. */
function makeDriver(opts: { existingNameUppers?: string[]; edgeCounts?: number[] } = {}): {
  driver: Neo4jDriverLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const existing = new Set(opts.existingNameUppers ?? []);
  const edgeCounts = [...(opts.edgeCounts ?? [])];
  const driver: Neo4jDriverLike = {
    session() {
      return {
        run: async (query: string, params?: Record<string, unknown>) => {
          calls.push({ query, params });
          if (query.includes("UNWIND $names") && query.includes("nameUpper")) {
            const names = (params!.names as string[]).filter((n) => existing.has(n));
            return { records: names.map((n) => ({ get: (k: string) => (k === "name" ? n : null) })) };
          }
          // MERGE-create of a missing endpoint registers it so later lookups see it
          if (query.startsWith(`MERGE (e:${ENTITY_LABEL}`) && query.includes("ON CREATE")) {
            existing.add(params!.nameUpper as string);
            return { records: [] };
          }
          if (query.includes("count(r)") || query.includes("count(a)")) {
            const n = edgeCounts.shift() ?? 1;
            return { records: [{ get: (k: string) => (k === "n" ? n : null) }] };
          }
          return { records: [] };
        },
        close: async () => {},
      };
    },
  };
  return { driver, calls };
}

function makeRef(overrides: Partial<RefineOutputRef> = {}): RefineOutputRef {
  return {
    md_ref: "/storage/doc/markdown.md",
    chunks_ref: "/storage/doc/chunks.json",
    preview: "preview",
    char_count: 100,
    line_count: 10,
    header_count: 2,
    chunk_count: 1,
    frontmatter: { type: "event", topic: "internal/events" },
    entities: [{ name: "CALEO", type: "org", description: "organizer" }],
    relations: [],
    keywords: [],
    quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
    summary: "Summary.",
    sections: [],
    mode: "single",
    section_paths: [],
    ...overrides,
  };
}

const baseChunks = [{ id: "c1", text: "CALEO hosts.", heading_path: "# H" }];

test("missing relation endpoints are MERGE-created as Entities (type other / keyword-inferred), never silently dropped", async () => {
  // CALEO is declared; MALLORCA + MAX MUSTERMANN are NOT — the old code dropped these edges.
  const { driver, calls } = makeDriver({ existingNameUppers: ["CALEO"] });
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [1]) },
    readChunks: async () => baseChunks,
  });

  await service.ingest({
    ref: makeRef({
      entities: [{ name: "CALEO", type: "org", description: "organizer" }],
      relations: [
        { source: "CALEO", target: "Mallorca", keywords: ["findet statt in"], description: "takes place in Mallorca." },
        { source: "Max Mustermann", target: "CALEO", keywords: ["teilnahm an"], description: "joined." },
        { source: "CALEO", target: "Ghost Hotel", keywords: [], description: "mystery venue." },
      ],
    }),
    documentId: "doc",
    title: "Doc",
  });

  const creates = calls.filter((c) => c.query.includes("ON CREATE"));
  assert.equal(creates.length, 3, `one MERGE-create per missing endpoint (got ${creates.length})`);
  const createdNames = creates.map((c) => c.params!.name);
  assert.deepEqual([...createdNames].sort(), ["Ghost Hotel", "Mallorca", "Max Mustermann"]);

  // keyword heuristic: event-ish keyword → event; person-ish → person; nothing → "other"
  // (G4.S10.T2 closed enum — "other" routes matching through the LLM path)
  const mallorca = creates.find((c) => c.params!.name === "Mallorca")!;
  assert.equal(mallorca.params!.type, "event");
  const max = creates.find((c) => c.params!.name === "Max Mustermann")!;
  assert.equal(max.params!.type, "person");
  const ghost = creates.find((c) => c.params!.name === "Ghost Hotel")!;
  assert.equal(ghost.params!.type, "other");

  // every created entity carries nameUpper + the relation's description
  for (const c of creates) {
    assert.equal(c.params!.nameUpper, String(c.params!.name).toUpperCase());
    assert.equal(typeof c.params!.description, "string");
  }

  // all three edges written BETWEEN the endpoints
  const edges = calls.filter((c) => c.query.includes("MERGE (a)-[r:") && c.query.includes(ENTITY_RELATION_TYPE));
  assert.equal(edges.length, 3, "no edge skipped");
});

test("counters are truthful: {relationsInput, relationsStored, endpointEntitiesCreated}", async () => {
  // DB reports one edge MERGE'd with count 0 (edge already existed identically? count returns merged rows)
  const { driver } = makeDriver({
    existingNameUppers: ["CALEO"],
    edgeCounts: [1, 1, 1],
  });
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [1]) },
    readChunks: async () => baseChunks,
  });

  const result = await service.ingest({
    ref: makeRef({
      entities: [{ name: "CALEO", type: "org", description: "o" }],
      relations: [
        { source: "CALEO", target: "Mallorca", keywords: [], description: "d1" },
        { source: "Mallorca", target: "CALEO", keywords: [], description: "d2" },
        { source: "X", target: "Y", keywords: [], description: "d3" },
      ],
    }),
    documentId: "doc",
    title: "Doc",
  });

  assert.deepEqual(
    {
      relationsInput: result.relationsInput,
      relationsStored: result.relationsStored,
      endpointEntitiesCreated: result.endpointEntitiesCreated,
    },
    { relationsInput: 3, relationsStored: 3, endpointEntitiesCreated: 3 },
    "input vs landed vs created-endpoint counts reported separately and honestly",
  );
});

test("relationsStored reflects what the DB ACTUALLY landed (not the input count)", async () => {
  const { driver } = makeDriver({ existingNameUppers: ["CALEO"], edgeCounts: [1, 0] });
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [1]) },
    readChunks: async () => baseChunks,
  });

  const result = await service.ingest({
    ref: makeRef({
      relations: [
        { source: "CALEO", target: "CALEO", keywords: [], description: "self" }, // lands
        { source: "", target: "CALEO", keywords: [], description: "empty source" }, // skipped
      ],
    }),
    documentId: "doc",
    title: "Doc",
  });
  assert.equal(result.relationsInput, 2);
  assert.equal(result.relationsStored, 1, "only the edge the DB confirmed");
  assert.equal(result.endpointEntitiesCreated, 0);
});

test("zero relations → zero-iteration fast path, no resolution queries", async () => {
  const { driver, calls } = makeDriver({});
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [1]) },
    readChunks: async () => baseChunks,
  });
  const result = await service.ingest({ ref: makeRef(), documentId: "doc", title: "Doc" });
  assert.deepEqual(
    { relationsInput: 0, relationsStored: 0, endpointEntitiesCreated: 0 },
    { relationsInput: result.relationsInput, relationsStored: result.relationsStored, endpointEntitiesCreated: result.endpointEntitiesCreated },
  );
  assert.ok(!calls.some((c) => c.query.includes("UNWIND $names")), "no endpoint resolution without relations");
});

test("chunk.context is stored on the Chunk node AND prepended to the embed input", async () => {
  const embeddedTexts: string[] = [];
  const { driver, calls } = makeDriver({});
  const service = new Neo4jIngestService({
    driver,
    embedder: {
      embed: async (texts) => {
        embeddedTexts.push(...texts);
        return texts.map(() => [1]);
      },
    },
    readChunks: async () => [
      { id: "c1", text: "Arrival details.", heading_path: "Doc / Thursday", context: "CALEO schedule; this section covers Doc / Thursday." },
      { id: "c2", text: "No context chunk.", heading_path: "# X" },
    ],
  });

  await service.ingest({ ref: makeRef({ chunk_count: 2 }), documentId: "doc", title: "Doc" });

  assert.deepEqual(embeddedTexts, [
    "CALEO schedule; this section covers Doc / Thursday.\nArrival details.",
    "No context chunk.",
  ], "context is PREPENDED to the embedded text; chunks without context embed bare");

  const chunkWrites = calls.filter((c) => c.query.includes("SET c.text") && !c.query.includes("UNWIND $sections"));
  const withContext = chunkWrites.find((c) => c.params!.id === "doc:c1")!;
  assert.match(withContext.query, /c\.context = \$context/, "context persisted as a Chunk node property");
  assert.equal(withContext.params!.context, "CALEO schedule; this section covers Doc / Thursday.");
});

test("overwrite path: same truthful counters + endpoint MERGE-creation", async () => {
  const calls: RecordedCall[] = [];
  const existing = new Set<string>([]);
  const driver: Neo4jDriverLike = {
    session() {
      return {
        run: async (query: string, params?: Record<string, unknown>) => {
          calls.push({ query, params });
          if (query.includes("IS_DOCUMENT")) return { records: [{ get: (k: string) => (k === "id" ? "doc" : null) }] };
          if (query.includes("c.embedding IS NOT NULL")) return { records: [] };
          if (query.includes("UNWIND $names") && query.includes("nameUpper")) {
            const names = (params!.names as string[]).filter((n) => existing.has(n));
            return { records: names.map((n) => ({ get: (k: string) => (k === "name" ? n : null) })) };
          }
          if (query.startsWith(`MERGE (e:${ENTITY_LABEL}`) && query.includes("ON CREATE")) {
            existing.add(params!.nameUpper as string);
            return { records: [] };
          }
          if (query.includes("count(r)")) return { records: [{ get: (k: string) => (k === "n" ? 1 : null) }] };
          return { records: [] };
        },
        close: async () => {},
      };
    },
  };
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [1]) },
    readChunks: async () => baseChunks,
  });

  const result = await service.overwrite({
    ref: makeRef({
      relations: [
        { source: "A", target: "B", keywords: [], description: "d" },
        { source: "B", target: "C", keywords: [], description: "d" },
      ],
    }),
    documentId: "doc",
    title: "Doc",
    wikiPath: "wiki/x/doc.md",
  });

  assert.deepEqual(
    { relationsInput: result.relationsInput, relationsStored: result.relationsStored, endpointEntitiesCreated: result.endpointEntitiesCreated },
    { relationsInput: 2, relationsStored: 2, endpointEntitiesCreated: 3 },
  );
  // T14 cascade semantics intact: orphan cleanup runs AFTER the endpoint creates
  const createIdx = calls.findIndex((c) => c.query.includes("ON CREATE"));
  const orphanIdx = calls.findIndex((c) => c.query.includes("NOT (e)--()"));
  assert.ok(createIdx !== -1 && orphanIdx > createIdx, "orphan cleanup still runs after relation writes");
});
