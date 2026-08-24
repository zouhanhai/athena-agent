/**
 * G4.S10.T4 — the Neo4j overwrite applies wiki-edit baseline RENAMES IN PLACE.
 *
 * Live incident (2026-08-24): a one-word image-description edit
 * (GALILEO Office → CALEO Office) re-ran full extraction; the refine dropped
 * the office entity, the overwrite cleaned its provenance/mention edges and
 * the orphan sweep deleted it — while CALEO Office never existed. With the
 * delta-grounded pipeline the resolved refinement carries the FULL baseline
 * set plus `entity_renames`, and overwrite() renames the EXISTING graph node
 * BEFORE stripping/re-appending provenance, so source_docs, MENTIONED_IN
 * edges and relations survive the edit untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RefineOutputRef } from "../../src/agents/refine-output.js";
import {
  ENTITY_LABEL,
  type Neo4jDriverLike,
} from "../../src/kb/store/schema.js";
import { Neo4jIngestService } from "../../src/kb/store/ingest.js";

const upper = (name: string): string => name.toUpperCase();

interface ExistingChunkRow {
  id: string;
  text: string;
  context?: string | null;
  hasEmbedding: boolean;
}

/**
 * Stateful driver double modeling enough Neo4j semantics for the rename flow:
 * entity identities (folded names), MENTIONED_IN counts, RELATION edges and
 * per-entity source_docs lists. Every issued query is recorded for structural
 * assertions (ordering: renames BEFORE the provenance strip).
 */
function makeRenameGraphDriver(opts: {
  wikiDocId?: string;
  existingChunks?: ExistingChunkRow[];
  /** Entity nodes that exist (folded nameUpper). */
  knownUpper?: Set<string>;
  /** MENTIONED_IN edge counts per folded entity name (whole-graph state). */
  mentions?: Record<string, number>;
  /** Per-entity source_docs lists (provenance). */
  sourceDocs?: Record<string, string[]>;
  /** RELATION edges between FOLDED entity names. */
  relations?: Array<{ source: string; target: string }>;
}) {
  const calls: Array<{ query: string; params?: Record<string, unknown> }> = [];
  const knownUpper = new Set([...(opts.knownUpper ?? [])]);
  const mentions = new Map<string, number>();
  for (const [name, count] of Object.entries(opts.mentions ?? {})) mentions.set(upper(name), count);
  const sourceDocs = new Map<string, string[]>();
  for (const [name, docs] of Object.entries(opts.sourceDocs ?? {})) sourceDocs.set(upper(name), [...docs]);
  let relations = [...(opts.relations ?? [])];
  const deletedEntities = new Set<string>();

  const driver: Neo4jDriverLike = {
    session() {
      return {
        run: async (query: string, params?: Record<string, unknown>) => {
          calls.push({ query, params });

          // resolveDocumentId: WikiPage ←IS_DOCUMENT— Document
          if (query.includes("IS_DOCUMENT") && query.includes("RETURN d.id")) {
            if (!opts.wikiDocId) return { records: [] };
            return { records: [{ get: (key: string) => (key === "id" ? opts.wikiDocId : null) }] };
          }
          // loadExistingChunks
          if (query.includes("c.embedding IS NOT NULL")) {
            return {
              records: (opts.existingChunks ?? []).map((row) => ({
                get: (key: string) =>
                  key === "id" ? row.id : key === "text" ? row.text : key === "context" ? (row.context ?? null) : row.hasEmbedding,
              })),
            };
          }
          // G4.S10.T4 APPLY_ENTITY_RENAMES: move identity in place unless the
          // target identity already exists on ANOTHER node (merge-onto-existing
          // guard — then the regular entity write converges onto the target).
          if (query.includes("UNWIND $renames") && query.includes("nameUpper: r.fromUpper")) {
            for (const r of (params!.renames as Array<{ fromUpper: string; toUpper: string }>) ?? []) {
              if (!knownUpper.has(r.fromUpper)) continue; // idempotent: already renamed
              if (knownUpper.has(r.toUpper)) continue; // guard: target exists → no in-place rename
              knownUpper.delete(r.fromUpper);
              knownUpper.add(r.toUpper);
              const m = mentions.get(r.fromUpper);
              if (m !== undefined) {
                mentions.delete(r.fromUpper);
                mentions.set(r.toUpper, m);
              }
              const docs = sourceDocs.get(r.fromUpper);
              if (docs) {
                sourceDocs.delete(r.fromUpper);
                sourceDocs.set(r.toUpper, docs);
              }
              relations = relations.map((rel) => ({
                source: rel.source === r.fromUpper ? r.toUpper : rel.source,
                target: rel.target === r.fromUpper ? r.toUpper : rel.target,
              }));
            }
            return { records: [] };
          }
          // writeRelations step 1b: which endpoint nameUppers exist?
          if (query.includes("UNWIND $names") && query.includes("nameUpper: name")) {
            const names = ((params!.names as string[]) ?? []).filter((n) => knownUpper.has(n));
            return { records: names.map((n) => ({ get: (key: string) => (key === "name" ? n : null) })) };
          }
          // writeRelations step 1c: MERGE-create missing endpoints
          if (query.startsWith(`MERGE (e:${ENTITY_LABEL} {nameUpper`) && query.includes("ON CREATE")) {
            knownUpper.add(String(params!.nameUpper));
            sourceDocs.set(String(params!.nameUpper), []);
            return { records: [] };
          }
          // Provenance strip: remove THIS document's id/wikiPath everywhere.
          if (query.includes("WHERE $documentId IN coalesce(e.source_docs") || query.includes("$wikiPath IN coalesce(e.wiki_paths")) {
            for (const [key] of mentions) {
              const docs = (sourceDocs.get(key) ?? []).filter((d) => d !== params!.documentId);
              sourceDocs.set(key, docs);
            }
            return { records: [] };
          }
          // Entity upsert (MERGE {name: $name}) — appends provenance + aliases.
          if (query.startsWith("MERGE") && query.includes("{name: $name}") && params?.name) {
            const key = upper(String(params.name));
            knownUpper.add(key);
            const docs = new Set(sourceDocs.get(key) ?? []);
            docs.add(String(params.documentId));
            sourceDocs.set(key, [...docs]);
            return { records: [] };
          }
          // MENTIONED_IN rebuild: track fresh mention edges per entity.
          if (query.includes("MENTIONED_IN") && query.includes("$mentions")) {
            for (const m of (params!.mentions as Array<{ entityName: string }>) ?? []) {
              const key = upper(m.entityName);
              mentions.set(key, (mentions.get(key) ?? 0) + 1);
            }
            return { records: [] };
          }
          // Stale-relation cleanup: drop edges where NEITHER endpoint is mentioned anywhere.
          if (query.includes("DELETE r") && query.includes("NOT (a)")) {
            relations = relations.filter(
              (r) => (mentions.get(r.source) ?? 0) > 0 || (mentions.get(r.target) ?? 0) > 0,
            );
            return { records: [], removed: 0 };
          }
          // Orphan-entity cleanup: unreferenced AND unprovenanced entities die.
          if (query.includes("NOT (e)--()")) {
            for (const key of [...knownUpper]) {
              const hasRelation = relations.some((r) => r.source === key || r.target === key);
              const hasMention = (mentions.get(key) ?? 0) > 0;
              const hasProvenance = (sourceDocs.get(key) ?? []).length > 0;
              if (!hasRelation && !hasMention && !hasProvenance) {
                knownUpper.delete(key);
                deletedEntities.add(key);
              }
            }
            return { records: [] };
          }
          return { records: [] };
        },
        close: async () => {},
      };
    },
  };

  return {
    driver,
    calls,
    mentions,
    sourceDocs,
    deletedEntities,
    knownUpper,
    relationsLeft: () => relations,
    renameCalls: () => calls.filter((c) => c.query.includes("UNWIND $renames")),
    stripIndex: () => calls.findIndex((c) => c.query.includes("coalesce(e.source_docs")),
    entityWriteIndex: (foldedName: string) =>
      calls.findIndex((c) => c.query.startsWith("MERGE") && c.query.includes("{name: $name}") && upper(String(c.params?.name ?? "")) === foldedName),
  };
}

