/**
 * G4.S10.T2 — explicit source provenance on Entity nodes.
 *
 * Behavioral graph simulator covering the three protection rules:
 *   1. ingest/overwrite APPEND the current document path (merge JOIN included);
 *   2. delete cascade strips the deleted document's path from every entity;
 *   3. an entity is deletable ONLY when source_docs is empty AND no
 *      MENTIONED_IN edge remains — either alone keeps it alive.
 * Plus: relation-endpoint creates join provenance too, and overwrite REBUILDS
 * (strips stale paths before re-appending) instead of accumulating.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ENTITY_LABEL, type Neo4jDriverLike } from "../../src/kb/store/schema.js";
import { Neo4jIngestService } from "../../src/kb/store/ingest.js";
import { applyMergesToEntities } from "../../src/kb/link/link-engine.js";
import type { RefineOutputRef } from "../../src/agents/refine-output.js";

interface SimEntity {
  name: string;
  nameUpper: string;
  type: string;
  description: string;
  aliases: string[];
  sourceDocs: string[];
  wikiPaths: string[];
  /** Chunk ids carrying a MENTIONED_IN edge. */
  mentions: Set<string>;
  /** Folded counterpart names of RELATION edges (any direction). */
  relations: Set<string>;
}

interface SimChunk {
  id: string;
  documentId: string;
}

/**
 * In-memory Neo4j double implementing EXACTLY the queries the provenance
 * features issue — with real list-append/strip/orphan semantics.
 */
