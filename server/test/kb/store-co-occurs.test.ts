import { test } from "node:test";
import assert from "node:assert/strict";
import type { RefineOutputRef } from "../../src/agents/refine-output.js";
import {
  Neo4jIngestService,
  coOccurrencePairs,
} from "../../src/kb/store/ingest.js";
import {
  COMMUNITY_LABEL,
  ENTITY_LABEL,
  ENTITY_RELATION_TYPE,
  foldName,
  type Neo4jDriverLike,
} from "../../src/kb/store/schema.js";
import { Neo4jCommunityService, communityIdForMembers } from "../../src/kb/store/community.js";

// ---------------------------------------------------------------------------
// A. Pure helper: capped co-occurrence pairs from the mention scan
// ---------------------------------------------------------------------------

test("coOccurrencePairs pairs entities sharing a chunk and accumulates weight across chunks", () => {
  const pairs = coOccurrencePairs([
    { entityName: "CALEO", chunkId: "doc:c1" },
    { entityName: "ZOB München", chunkId: "doc:c1" },
    { entityName: "CALEO", chunkId: "doc:c2" },
    { entityName: "ZOB München", chunkId: "doc:c2" },
    { entityName: "Lüsen", chunkId: "doc:c2" },
  ]);
  assert.deepEqual(pairs, [
    { source: "CALEO", target: "LÜSEN", weight: 1 },
    { source: "CALEO", target: "ZOB MÜNCHEN", weight: 2 },
    { source: "LÜSEN", target: "ZOB MÜNCHEN", weight: 1 },
  ]);
});

test("coOccurrencePairs folds casing, dedupes identical names and never emits self-pairs", () => {
  const pairs = coOccurrencePairs([
    { entityName: "CALEO", chunkId: "d:c1" },
    { entityName: "caleo", chunkId: "d:c1" }, // same folded name → one node
    { entityName: "Sommerseminar", chunkId: "d:c1" },
  ]);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0], { source: "CALEO", target: "SOMMERSEMINAR", weight: 1 });
});

test("coOccurrencePairs caps dense chunks deterministically (alphabetical top-N per chunk)", () => {
  const mentions = ["Alpha", "Bravo", "Charlie", "Delta"].map((name) => ({
    entityName: name,
    chunkId: "dense:1",
  }));
  const pairs = coOccurrencePairs(mentions, { maxPairsPerChunk: 2 });
  assert.deepEqual(pairs, [
    { source: "ALPHA", target: "BRAVO", weight: 1 },
    { source: "ALPHA", target: "CHARLIE", weight: 1 },
  ], "only the alphabetically-first 2 of 6 pairs survive the cap");
});

// ---------------------------------------------------------------------------
// B. Functional graph double — real ingest → CO_OCCURS edges → clustering.
//    Evaluates the CO_OCCURS write/cleanup semantics (RELATION skip, global
//    shared-chunk weights) against in-memory state.
// ---------------------------------------------------------------------------

interface FakeEntity {
  name: string;
  nameUpper: string;
  type?: string;
  description?: string;
  aliases?: string[];
  communityId?: string;
}

class CoOccursGraphStore {
  entities = new Map<string, FakeEntity>();
  chunkIds = new Set<string>();
  /** MENTIONED_IN edges: chunk id → folded entity names mentioning it. */
  mentions = new Map<string, Set<string>>();
  /** Undirected RELATION pairs (folded). */
  relations = new Set<string>();
  /** Undirected CO_OCCURS pairs → accumulated shared-chunk weight. */
  coOccurs = new Map<string, number>();
  queries: Array<{ query: string; params?: Record<string, unknown> }> = [];

  static pairKey(a: string, b: string): string {
    return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
  }

  addEntity(name: string, type?: string): void {
    const upper = foldName(name);
    this.entities.set(upper, { name, nameUpper: upper, ...(type ? { type } : {}) });
  }

  addRelation(a: string, b: string): void {
    this.relations.add(CoOccursGraphStore.pairKey(foldName(a), foldName(b)));
  }

