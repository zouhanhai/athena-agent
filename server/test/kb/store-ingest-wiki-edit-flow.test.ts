import { test } from "node:test";
import assert from "node:assert/strict";
import type { RefineOutputRef } from "../../src/agents/refine-output.js";
import {
  CHUNK_LABEL,
  DOCUMENT_LABEL,
  ENTITY_LABEL,
  ENTITY_RELATION_TYPE,
  MENTIONED_IN_TYPE,
  WIKIPAGE_LABEL,
  type Neo4jDriverLike,
} from "../../src/kb/store/schema.js";
import { Neo4jIngestService } from "../../src/kb/store/ingest.js";
import { IngestTaskQueue } from "../../src/kb/tasks.js";

/**
 * G4.S8.T20 — targeted tests for the CANONICAL wiki-edit flow at the Neo4j seam:
 *   ② overwrite() incremental: ONLY the changed chunk re-embeds (mock embedder counts calls);
 *   ③ stale-drop cross-document safety: a shared entity mentioned by another doc's
 *     chunk is NOT dropped (whole-graph MENTIONED_IN predicate);
 *   ④ wiki-save end-to-end fixture: entities/relations/chunks updated, mention edges
 *     rebuilt (incl. consistency-created endpoints), only diff-affected chunk embedded.
 */

const upper = (name: string): string => name.toUpperCase();

interface ExistingChunkRow {
  id: string;
  text: string;
  context?: string | null;
  hasEmbedding: boolean;
}

interface RelationEdge {
  source: string;
  target: string;
}

/**
 * Stateful driver double: it models just enough Neo4j semantics to evaluate the
 * overwrite()'s graph outcomes (endpoint existence, MENTIONED_IN counts,
 * stale-relation drop, orphan-entity drop) without a real database. Every
 * issued query is recorded for structural assertions.
 */