function makeProvenanceGraph() {
  const entities = new Map<string, SimEntity>();
  const chunks = new Map<string, SimChunk>();
  const documents = new Map<string, { id: string; mdRef?: string; wikiPath?: string }>();
  const queries: Array<{ query: string; params: Record<string, unknown> }> = [];

  const ent = (key: string): SimEntity | undefined => entities.get(key.toUpperCase());

  const appendProvenance = (
    node: SimEntity,
    documentId: string,
    wikiPath: string | null | undefined,
  ): void => {
    if (!node.sourceDocs.includes(documentId)) node.sourceDocs.push(documentId);
    if (wikiPath && !node.wikiPaths.includes(wikiPath)) node.wikiPaths.push(wikiPath);
  };

  const stripProvenance = (documentId: string, wikiPath: string): void => {
    for (const node of entities.values()) {
      node.sourceDocs = node.sourceDocs.filter((d) => d !== documentId);
      node.wikiPaths = node.wikiPaths.filter((w) => w !== wikiPath);
    }
  };

  const deleteChunksOf = (documentId: string): number => {
    let n = 0;
    for (const [id, chunk] of [...chunks.entries()]) {
      if (chunk.documentId !== documentId) continue;
      chunks.delete(id);
      n += 1;
    }
    for (const node of entities.values()) {
      for (const chunkId of [...node.mentions]) {
        if (!chunks.has(chunkId)) node.mentions.delete(chunkId);
      }
    }
    return n;
  };

  const deleteOrphans = (): number => {
    let n = 0;
    for (const [key, node] of [...entities.entries()]) {
      // Spec §5: deletable ONLY when provenance is exhausted AND nothing
      // mentions it anymore — relation edges do NOT protect (they DETACH).
      const noMentions = node.mentions.size === 0;
      if (noMentions && node.sourceDocs.length === 0) {
        entities.delete(key);
        n += 1;
      }
    }
    return n;
  };

  const driver: Neo4jDriverLike = {
    session() {
      return {
        run: async (query: string, params: Record<string, unknown> = {}) => {
          queries.push({ query, params });
          const q = query.replace(/\s+/g, " ");

          // Entity MERGE (declared extraction entity) — appends provenance.
          if (q.includes("{name: $name}") && q.includes("source_docs")) {
            const name = String(params.name);
            const key = name.toUpperCase();
            let node = ent(key);
            if (!node) {
              node = {
                name,
                nameUpper: key,
                type: String(params.type ?? ""),
                description: String(params.description ?? ""),
                aliases: (params.aliases as string[]) ?? [],
                sourceDocs: [],
                wikiPaths: [],
                mentions: new Set(),
                relations: new Set(),
              };
              entities.set(key, node);
            } else {
              node.type = String(params.type ?? node.type);
              node.description = String(params.description ?? node.description);
              node.aliases = (params.aliases as string[]) ?? node.aliases;
            }
            appendProvenance(node, String(params.documentId), params.wikiPath as string | null);
            return { records: [] };
          }

          // Relation-endpoint MERGE-create — joins provenance too (T2).
          if (q.includes("{nameUpper: $nameUpper}") && q.includes("ON CREATE SET")) {
            const key = String(params.nameUpper).toUpperCase();
            let node = ent(key);
            if (!node) {
              node = {
                name: String(params.name),
                nameUpper: key,
                type: String(params.type ?? ""),
                description: String(params.description ?? ""),
                aliases: [],
                sourceDocs: [],
                wikiPaths: [],
                mentions: new Set(),
                relations: new Set(),
              };
              entities.set(key, node);
            }
            appendProvenance(node, String(params.documentId), params.wikiPath as string | null);
            return { records: [] };
          }

          // Relation edge write — record adjacency for the orphan rule.
          if (q.includes(`MERGE (a)-[r:`) && q.includes(`]->(b:${ENTITY_LABEL}`)) {
            const a = ent(String(params.sourceUpper));
            const b = ent(String(params.targetUpper));
            if (a && b && a !== b) {
              a.relations.add(b.nameUpper);
              b.relations.add(a.nameUpper);
            }
            return { records: [{ get: (k: string) => (k === "n" ? 1 : null) }] };
          }

          // Provenance STRIP (delete cascade + overwrite rebuild).
          if (q.includes("source_docs") && q.includes("WHERE x <> $documentId")) {
            stripProvenance(String(params.documentId), String(params.wikiPath));
            return { records: [] };
          }

          // Delete-cascade orphan sweep: empty provenance AND no mentions.
          if (q.includes(`NOT (e)-[:MENTIONED_IN]`) && q.includes("size(e.source_docs) = 0")) {
            const n = deleteOrphans();
            return { records: [{ get: (k: string) => (k === "n" ? n : null) }] };
          }

          // Overwrite final sweep: no edges of ANY kind AND empty provenance.
          if (q.includes("NOT (e)--()") && q.includes("size(e.source_docs) = 0")) {
            let n = 0;
            for (const [key, node] of [...entities.entries()]) {
              if (node.mentions.size === 0 && node.relations.size === 0 && node.sourceDocs.length === 0) {
                entities.delete(key);
                n += 1;
              }
            }
            return { records: [] };
          }

          // Delete cascade resolution: WikiPage bridge …
          if (q.includes("IS_DOCUMENT") && q.includes("RETURN d.id")) {
            const wikiPath = String(params.wikiPath);
            const records = [...documents.values()]
              .filter((d) => d.wikiPath === wikiPath)
              .map((d) => ({ get: (k: string) => (k === "id" ? d.id : k === "mdRef" ? (d.mdRef ?? null) : null) }));
            return { records };
          }
          // … and the md_ref stem fallback.
          if (q.includes("ENDS WITH")) {
            const suffix = String(params.suffix);
            const records = [...documents.values()]
              .filter((d) => (d.mdRef ?? "").endsWith(suffix))
              .map((d) => ({ get: (k: string) => (k === "id" ? d.id : k === "mdRef" ? (d.mdRef ?? null) : null) }));
            return { records };
          }

          // Subtree deletes (chunks/sections counted per label).
          if (q.includes(`DETACH DELETE c RETURN count(c)`)) {
            return { records: [{ get: (k: string) => (k === "n" ? deleteChunksOf(String(params.id)) : null) }] };
          }
          if (q.includes(`DETACH DELETE s RETURN count(s)`)) {
            return { records: [{ get: (k: string) => (k === "n" ? 0 : null) }] };
          }
          if (q.includes(`DETACH DELETE d`)) {
            documents.delete(String(params.id));
            return { records: [] };
          }

          // WikiPage ghost cleanup + co-occurs cleanup + mention rewrites: no-op.
          if (q.includes("RETURN count(e) AS total")) {
            return { records: [{ get: (k: string) => (k === "total" ? entities.size : null) }] };
          }
          return { records: [] };
        },
        close: async () => {},
      };
    },
  };

  const seedDocument = (id: string, opts: { wikiPath?: string; mdRef?: string; chunks?: string[] } = {}): void => {
    documents.set(id, { id, wikiPath: opts.wikiPath, mdRef: opts.mdRef });
    for (const chunkId of opts.chunks ?? []) chunks.set(chunkId, { id: chunkId, documentId: id });
  };

  return { driver, entities, chunks, documents, queries, seedDocument, ent };
}

function makeService(driver: Neo4jDriverLike): Neo4jIngestService {
  return new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [0.1]) },
    readChunks: async () => [{ id: "c1", text: "body", heading_path: "# H" }],
    applySchema: false,
  });
}