  /** Entities with no RELATION and no CO_OCCURS edge at all (the isolated
   *  half-orphan class the G4.S9 spec targets). */
  halfOrphans(): string[] {
    const touched = new Set<string>();
    for (const key of [...this.relations, ...this.coOccurs.keys()]) {
      for (const name of key.split("\u0000")) touched.add(name!);
    }
    return [...this.entities.keys()].filter((id) => !touched.has(id)).sort();
  }

  run(query: string, params?: Record<string, unknown>): Promise<unknown> {
    this.queries.push({ query, params });
    // --- ingest-side writes ---
    if (query.includes(`MERGE (c:Chunk {id: $id})`)) {
      this.chunkIds.add(String(params!.id));
      return Promise.resolve({ records: [] });
    }
    if (query.includes(`${ENTITY_LABEL} {name: $name}`) && query.includes("MERGE")) {
      const name = String(params!.name);
      const upper = String(params!.nameUpper ?? foldName(name));
      if (!this.entities.has(upper)) this.addEntity(name, params!.type ? String(params!.type) : undefined);
      return Promise.resolve({ records: [] });
    }
    if (query.includes(`${ENTITY_LABEL} {nameUpper: $nameUpper}`) && query.includes("MERGE")) {
      const upper = String(params!.nameUpper).toUpperCase();
      if (!this.entities.has(upper)) {
        this.addEntity(String(params!.name));
        this.entities.get(upper)!.type = String(params!.type ?? "unknown");
      }
      return Promise.resolve({ records: [] });
    }
    if (query.includes("UNWIND $names") && query.includes("nameUpper")) {
      const names = ((params!.names as string[]) ?? []).filter((n) => this.entities.has(n.toUpperCase()));
      return Promise.resolve({
        records: names.map((n) => ({ get: (key: string) => (key === "name" ? n.toUpperCase() : null) })),
      });
    }
    if (query.includes(`MERGE (a)-[r:${ENTITY_RELATION_TYPE}]`)) {
      this.addRelation(String(params!.sourceUpper), String(params!.targetUpper));
      return Promise.resolve({ records: [{ get: () => 1 }] });
    }
    if (query.includes("UNWIND $mentions")) {
      for (const m of (params!.mentions as Array<{ entityName: string; chunkId: string }>) ?? []) {
        const set = this.mentions.get(m.chunkId) ?? new Set<string>();
        set.add(m.entityName.toUpperCase());
        this.mentions.set(m.chunkId, set);
      }
      return Promise.resolve({ records: [] });
    }
    // Overwrite's per-document mention-edge rebuild (before the fresh merge).
    if (query.includes(`<-[r:${ENTITY_RELATION_TYPE.replace("RELATION", "MENTIONED_IN")}]`) && query.includes("DELETE r")) {
      const documentId = String(params!.documentId);
      for (const chunkId of [...this.mentions.keys()]) {
        if (chunkId.startsWith(`${documentId}:`)) this.mentions.delete(chunkId);
      }
      return Promise.resolve({ records: [] });
    }
    // --- CO_OCCURS write: skip RELATION pairs, weight = globally shared chunks ---
    if (query.includes("UNWIND $pairs") && query.includes("CO_OCCURS")) {
      for (const p of (params!.pairs as Array<{ source: string; target: string }>) ?? []) {
        const a = p.source.toUpperCase();
        const b = p.target.toUpperCase();
        if (a === b) continue; // mirrors `WHERE a <> b` (same node, two spellings)
        if (this.relations.has(CoOccursGraphStore.pairKey(a, b))) continue; // RELATION exists → skip
        let shared = 0;
        for (const names of this.mentions.values()) {
          if (names.has(a) && names.has(b)) shared += 1;
        }
        if (shared > 0) this.coOccurs.set(CoOccursGraphStore.pairKey(a, b), shared);
      }
      return Promise.resolve({ records: [] });
    }
    // --- CO_OCCURS cleanup: drop unbacked / RELATION-shadowed edges ---
    if (query.includes("CO_OCCURS") && query.includes("DELETE r")) {
      for (const key of [...this.coOccurs.keys()]) {
        const [a, b] = key.split("\u0000");
        const backed = [...this.mentions.values()].some((names) => names.has(a!) && names.has(b!));
        if (!backed || this.relations.has(key)) this.coOccurs.delete(key);
      }
      return Promise.resolve({ records: [] });
    }
    // --- T1 clustering reads/writes ---
    if (query.includes("e.nameUpper AS id") && query.includes("community_id AS communityId")) {
      return Promise.resolve({
        records: [...this.entities.values()].map((e) => ({
          get: (key: string) =>
            key === "id" ? e.nameUpper : key === "communityId" ? (e.communityId ?? null) : null,
        })),
      });
    }
    if (query.includes("MENTIONED_IN") && query.includes("count(c) AS weight")) {
      const pairs = new Map<string, [string, string, number]>();
      for (const names of this.mentions.values()) {
        const sorted = [...names].sort();
        for (let i = 0; i < sorted.length; i += 1) {
          for (let j = i + 1; j < sorted.length; j += 1) {
            const k = CoOccursGraphStore.pairKey(sorted[i]!, sorted[j]!);
            const prev = pairs.get(k);
            if (prev) prev[2] += 1;
            else pairs.set(k, [sorted[i]!, sorted[j]!, 1]);
          }
        }
      }
      return Promise.resolve({
        records: [...pairs.values()].map(([source, target, weight]) => ({
          get: (key: string) => (key === "source" ? source : key === "target" ? target : weight),
        })),
      });
    }
    if (query.includes(`:${ENTITY_RELATION_TYPE}]`) && query.includes("sourceCommunity")) {
      const rows: Array<Record<string, unknown>> = [];
      for (const key of this.relations) {
        const [a, b] = key.split("\u0000");
        rows.push({
          source: a,
          target: b,
          weight: 1,
          sourceCommunity: this.entities.get(a!)?.communityId ?? null,
          targetCommunity: this.entities.get(b!)?.communityId ?? null,
        });
      }
      return Promise.resolve({ records: rows.map((r) => ({ get: (k: string) => r[k] ?? null })) });
    }
    if (query.includes(":CO_OCCURS]") && query.includes("sourceCommunity")) {
      const rows: Array<Record<string, unknown>> = [];
      for (const [key, weight] of this.coOccurs) {
        const [a, b] = key.split("\u0000");
        rows.push({
          source: a,
          target: b,
          weight,
          sourceCommunity: this.entities.get(a!)?.communityId ?? null,
          targetCommunity: this.entities.get(b!)?.communityId ?? null,
        });
      }
      return Promise.resolve({ records: rows.map((r) => ({ get: (k: string) => r[k] ?? null })) });
    }
    if (query.includes("UNWIND $memberships")) {
      for (const m of (params!.memberships as Array<{ id: string; communityId: string }>) ?? []) {
        const entity = this.entities.get(m.id.toUpperCase());
        if (entity) entity.communityId = m.communityId;
      }
      return Promise.resolve({ records: [] });
    }
    return Promise.resolve({ records: [] });
  }