function makeGraphDriver(opts: {
  /** Document id answered by the WikiPage→IS_DOCUMENT bridge (undefined = no prior doc). */
  wikiDocId?: string;
  existingChunks?: ExistingChunkRow[];
  /** Entities that already exist in the graph (folded nameUpper set). */
  knownUpper?: Set<string>;
  /** Pre-existing MENTIONED_IN edge counts per entity (cross-document mentions). */
  baselineMentions?: Record<string, number>;
  /** Pre-existing RELATION edges between FOLDED entity names. */
  relations?: RelationEdge[];
}) {
  const calls: Array<{ query: string; params?: Record<string, unknown> }> = [];
  const knownUpper = new Set([...(opts.knownUpper ?? [])]);
  const mentions = new Map<string, number>();
  for (const [name, count] of Object.entries(opts.baselineMentions ?? {})) {
    mentions.set(upper(name), count);
  }
  let relations: RelationEdge[] = [...(opts.relations ?? [])];
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
                get: (key: string) => {
                  if (key === "id") return row.id;
                  if (key === "text") return row.text;
                  if (key === "context") return row.context ?? null;
                  if (key === "hasEmbedding") return row.hasEmbedding;
                  return null;
                },
              })),
            };
          }
          // writeRelations step 1b: which endpoint nameUppers exist?
          if (query.includes("UNWIND $names") && query.includes("nameUpper: name")) {
            const names = ((params!.names as string[]) ?? []).filter((n) => knownUpper.has(n));
            return { records: names.map((n) => ({ get: (key: string) => (key === "name" ? n : null) })) };
          }
          // writeRelations step 1c: MERGE-create missing endpoints
          if (query.startsWith(`MERGE (e:${ENTITY_LABEL} {nameUpper`) && query.includes("ON CREATE")) {
            const key = String(params!.nameUpper);
            knownUpper.add(key);
            return { records: [] };
          }
          // Entity upsert (MERGE {name: $name}) — entity exists afterwards
          if (query.startsWith("MERGE") && query.includes("{name: $name}") && params?.name) {
            knownUpper.add(upper(String(params.name)));
            return { records: [] };
          }
          // MENTIONED_IN rebuild: track the new mention edges per entity
          if (query.includes(MENTIONED_IN_TYPE) && query.includes("$mentions")) {
            for (const m of (params!.mentions as Array<{ entityName: string }>) ?? []) {
              const key = upper(m.entityName);
              mentions.set(key, (mentions.get(key) ?? 0) + 1);
            }
            return { records: [] };
          }
          // Stale-relation cleanup: DELETE r WHERE NEITHER endpoint is mentioned ANYWHERE
          if (query.includes("DELETE r") && query.includes("NOT (a)")) {
            const before = relations.length;
            relations = relations.filter(
              (r) => (mentions.get(r.source) ?? 0) > 0 || (mentions.get(r.target) ?? 0) > 0,
            );
            return { records: [] , removed: before - relations.length };
          }
          // Orphan-entity cleanup: NOT (e)--() → no relation AND no mention left
          if (query.includes("NOT (e)--()")) {
            for (const key of [...knownUpper]) {
              const hasRelation = relations.some((r) => r.source === key || r.target === key);
              if (!hasRelation && (mentions.get(key) ?? 0) === 0) {
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

  return { driver, calls, mentions, deletedEntities, relationsLeft: () => relations, knownUpper };
}

function makeRef(overrides: Partial<RefineOutputRef> = {}): RefineOutputRef {
  return {
    md_ref: "/storage/luesen/markdown.md",
    chunks_ref: "/storage/luesen/chunks.json",
    preview: "preview",
    char_count: 100,
    line_count: 10,
    header_count: 3,
    chunk_count: 3,
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

// --- ② overwrite(): ONLY the changed chunk re-embeds ---

test("overwrite embeds ONLY the changed chunk — unchanged chunks keep their embedding (mock embedder counted)", async () => {
  const { driver, calls } = makeGraphDriver({
    wikiDocId: "doc",
    existingChunks: [
      { id: "doc:c1", text: "# Overview\n\nunchanged body", hasEmbedding: true },
      { id: "doc:c2", text: "# Agenda\n\nOLD agenda text", hasEmbedding: true },
      // Same text but NO stored embedding → must be treated as changed (re-embedded).
      { id: "doc:c3", text: "# Tips\n\nbring water", hasEmbedding: false },
    ],
  });
  const embedCalls: string[][] = [];
  const service = new Neo4jIngestService({
    driver,
    embedder: {
      embed: async (texts) => {
        embedCalls.push(texts);
        return texts.map(() => [0.1, 0.2]);
      },
    },
    readChunks: async () => [
      { id: "c1", text: "# Overview\n\nunchanged body", heading_path: "Overview" },
      { id: "c2", text: "# Agenda\n\nCORRECTED agenda text", heading_path: "Agenda" },
      { id: "c3", text: "# Tips\n\nbring water", heading_path: "Tips" },
    ],
  });

  const result = await service.overwrite({ ref: makeRef(), documentId: "derived-id", title: "Lüsen", wikiPath: "wiki/events/luesen.md" });

  assert.equal(result.documentId, "doc");
  assert.deepEqual(
    embedCalls,
    [["# Agenda\n\nCORRECTED agenda text", "# Tips\n\nbring water"]],
    "exactly ONE embed call carrying EXACTLY the changed/un-embedded chunks — the unchanged chunk is never re-embedded",
  );

  const chunkWrites = new Map(
    calls
      .filter((c) => c.query.startsWith(`MERGE (c:${CHUNK_LABEL}`))
      .map((c) => [String(c.params!.id), c]),
  );
  assert.equal(chunkWrites.size, 3, "all three chunks are still written");
  const unchangedWrite = chunkWrites.get("doc:c1")!;
  assert.ok(!unchangedWrite.query.includes("$embedding"), "unchunk-changed write does not touch the embedding");
  assert.equal(unchangedWrite.params!.embedding, undefined);
  const changedWrite = chunkWrites.get("doc:c2")!;
  assert.ok(changedWrite.query.includes("$embedding"), "changed chunk write sets a fresh embedding");
  assert.deepEqual(changedWrite.params!.embedding, [0.1, 0.2]);
});

// --- ②b G4.S8.T21: overwrite() persists Document.last_edit_ref (wiki-edit dir) ---

test("overwrite persists last_edit_ref pointing at the wiki-edit refinement dir; md_ref stays untouched", async () => {
  const { driver, calls } = makeGraphDriver({ wikiDocId: "doc" });
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [0.1, 0.2]) },
    readChunks: async () => [{ id: "c1", text: "Corrected body.", heading_path: "Overview" }],
  });

  await service.overwrite({
    ref: makeRef({ md_ref: "/storage/wiki-edit-luesen/markdown.md" }),
    documentId: "derived-id",
    title: "Lüsen",
    wikiPath: "wiki/events/luesen.md",
  });

  const docMerge = calls.find((c) => c.query.startsWith(`MERGE (d:${DOCUMENT_LABEL}`))!;
  assert.ok(docMerge.query.includes("d.last_edit_ref = $lastEditRef"), "the wiki-edit ref dir is persisted");
  assert.equal(docMerge.params!.lastEditRef, "/storage/wiki-edit-luesen/markdown.md");
  assert.ok(docMerge.query.includes("COALESCE(d.md_ref"), "the T18 md_ref COALESCE protection stays intact");
});