function makeRef(overrides: Partial<RefineOutputRef> = {}): RefineOutputRef {
  return {
    md_ref: "/storage/doc/markdown.md",
    chunks_ref: "/storage/doc/chunks.json",
    preview: "preview",
    char_count: 10,
    line_count: 1,
    header_count: 1,
    chunk_count: 1,
    frontmatter: { type: "report", topic: "internal/events" },
    entities: [],
    relations: [],
    keywords: [],
    quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
    summary: "Summary",
    sections: [],
    mode: "single",
    section_paths: [],
    ...overrides,
  };
}

test("delete cascade: shared entity loses the deleted doc's path but SURVIVES on another document's provenance", async () => {
  const g = makeProvenanceGraph();
  const service = makeService(g.driver);

  // CALEO lives in two documents; the second document keeps it alive.
  g.seedDocument("doc-a", { wikiPath: "wiki/a/a.md", mdRef: "/ref/a/markdown.md", chunks: ["doc-a:c1"] });
  g.seedDocument("doc-b", { wikiPath: "wiki/b/b.md", mdRef: "/ref/b/markdown.md", chunks: ["doc-b:c1"] });
  const caleo: SimEntity = {
    name: "CALEO",
    nameUpper: "CALEO",
    type: "org",
    description: "",
    aliases: [],
    sourceDocs: ["doc-a", "doc-b"],
    wikiPaths: ["wiki/a/a.md", "wiki/b/b.md"],
    mentions: new Set(["doc-a:c1", "doc-b:c1"]),
    relations: new Set(),
  };
  g.entities.set("CALEO", caleo);

  const result = await service.deleteDocumentsForWikiPage({ wikiPath: "wiki/a/a.md", stem: "a" });

  assert.equal(result.documentsRemoved, 1);
  assert.deepEqual(caleo.sourceDocs, ["doc-b"], "deleted document stripped from source_docs");
  assert.deepEqual(caleo.wikiPaths, ["wiki/b/b.md"], "deleted page stripped from wiki_paths");
  assert.ok(g.ent("CALEO"), "entity retained while another document still mentions it");
  assert.equal(result.entitiesRemoved, 0);
});

test("delete cascade: entity is deletable only when source_docs is empty AND no MENTIONED_IN remains", async () => {
  const g = makeProvenanceGraph();
  const service = makeService(g.driver);

  g.seedDocument("doc-a", { wikiPath: "wiki/a/a.md", mdRef: "/ref/a/markdown.md", chunks: ["doc-a:c1"] });
  g.seedDocument("doc-b", { wikiPath: "wiki/b/b.md", mdRef: "/ref/b/markdown.md", chunks: ["doc-b:c1"] });

  // GHOST: only doc-a mentions it (provenance + mention) → fully removable.
  g.entities.set("GHOST", {
    name: "GHOST",
    nameUpper: "GHOST",
    type: "concept",
    description: "",
    aliases: [],
    sourceDocs: ["doc-a"],
    wikiPaths: ["wiki/a/a.md"],
    mentions: new Set(["doc-a:c1"]),
    relations: new Set(),
  });
  // LEGACY: pre-migration node with NO source_docs but a live mention in ANOTHER
  // document → the mention-count protection ALONE must retain it.
  g.entities.set("LEGACY", {
    name: "LEGACY",
    nameUpper: "LEGACY",
    type: "concept",
    description: "",
    aliases: [],
    sourceDocs: [],
    wikiPaths: [],
    mentions: new Set(["doc-b:c1"]),
    relations: new Set(),
  });
  // ORPHANED-ENDPOINT: relation-only endpoint whose provenance points at doc-a
  // → after the strip both protections are exhausted → removed.
  g.entities.set("ENDPOINT", {
    name: "ENDPOINT",
    nameUpper: "ENDPOINT",
    type: "other",
    description: "",
    aliases: [],
    sourceDocs: ["doc-a"],
    wikiPaths: ["wiki/a/a.md"],
    mentions: new Set(),
    relations: new Set(),
  });

  await service.deleteDocumentsForWikiPage({ wikiPath: "wiki/a/a.md", stem: "a" });

  assert.ok(!g.ent("GHOST"), "fully-exhausted provenance + mentions → deleted");
  assert.ok(!g.ent("ENDPOINT"), "relation-only endpoint with emptied provenance → deleted");
  assert.ok(g.ent("LEGACY"), "live mention ALONE retains a legacy node");
});