  session(): { run: CoOccursGraphStore["run"]; close: () => Promise<void> } {
    return { run: (q, p) => this.run(q, p), close: async () => {} };
  }

  driver(): Neo4jDriverLike {
    return { session: () => this.session() };
  }
}

interface StoreDoc {
  documentId: string;
  title: string;
  wikiPath: string;
  entities: RefineOutputRef["entities"];
  relations: RefineOutputRef["relations"];
  chunks: Array<{ id: string; text: string; heading_path: string }>;
}

function docRef(doc: StoreDoc): RefineOutputRef {
  return {
    md_ref: `/storage/refined/${doc.documentId}/markdown.md`,
    chunks_ref: `/storage/refined/${doc.documentId}/chunks.json`,
    preview: doc.title,
    char_count: 100,
    line_count: 10,
    header_count: 2,
    chunk_count: doc.chunks.length,
    frontmatter: { type: "concept", topic: "internal/events" },
    entities: doc.entities,
    relations: doc.relations,
    keywords: [],
    quality: { complete: true, confidence: 0.95, issues: [], action: "auto_accept" },
    summary: doc.title,
    sections: [],
    mode: "single",
    section_paths: [],
  };
}

async function ingestDoc(store: CoOccursGraphStore, doc: StoreDoc, options = {}): Promise<void> {
  const ingest = new Neo4jIngestService({
    driver: store.driver(),
    embedder: { embed: async (texts) => texts.map(() => [0.1, 0.2]) },
    readChunks: async () => doc.chunks as RefineOutputRef["chunks"],
    applySchema: false,
    ...options,
  });
  await ingest.ingest({
    ref: docRef(doc),
    documentId: doc.documentId,
    title: doc.title,
    wikiPath: doc.wikiPath,
  });
}

