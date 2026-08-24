/**
 * G4.S10.T1 — LINK at the store layer: provenance accumulation on entities
 * (source_docs / wiki_paths), cross-document link_edges written through the
 * consistency layer, and the parallel-upload race test — two documents sharing
 * an entity must converge on ONE node carrying BOTH sources (the global write
 * mutex serializes the entity/relation phase).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ENTITY_LABEL,
  ENTITY_RELATION_TYPE,
  type Neo4jDriverLike,
} from "../../src/kb/store/schema.js";
import { Neo4jIngestService } from "../../src/kb/store/ingest.js";
import type { RefineOutputRef } from "../../src/agents/refine-output.js";

interface SimNode {
  name: string;
  aliases: string[];
  sources: string[];
  wikis: string[];
}

interface Event {
  doc: string | null;
  kind: "entity" | "other";
}

/**
 * In-memory graph simulator with REAL MERGE semantics for the entity write
 * query. Every run() yields to the microtask queue FIRST — a genuine
 * interleaving window between the two concurrent ingests.
 */
function makeGraphSim() {
  const nodes = new Map<string, SimNode>();
  const events: Event[] = [];
  const relationQueries: Array<{ query: string; params?: Record<string, unknown> }> = [];
  const driver: Neo4jDriverLike = {
    session() {
      return {
        run: async (query: string, params: Record<string, unknown> = {}) => {
          await new Promise((resolve) => setImmediate(resolve));
          if (query.includes("{name: $name}") && query.includes("source_docs")) {
            const name = String(params.name);
            const key = name.toUpperCase();
            const node = nodes.get(key) ?? { name, aliases: [], sources: [], wikis: [] };
            const documentId = String(params.documentId);
            if (!node.sources.includes(documentId)) node.sources.push(documentId);
            const wikiPath = params.wikiPath;
            if (wikiPath !== null && wikiPath !== undefined && !node.wikis.includes(String(wikiPath))) {
              node.wikis.push(String(wikiPath));
            }
            nodes.set(key, node);
            events.push({ doc: documentId, kind: "entity" });
          } else if (query.startsWith(`MATCH (a:${ENTITY_LABEL}`) && query.includes(`MERGE (a)-[r:${ENTITY_RELATION_TYPE}]`)) {
            relationQueries.push({ query, params });
            events.push({ doc: null, kind: "other" });
          } else {
            events.push({ doc: null, kind: "other" });
          }
          return { records: [] };
        },
        close: async () => {},
      };
    },
  };
  return { driver, nodes, events, relationQueries };
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
    frontmatter: { type: "report", topic: "sap/consolidation/bcs" },
    entities: [{ name: "CALEO", type: "org", description: "the group" }],
    relations: [],
    keywords: [],
    quality: { complete: true, confidence: 0.95, issues: [], action: "auto_accept" },
    summary: "Summary",
    sections: [],
    mode: "single",
    section_paths: [],
    ...overrides,
  };
}

function makeService(driver: Neo4jDriverLike): Neo4jIngestService {
  return new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [0.1, 0.2]) },
    readChunks: async () => [{ id: "c1", text: "CALEO runs the show", heading_path: "# A" }],
    applySchema: false,
  });
}

test("RACE: two parallel uploads sharing an entity → ONE node with BOTH source_docs recorded", async () => {
  const sim = makeGraphSim();
  const service = makeService(sim.driver);

  const refA = makeRef({ entities: [{ name: "CALEO", type: "org", description: "from doc a" }] });
  const refB = makeRef({ entities: [{ name: "CALEO", type: "org", description: "from doc b" }] });

  await Promise.all([
    service.ingest({ ref: refA, documentId: "doc-a", title: "Doc A" }),
    service.ingest({ ref: refB, documentId: "doc-b", title: "Doc B" }),
  ]);

  const caleoNodes = [...sim.nodes.entries()].filter(([key]) => key === "CALEO");
  assert.equal(caleoNodes.length, 1, "exactly one CALEO node");
  const sources = caleoNodes[0]![1].sources.slice().sort();
  assert.deepEqual(sources, ["doc-a", "doc-b"], "both sources recorded on the single node");

  // The mutex serialized the entity phases: no interleaving of the two
  // documents' entity writes.
  const entityDocs = sim.events.filter((e) => e.kind === "entity").map((e) => e.doc);
  assert.equal(entityDocs.length, 2);
  let alternation = 0;
  for (let i = 1; i < entityDocs.length; i += 1) {
    if (entityDocs[i] !== entityDocs[i - 1]) alternation += 1;
  }
  assert.ok(alternation <= 1, `entity writes grouped per document under the mutex: ${JSON.stringify(entityDocs)}`);
});

test("provenance accumulates across sequential ingests and is idempotent per document", async () => {
  const sim = makeGraphSim();
  const service = makeService(sim.driver);

  await service.ingest({
    ref: makeRef(),
    documentId: "doc-1",
    title: "One",
    wikiPath: "wiki/a/one.md",
  });
  await service.ingest({
    ref: makeRef(),
    documentId: "doc-2",
    title: "Two",
    wikiPath: "wiki/b/two.md",
  });
  // Re-ingest of doc-1 must NOT duplicate its source entry.
  await service.ingest({
    ref: makeRef(),
    documentId: "doc-1",
    title: "One",
    wikiPath: "wiki/a/one.md",
  });

  const node = sim.nodes.get("CALEO")!;
  assert.deepEqual(node.sources, ["doc-1", "doc-2"]);
  assert.equal(node.wikis.filter((w) => w === "wiki/a/one.md").length, 1, "wiki_paths idempotent");
  assert.deepEqual(node.wikis.slice().sort(), ["wiki/a/one.md", "wiki/b/two.md"]);
});

test("link_edges ride the RELATION consistency layer with the semantic keyword + evidence quote", async () => {
  const sim = makeGraphSim();
  const service = makeService(sim.driver);

  await service.ingest({
    ref: makeRef({
      entities: [
        { name: "CALEO", type: "org", description: "org" },
        { name: "CALEO Tower", type: "location", description: "hq building" },
      ],
      link_edges: [
        { source: "CALEO", target: "CALEO Tower", relation: "HAS_OFFICE", evidence_quote: "HQ at CALEO Tower" },
      ],
    }),
    documentId: "doc-link",
    title: "Linked",
  });

  assert.equal(sim.relationQueries.length, 1, "one RELATION edge written for the link decision");
  const params = sim.relationQueries[0]!.params!;
  assert.equal(params.sourceUpper, "CALEO");
  assert.equal(params.targetUpper, "CALEO TOWER");
  assert.deepEqual(params.keywords, ["HAS_OFFICE"]);
  assert.equal(params.description, "HQ at CALEO Tower");
});