test("ingest appends provenance; relation-endpoint-created entities join provenance too", async () => {
  const g = makeProvenanceGraph();
  const service = makeService(g.driver);

  await service.ingest({
    ref: makeRef({
      entities: [{ name: "CALEO", type: "org", description: "group" }],
      relations: [{ source: "CALEO", target: "MYSTERY UNIT", keywords: ["CALLS"], description: "" }],
    }),
    documentId: "doc-1",
    title: "One",
    wikiPath: "wiki/one.md",
  });

  const caleo = g.ent("CALEO")!;
  assert.deepEqual(caleo.sourceDocs, ["doc-1"]);
  assert.deepEqual(caleo.wikiPaths, ["wiki/one.md"]);
  const mystery = g.ent("MYSTERY UNIT");
  assert.ok(mystery, "undeclared relation endpoint was MERGE-created");
  assert.deepEqual(mystery!.sourceDocs, ["doc-1"], "endpoint creation records the source document");
  assert.deepEqual(mystery!.wikiPaths, ["wiki/one.md"]);
});

test("LINK merge apply joins provenance onto the canonical node across documents", async () => {
  const g = makeProvenanceGraph();
  const service = makeService(g.driver);

  // Doc A establishes the canonical node.
  await service.ingest({
    ref: makeRef({ entities: [{ name: "CALEO Office", type: "org", description: "office" }] }),
    documentId: "doc-a",
    title: "A",
    wikiPath: "wiki/a.md",
  });

  // Doc B extracted "galleo Office"; T1's merge apply renames it BEFORE store —
  // the store write then lands the doc-B provenance ON the canonical node.
  const merged = applyMergesToEntities(
    [{ name: "galleo Office", type: "organization", description: "renamed office" }],
    [],
    [{ from: "galleo Office", to: "CALEO Office", similarity: 0.97, evidence: "same office" }],
  );
  await service.ingest({
    ref: makeRef({ entities: merged.entities }),
    documentId: "doc-b",
    title: "B",
    wikiPath: "wiki/b.md",
  });

  const office = g.ent("CALEO Office")!;
  assert.deepEqual(office.sourceDocs.sort(), ["doc-a", "doc-b"], "merged candidate joined its source");
  assert.deepEqual(office.wikiPaths.sort(), ["wiki/a.md", "wiki/b.md"]);
  assert.equal(g.ent("GALLEO OFFICE"), undefined, "no duplicate node for the merged alias");
});

test("overwrite REBUILDS provenance: stale paths stripped, current extraction re-appended once", async () => {
  const g = makeProvenanceGraph();
  const service = makeService(g.driver);

  g.seedDocument("doc-1", { wikiPath: "wiki/x/doc.md", chunks: ["doc-1:c1"] });
  await service.ingest({
    ref: makeRef({
      entities: [
        { name: "CALEO", type: "org", description: "v1" },
        { name: "STALE", type: "concept", description: "only in v1" },
      ],
    }),
    documentId: "doc-1",
    title: "V1",
    wikiPath: "wiki/x/doc.md",
  });

  await service.overwrite({
    ref: makeRef({ entities: [{ name: "CALEO", type: "org", description: "v2" }] }),
    documentId: "doc-1",
    title: "V2",
    wikiPath: "wiki/x/doc.md",
  });

  const caleo = g.ent("CALEO")!;
  assert.deepEqual(caleo.sourceDocs, ["doc-1"], "retained entity re-appended exactly once");
  assert.deepEqual(caleo.wikiPaths, ["wiki/x/doc.md"]);
  assert.ok(!g.ent("STALE"), "stale entity lost its protection entry AND the sweep removed it (no edges left)");

  // The overwrite issued the strip BEFORE the entity writes, and its final
  // sweep carries the empty-source_docs guard.
  const stripIdx = g.queries.findIndex(
    (c) => c.query.includes("source_docs") && c.query.includes("WHERE x <> $documentId"),
  );
  const entityWriteIdx = g.queries.findIndex(
    (c, i) =>
      i > stripIdx &&
      c.query.includes("{name: $name}") &&
      c.query.includes("source_docs"),
  );
  const sweepIdx = g.queries.findIndex(
    (c, i) => i > entityWriteIdx && c.query.includes("NOT (e)--()") && c.query.includes("size(e.source_docs) = 0"),
  );
  assert.ok(stripIdx >= 0, "strip query issued");
  assert.ok(entityWriteIdx > stripIdx, "strip runs BEFORE the fresh entity writes");
  assert.ok(sweepIdx > entityWriteIdx, "final sweep guards on empty provenance");
});