function makeRef(overrides: Partial<RefineOutputRef> = {}): RefineOutputRef {
  return {
    md_ref: "/storage/luesen/markdown.md",
    chunks_ref: "/storage/luesen/chunks.json",
    preview: "preview",
    char_count: 100,
    line_count: 10,
    header_count: 3,
    chunk_count: 1,
    frontmatter: { type: "report", topic: "client/events" },
    entities: [],
    relations: [],
    keywords: ["lüsen"],
    quality: { complete: true, confidence: 0.95, issues: [], action: "auto_accept" },
    summary: "Lüsen seminar page.",
    sections: [],
    mode: "single",
    section_paths: [],
    ...overrides,
  };
}

const CHUNKS = [{ id: "c1", text: "# Venue\n\nThe image shows the CALEO Office.", heading_path: "Venue" }];

test("GALILEO Office regression: an in-place rename RETAINS source_docs, MENTIONED_IN and relations", async () => {
  const graph = makeRenameGraphDriver({
    wikiDocId: "doc-luesen",
    existingChunks: [{ id: "doc-luesen:c1", text: "# Venue\n\nThe image shows GALILEO Office.", hasEmbedding: true }],
    knownUpper: new Set(["GALILEO OFFICE", "LÜSEN"]),
    mentions: { "GALILEO Office": 2, "Lüsen": 3 },
    sourceDocs: { "GALILEO Office": ["doc-luesen"], "Lüsen": ["doc-luesen"] },
    relations: [{ source: "GALILEO OFFICE", target: "LÜSEN" }],
  });
  const service = new Neo4jIngestService({
    driver: graph.driver,
    embedder: { embed: async (texts) => texts.map(() => [1]) },
    readChunks: async () => CHUNKS,
  });

  // The RESOLVED delta-refine output: full baseline set (Lüsen kept), the
  // renamed entity under its NEW name with the old name as alias, and the
  // applied renames transported for the graph-side rename.
  await service.overwrite({
    ref: makeRef({
      entities: [
        { name: "CALEO Office", type: "location", description: "Office at Galileostraße.", aliases: ["GALILEO Office"] },
        { name: "Lüsen", type: "location", description: "Village in South Tyrol." },
      ],
      relations: [
        { source: "CALEO Office", target: "Lüsen", keywords: ["located in"], description: "office location" },
      ],
      entity_renames: [{ from: "GALILEO Office", to: "CALEO Office" }],
    }),
    documentId: "doc-luesen",
    title: "Lüsen",
    wikiPath: "wiki/events/luesen.md",
  });

  // The rename ran against the OLD folded identity, targeting the NEW one…
  const rename = graph.renameCalls()[0];
  assert.ok(rename, "rename application issued");
  const renameRows = rename!.params!.renames as Array<{ from: string; to: string; fromUpper: string; toUpper: string }>;
  assert.deepEqual(renameRows, [
    { from: "GALILEO Office", to: "CALEO Office", fromUpper: "GALILEO OFFICE", toUpper: "CALEO OFFICE" },
  ]);
  // …BEFORE the provenance strip (order matters: strip must not see stale identity).
  const renameIdx = graph.calls.findIndex((c) => c.query.includes("UNWIND $renames"));
  const stripIdx = graph.stripIndex();
  assert.ok(stripIdx !== -1 && renameIdx < stripIdx, "renames applied BEFORE the provenance strip");

  // End state: ONE node carrying the new name with EVERYTHING preserved.
  assert.ok(graph.knownUpper.has("CALEO OFFICE"), "node renamed in place");
  assert.ok(!graph.knownUpper.has("GALILEO OFFICE"), "old identity gone");
  assert.ok(!graph.deletedEntities.has("CALEO OFFICE"), "the renamed node was NOT orphan-swept");
  assert.ok(
    (graph.mentions.get("CALEO OFFICE") ?? 0) >= 1,
    "MENTIONED_IN survived the rename (rebuild merged onto the same node)",
  );
  assert.ok(
    (graph.sourceDocs.get("CALEO OFFICE") ?? []).includes("doc-luesen"),
    "this document's provenance re-appended onto the renamed node",
  );
  assert.ok(
    graph.relationsLeft().some((r) => r.source === "CALEO OFFICE" && r.target === "LÜSEN"),
    "relations survive (redirected endpoints, same nodes)",
  );
  assert.ok(!graph.deletedEntities.has("LÜSEN"), "the unchanged baseline entity keeps its node");
  assert.ok(
    (graph.mentions.get("LÜSEN") ?? 0) >= 3,
    "unchanged baseline entity keeps its accumulated mention count",
  );
});