// --- ③ stale-drop cross-document safety ---

test("overwrite stale-drop keeps a shared entity that another document's chunks still mention", async () => {
  // Cross-document state: Hotel Bellevue is STILL mentioned by another document's
  // chunk; Ghost Spa / Ghost Bar are mentioned nowhere anymore.
  const { driver, calls, relationsLeft, deletedEntities, knownUpper } = makeGraphDriver({
    wikiDocId: "doc",
    knownUpper: new Set(["HOTEL BELLEVUE", "GHOST SPA", "GHOST BAR"]),
    baselineMentions: { "Hotel Bellevue": 1 },
    relations: [
      { source: "HOTEL BELLEVUE", target: "GHOST SPA" },
      { source: "GHOST SPA", target: "GHOST BAR" },
    ],
  });
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [1]) },
    readChunks: async () => [{ id: "c1", text: "Hotel Bellevue hosts the seminar.", heading_path: "# Venue" }],
  });

  // The edit's delta no longer mentions any ghost entity; only Bellevue survives.
  await service.overwrite({
    ref: makeRef({ entities: [{ name: "Hotel Bellevue", type: "place", description: "venue" }] }),
    documentId: "doc",
    title: "Lüsen",
    wikiPath: "wiki/events/luesen.md",
  });

  assert.ok(
    relationsLeft().some((r) => r.source === "HOTEL BELLEVUE" && r.target === "GHOST SPA"),
    "the relation touching the cross-document-mentioned entity survives the stale-drop",
  );
  assert.ok(
    !relationsLeft().some((r) => r.source === "GHOST SPA" && r.target === "GHOST BAR"),
    "relations between entities mentioned NOWHERE are dropped",
  );
  assert.ok(deletedEntities.has("GHOST BAR"), "the fully orphaned entity is deleted");
  assert.ok(!deletedEntities.has("HOTEL BELLEVUE"), "the shared entity is NOT dropped");
  assert.ok(!deletedEntities.has("GHOST SPA"), "the neighbor of a shared entity keeps its surviving edge");

  // The whole-graph predicate is the safety mechanism: no documentId scoping.
  const staleRelationCleanup = calls.find((c) => c.query.includes("DELETE r") && c.query.includes("NOT (a)"));
  assert.ok(staleRelationCleanup, "stale-relation cleanup issued");
  assert.match(
    staleRelationCleanup!.query,
    /NOT \(a\)-\[:MENTIONED_IN\]->\(:Chunk\)/,
    "predicate checks the WHOLE graph for mentions, not just this document",
  );
  assert.equal(
    staleRelationCleanup!.params?.documentId,
    undefined,
    "cleanup is NOT scoped to the edited document (cross-document safe)",
  );
});

// --- G4.S8.T20 flow-correctness guards ---

test("overwrite REBUILDS mention edges: stale MENTIONED_IN on surviving chunks is pruned before the fresh pairs land", async () => {
  const { driver, calls } = makeGraphDriver({
    wikiDocId: "doc",
    knownUpper: new Set(["GHOST SPA"]),
    existingChunks: [{ id: "doc:c1", text: "# Venue\n\nold text", hasEmbedding: true }],
  });
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [1]) },
    readChunks: async () => [{ id: "c1", text: "# Venue\n\nHotel Bellevue replaces the old venue.", heading_path: "Venue" }],
  });

  await service.overwrite({
    ref: makeRef({ entities: [{ name: "Hotel Bellevue", type: "place", description: "new venue" }] }),
    documentId: "doc",
    title: "Lüsen",
    wikiPath: "wiki/events/luesen.md",
  });

  const pruneIdx = calls.findIndex((c) => c.query.includes("DELETE r") && c.query.includes("<-[r:"));
  assert.ok(pruneIdx !== -1, "stale-mention prune issued for the surviving chunks");
  assert.match(calls[pruneIdx]!.query, /MENTIONED_IN/, "prune targets MENTIONED_IN edges");
  assert.equal(calls[pruneIdx]!.params!.documentId, "doc", "prune scoped to THIS document (cross-doc safe)");
  const mergeIdx = calls.findIndex((c) => c.query.includes("$mentions") && c.query.includes("MENTIONED_IN"));
  assert.ok(mergeIdx !== -1 && pruneIdx < mergeIdx, "prune runs BEFORE the fresh mention pairs are merged");
});