// ---------------------------------------------------------------------------
// C. Ingest-time CO_OCCURS wiring
// ---------------------------------------------------------------------------

const MINI_DOC: StoreDoc = {
  documentId: "mini",
  title: "Mini",
  wikiPath: "wiki/events/mini.md",
  entities: [
    { name: "CALEO", type: "org", description: "", aliases: [] },
    { name: "ZOB München", type: "place", description: "", aliases: ["ZOB"] },
  ],
  relations: [], // deliberately NO relation → CALEO/ZOB are half-orphans without CO_OCCURS
  chunks: [
    { id: "c1", text: "CALEO trifft sich am ZOB München.", heading_path: "Mini" },
  ],
};

test("ingest MERGEs CO_OCCURS edges for entities sharing a chunk (default on)", async () => {
  const store = new CoOccursGraphStore();
  await ingestDoc(store, MINI_DOC);

  const pairQuery = store.queries.find((c) => c.query.includes("UNWIND $pairs") && c.query.includes("CO_OCCURS"));
  assert.ok(pairQuery, "co-occurrence write issued");
  assert.deepEqual(pairQuery!.params!.pairs, [
    { source: "CALEO", target: "ZOB MÜNCHEN", weight: 1 },
  ]);
  const key = CoOccursGraphStore.pairKey("CALEO", "ZOB MÜNCHEN");
  assert.equal(store.coOccurs.get(key), 1, "edge stored with weight=shared chunks");
});

test("co-occurrence write skips pairs that already have a RELATION and cleans stale edges on overwrite", async () => {
  const store = new CoOccursGraphStore();
  const relatedDoc: StoreDoc = {
    ...MINI_DOC,
    entities: [
      ...MINI_DOC.entities,
      { name: "Bus", type: "thing", description: "", aliases: [] },
    ],
    relations: [{ source: "CALEO", target: "ZOB München", keywords: ["nutzt"], description: "" }],
    chunks: [
      { id: "c1", text: "CALEO trifft sich am ZOB München und am Bus.", heading_path: "Mini" },
    ],
  };
  await ingestDoc(store, relatedDoc);

  // The RELATION-backed pair is skipped; the mention-only pair (CALEO/BUS) lands.
  assert.equal(
    store.coOccurs.has(CoOccursGraphStore.pairKey("CALEO", "ZOB MÜNCHEN")),
    false,
    "no CO_OCCURS duplicate next to the existing RELATION",
  );
  assert.equal(store.coOccurs.get(CoOccursGraphStore.pairKey("BUS", "CALEO")), 1);

  // Overwrite with corrected text that no longer mentions BUS → stale edge cleaned.
  const edited: StoreDoc = {
    ...relatedDoc,
    chunks: [{ id: "c1", text: "Nur noch CALEO am ZOB München.", heading_path: "Mini" }],
  };
  const overwrite = new Neo4jIngestService({
    driver: store.driver(),
    embedder: { embed: async (texts) => texts.map(() => [0.1, 0.2]) },
    readChunks: async () => edited.chunks as RefineOutputRef["chunks"],
    applySchema: false,
  });
  await overwrite.overwrite({
    ref: docRef(edited),
    documentId: edited.documentId,
    title: edited.title,
    wikiPath: edited.wikiPath,
  });

  assert.equal(store.coOccurs.has(CoOccursGraphStore.pairKey("BUS", "CALEO")), false, "stale CO_OCCURS removed");
  assert.equal(
    store.queries.some((c) => c.query.includes("CO_OCCURS") && c.query.includes("DELETE r")),
    true,
    "cleanup pass ran",
  );
});