test("rename onto an EXISTING identity is guarded: no duplicate node — writes converge on the existing one", async () => {
  // CALEO Office ALREADY exists (another document created it): the in-place
  // rename must skip; the entity write then lands on the existing node while
  // the stale GALILEO node loses only THIS document's traces.
  const graph = makeRenameGraphDriver({
    wikiDocId: "doc-luesen",
    knownUpper: new Set(["GALILEO OFFICE", "CALEO OFFICE"]),
    mentions: { "GALILEO Office": 1, "CALEO Office": 2 },
    sourceDocs: { "GALILEO Office": ["doc-luesen"], "CALEO Office": ["doc-other"] },
  });
  const service = new Neo4jIngestService({
    driver: graph.driver,
    embedder: { embed: async (texts) => texts.map(() => [1]) },
    readChunks: async () => CHUNKS,
  });

  await service.overwrite({
    ref: makeRef({
      entities: [{ name: "CALEO Office", type: "org", description: "existing canonical node", aliases: ["GALILEO Office"] }],
      entity_renames: [{ from: "GALILEO Office", to: "CALEO Office" }],
    }),
    documentId: "doc-luesen",
    title: "Lüsen",
    wikiPath: "wiki/events/luesen.md",
  });

  assert.equal(graph.renameCalls().length, 1, "rename attempt issued (guard lives in the Cypher)");
  assert.equal(
    [...graph.knownUpper].filter((k) => k === "CALEO OFFICE").length,
    1,
    "still exactly ONE CALEO Office node",
  );
  assert.ok(
    (graph.sourceDocs.get("CALEO OFFICE") ?? []).includes("doc-luesen"),
    "the edited document's provenance joined the existing canonical node",
  );
  assert.ok(
    (graph.sourceDocs.get("CALEO OFFICE") ?? []).includes("doc-other"),
    "the other document's provenance is untouched",
  );
});

test("an overwrite WITHOUT renames never issues the rename pass (no-op stays byte-identical)", async () => {
  const graph = makeRenameGraphDriver({ wikiDocId: "doc-luesen" });
  const service = new Neo4jIngestService({
    driver: graph.driver,
    embedder: { embed: async (texts) => texts.map(() => [1]) },
    readChunks: async () => CHUNKS,
  });
  await service.overwrite({
    ref: makeRef(),
    documentId: "doc-luesen",
    title: "Lüsen",
    wikiPath: "wiki/events/luesen.md",
  });
  assert.equal(graph.renameCalls().length, 0);
});