test("overwrite refuses to wipe the stored chunk subtree when the refinement yields ZERO chunks (0-chunks wipe guard)", async () => {
  const { driver, calls } = makeGraphDriver({
    wikiDocId: "doc",
    existingChunks: [
      { id: "doc:c1", text: "# Overview\n\nkept", hasEmbedding: true },
      { id: "doc:c2", text: "# Agenda\n\nkept too", hasEmbedding: true },
    ],
  });
  const service = new Neo4jIngestService({
    driver,
    embedder: { embed: async (texts) => texts.map(() => [1]) },
    readChunks: async () => [],
  });

  const result = await service.overwrite({ ref: makeRef(), documentId: "derived-id", title: "Lüsen", wikiPath: "wiki/events/luesen.md" });

  assert.equal(result.chunksStored, 0);
  assert.equal(result.documentId, "doc");
  assert.ok(
    !calls.some((c) => c.query.includes("WHERE NOT c.id IN $ids")),
    "NO stale-chunk DETACH DELETE with an empty keep-list (the live Lüsen wipe)",
  );
  assert.ok(!calls.some((c) => c.query.includes("DETACH DELETE s")), "sections kept too (their chunks survive)");
});


const BEFORE_RAG = ["# Overview", "", "The Lüsen week.", "", "# Agenda", "", "Monday arrival.", "", "# Tips", "", "Bring water."].join("\n");
const AFTER_RAG = ["# Overview", "", "The Lüsen week.", "", "# Agenda", "", "Tuesday hike CHANGED — stay at Hotel Bellevue.", "", "# Tips", "", "Bring water."].join("\n");

/** Aligned chunks as refiner.ts would produce them from prior chunks + alignChunksToMarkdown. */
const ALIGNED_CHUNKS = [
  { id: "c1", text: "# Overview\n\nThe Lüsen week.", heading_path: "Overview" },
  { id: "c2", text: "# Agenda\n\nTuesday hike CHANGED — stay at Hotel Bellevue.", heading_path: "Agenda" },
  { id: "c3", text: "# Tips\n\nBring water.", heading_path: "Tips" },
];