test("config flag off disables CO_OCCURS entirely (no pair writes)", async () => {
  const store = new CoOccursGraphStore();
  await ingestDoc(store, MINI_DOC, { coOccurs: false });

  assert.equal(
    store.queries.some((c) => c.query.includes("UNWIND $pairs")),
    false,
    "no co-occurrence write when disabled",
  );
  assert.equal(store.coOccurs.size, 0);
});

// ---------------------------------------------------------------------------
// D. Half-orphan mitigation on the Sommerseminar corpus (real ingest + T1)
// ---------------------------------------------------------------------------

const SOMMER_A: StoreDoc = {
  documentId: "sommerseminar-2026",
  title: "Infos Sommerseminar 2026",
  wikiPath: "wiki/internal/events/sommerseminar-2026.md",
  entities: [
    { name: "CALEO", type: "org", description: "the consultancy", aliases: ["Caleo GmbH"] },
    { name: "Sommerseminar", type: "event", description: "annual summer seminar", aliases: [] },
    { name: "Lüsen", type: "place", description: "venue village", aliases: ["Luessen"] },
    // Half-orphan: mentioned in chunk text, NEVER in a relation.
    { name: "Wanderprogramm", type: "activity", description: "hiking programme", aliases: [] },
  ],
  relations: [
    { source: "CALEO", target: "Sommerseminar", keywords: ["organisiert"], description: "organizes" },
    { source: "Sommerseminar", target: "Lüsen", keywords: ["findet_statt_in"], description: "held in" },
  ],
  chunks: [
    { id: "c1", text: "CALEO organisiert das Sommerseminar in Lüsen mit Wanderprogramm.", heading_path: "Infos" },
  ],
};

test("half-orphan mitigation: mention-only entities gain CO_OCCURS edges + a shared community", async () => {
  const store = new CoOccursGraphStore();

  // Baseline WITHOUT CO_OCCURS: the mention-only entity has zero edges.
  await ingestDoc(store, SOMMER_A, { coOccurs: false });
  assert.deepEqual(store.halfOrphans(), ["WANDERPROGRAMM"]);

  // With CO_OCCURS enabled the same corpus connects the half-orphan.
  await ingestDoc(store, SOMMER_A);
  assert.deepEqual(store.halfOrphans(), [], "no entity without any edge remains");
  const partners = [...store.coOccurs.keys()]
    .filter((k) => k.split("\u0000").includes("WANDERPROGRAMM"))
    .map((k) => k.split("\u0000").find((n) => n !== "WANDERPROGRAMM"))
    .sort();
  assert.deepEqual(partners, ["CALEO", "LÜSEN", "SOMMERSEMINAR"], "co-mentioned pairs all linked");

  // And it clusters WITH its co-mentioned peers instead of becoming a singleton.
  await new Neo4jCommunityService({ driver: store.driver() }).refresh({ kind: "delete" });
  const wander = store.entities.get("WANDERPROGRAMM")!;
  const caleo = store.entities.get("CALEO")!;
  assert.equal(wander.communityId, caleo.communityId);
  assert.equal(wander.communityId, communityIdForMembers(["CALEO", "LÜSEN", "SOMMERSEMINAR", "WANDERPROGRAMM"]));
});