test("wiki-save end-to-end: overwrite updates chunks/entities/relations, rebuilds mentions, embeds only the edited section", async () => {
  const { driver, calls } = makeGraphDriver({
    wikiDocId: "doc-luesen",
    existingChunks: [
      { id: "doc-luesen:c1", text: ALIGNED_CHUNKS[0]!.text, hasEmbedding: true },
      { id: "doc-luesen:c2", text: "# Agenda\n\nMonday arrival.", hasEmbedding: true },
      { id: "doc-luesen:c3", text: ALIGNED_CHUNKS[2]!.text, hasEmbedding: true },
    ],
    knownUpper: new Set(["LÜSEN"]),
  });
  const embedCalls: string[][] = [];
  const neo4j = new Neo4jIngestService({
    driver,
    embedder: {
      embed: async (texts) => {
        embedCalls.push(texts);
        return texts.map(() => [0.5]);
      },
    },
    readChunks: async () => ALIGNED_CHUNKS,
  });

  const wikiRefiner = async () => ({
    // Delta contract: markdown pinned from input.markdown; extraction fields only.
    ref: makeRef({
      entities: [{ name: "Lüsen", type: "place", description: "village in South Tyrol" }],
      // The correction introduces a NEW relation whose source endpoint does not
      // exist yet — writeRelations must create it and route its mention links.
      relations: [
        { source: "Hotel Bellevue", target: "Lüsen", keywords: ["located in"], description: "hotel in Lüsen" },
      ],
    }),
    markdown: AFTER_RAG,
    newEntities: [{ name: "Hotel Bellevue", type: "place", description: "hotel in Lüsen" }],
    newRelations: [
      { source: "Hotel Bellevue", target: "Lüsen", keywords: ["located in"], description: "hotel in Lüsen" },
    ],
    rechunked: false,
  });

  const queue = new IngestTaskQueue({
    parser: {
      async parse() {
        throw new Error("wiki save must not parse");
      },
    } as never,
    ingest: {} as never,
    wikiRefiner,
    neo4j,
  });

  const { taskId } = queue.submitWikiSave({
    path: "wiki/events/luesen.md",
    beforeRag: BEFORE_RAG,
    afterRag: AFTER_RAG,
    diff: "-Monday arrival.\n+Tuesday hike CHANGED — stay at Hotel Bellevue.",
    structural: false,
  });

  const deadline = Date.now() + 4000;
  let task = queue.getTask(taskId)!;
  while (task.status !== "done" && task.status !== "failed" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
    task = queue.getTask(taskId)!;
  }

  assert.equal(task.status, "done", `task should finish cleanly (error: ${task.error ?? "none"})`);
  assert.equal(task.stages.refinement.status, "done");
  assert.equal(task.stages.ingesting_neo4j.status, "done");
  assert.equal(task.neo4jStored, true, "the overwrite really stored");
  assert.equal(task.documentId, "doc-luesen", "the OLD document id is reused via the wikiPath bridge");

  // 5a: MERGE Document keeping the ORIGINAL md_ref + rebridging WikiPage.
  const docMerge = calls.find(
    (c) => c.query.startsWith(`MERGE (d:${DOCUMENT_LABEL}`) && !c.query.includes("UNWIND"),
  );
  assert.ok(docMerge, "Document MERGE issued");
  assert.match(docMerge!.query, /d\.md_ref = COALESCE\(d\.md_ref, \$mdRef\)/, "md_ref stays pinned to the original refine dir");
  const wpMerge = calls.find((c) => c.query.includes(`MERGE (wp:${WIKIPAGE_LABEL}`));
  assert.ok(wpMerge?.query.includes("IS_DOCUMENT"), "Document→WikiPage bridge rewritten");

  // 5b: stale chunks outside the new id set deleted; sections rewritten.
  const staleDelete = calls.find((c) => c.query.includes("WHERE NOT c.id IN $ids"));
  assert.deepEqual(
    staleDelete!.params!.ids,
    ["doc-luesen:c1", "doc-luesen:c2", "doc-luesen:c3"],
    "keep-list carries the aligned, namespaced chunk ids",
  );
  assert.ok(calls.some((c) => c.query.includes("DETACH DELETE s")), "sections rewritten");

  // 5c: only the diff-affected chunk re-embeds; all three chunks written.
  assert.deepEqual(
    embedCalls,
    [["# Agenda\n\nTuesday hike CHANGED — stay at Hotel Bellevue."]],
    "ONLY the edited section is embedded",
  );
  const chunkWrites = new Map(
    calls
      .filter((c) => c.query.startsWith(`MERGE (c:${CHUNK_LABEL}`))
      .map((c) => [String(c.params!.id), c]),
  );
  assert.equal(chunkWrites.size, 3);
  assert.equal(chunkWrites.get("doc-luesen:c1")!.params!.embedding, undefined, "unchanged chunk keeps its embedding");
  assert.deepEqual(chunkWrites.get("doc-luesen:c2")!.params!.embedding, [0.5], "edited chunk gets the fresh embedding");

  // 5d: entities merged; the new relation lands via a consistency-created endpoint…
  const relationMerge = calls.find((c) => c.query.includes(`MERGE (a)-[r:${ENTITY_RELATION_TYPE}]`));
  assert.ok(relationMerge, "relation MERGE issued");
  assert.equal(relationMerge!.params!.sourceUpper, "HOTEL BELLEVUE");
  assert.equal(relationMerge!.params!.targetUpper, "LÜSEN");
  const createdEndpoint = calls.find(
    (c) => c.query.includes("ON CREATE") && c.params?.nameUpper === "HOTEL BELLEVUE",
  );
  assert.ok(createdEndpoint, "missing relation endpoint MERGE-created (consistency layer)");

  // …and MENTIONED_IN edges are rebuilt from the NEW chunks, including the
  // created endpoint's mention in the edited chunk.
  const mentionQuery = calls.find((c) => c.query.includes(`:${MENTIONED_IN_TYPE}`) && c.query.includes("$mentions"));
  assert.ok(mentionQuery, "mention rebuild issued");
  const pairs = (mentionQuery!.params!.mentions as Array<{ entityName: string; chunkId: string }>).sort(
    (a, b) => a.entityName.localeCompare(b.entityName) || a.chunkId.localeCompare(b.chunkId),
  );
  assert.deepEqual(pairs, [
    { entityName: "Hotel Bellevue", chunkId: "doc-luesen:c2" },
    { entityName: "Lüsen", chunkId: "doc-luesen:c1" },
  ], "mention edges recomputed against the corrected chunk texts (Lüsen only survives in c1; the created endpoint links its new chunk)");
});
