import { test } from "node:test";
import assert from "node:assert/strict";
import type { RefineOutputRef } from "../../src/agents/refine-output.js";
import {
  detectCommunities,
  resolveStrategy,
  Neo4jCommunityService,
  communityIdForMembers,
  DEFAULT_COMMUNITY_POLICY,
  type CommunityGraphInput,
  type CommunityRefreshTrigger,
} from "../../src/kb/store/community.js";
import { ENTITY_LABEL, ENTITY_RELATION_TYPE, type Neo4jDriverLike } from "../../src/kb/store/schema.js";
import { Neo4jIngestService } from "../../src/kb/store/ingest.js";

// ---------------------------------------------------------------------------
// In-memory graph double shared by the real ingest service and the community
// service: it models just enough Neo4j semantics (Entity nodes + RELATION edges
// + community_id property writes) to run end-to-end fixture flows without a
// live database. Every issued query is recorded for structural assertions.
// ---------------------------------------------------------------------------

interface FakeEntity {
  name: string;
  nameUpper: string;
  type?: string;
  description?: string;
  aliases?: string[];
  communityId?: string;
}

class FakeGraphStore {
  entities = new Map<string, FakeEntity>();
  /** Undirected edge set over folded names with summed weights. */
  edges = new Map<string, { source: string; target: string; weight: number }>();
  /** MENTIONED_IN edges: chunk id → folded entity names mentioned in it. */
  mentions = new Map<string, Set<string>>();
  queries: Array<{ query: string; params?: Record<string, unknown> }> = [];

  private key(a: string, b: string): string {
    return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
  }

  addRelation(source: string, target: string, weight = 1): void {
    const k = this.key(source.toUpperCase(), target.toUpperCase());
    const existing = this.edges.get(k);
    if (existing) existing.weight += weight;
    else this.edges.set(k, { source: source.toUpperCase(), target: target.toUpperCase(), weight });
  }

  neighbourNames(nameUpper: string): string[] {
    const out: string[] = [];
    for (const e of this.edges.values()) {
      if (e.source === nameUpper) out.push(e.target);
      if (e.target === nameUpper) out.push(e.source);
    }
    return out;
  }

  run(query: string, params?: Record<string, unknown>): Promise<unknown> {
    this.queries.push({ query, params });
    // --- ingest-side Entity MERGEs ---
    if (query.includes("MERGE") && query.includes(`${ENTITY_LABEL} {name: $name}`)) {
      const name = String(params!.name);
      const upper = String(params!.nameUpper ?? name.toUpperCase()).toUpperCase();
      const existing = this.entities.get(upper);
      if (!existing) {
        this.entities.set(upper, { name, nameUpper: upper, ...(params!.type ? { type: String(params!.type) } : {}) });
      } else if (params!.nameUpper && !existing.nameUpper) {
        existing.nameUpper = upper;
      }
      return Promise.resolve({ records: [] });
    }
    if (query.includes("MERGE") && query.includes(`${ENTITY_LABEL} {nameUpper: $nameUpper}`)) {
      const upper = String(params!.nameUpper).toUpperCase();
      if (!this.entities.has(upper)) {
        this.entities.set(upper, {
          name: String(params!.name),
          nameUpper: upper,
          type: String(params!.type ?? "unknown"),
          aliases: [],
        });
      }
      return Promise.resolve({ records: [] });
    }
    // Endpoint existence probe (writeRelations step 1b).
    if (query.includes("UNWIND $names") && query.includes("nameUpper")) {
      const names = ((params!.names as string[]) ?? []).filter((n) => this.entities.has(n.toUpperCase()));
      return Promise.resolve({
        records: names.map((n) => ({ get: (key: string) => (key === "name" ? n.toUpperCase() : null) })),
      });
    }
    // RELATION MERGE (writeRelations step 2).
    if (query.includes(`MERGE (a)-[r:${ENTITY_RELATION_TYPE}]`)) {
      const source = String(params!.sourceUpper).toUpperCase();
      const target = String(params!.targetUpper).toUpperCase();
      this.addRelation(source, target);
      return Promise.resolve({ records: [{ get: () => 1 }] });
    }
    // Entity→Chunk mention links written by the ingest.
    if (query.includes("UNWIND $mentions")) {
      for (const m of (params!.mentions as Array<{ entityName: string; chunkId: string }>) ?? []) {
        const chunkId = m.chunkId;
        const set = this.mentions.get(chunkId) ?? new Set<string>();
        set.add(m.entityName.toUpperCase());
        this.mentions.set(chunkId, set);
      }
      return Promise.resolve({ records: [] });
    }
    // --- community-service reads ---
    if (query.includes("e.nameUpper AS id") && query.includes("community_id AS communityId")) {
      return Promise.resolve({
        records: [...this.entities.values()].map((e) => ({
          get: (key: string) =>
            key === "id" ? e.nameUpper : key === "communityId" ? (e.communityId ?? null) : null,
        })),
      });
    }
    // Co-mention pair aggregation over shared chunks (weighted option).
    if (query.includes("MENTIONED_IN") && query.includes("count(c) AS weight")) {
      const pairs = new Map<string, number>();
      const pairMeta = new Map<string, [string, string]>();
      for (const names of this.mentions.values()) {
        const sorted = [...names].sort();
        for (let i = 0; i < sorted.length; i += 1) {
          for (let j = i + 1; j < sorted.length; j += 1) {
            const k = `${sorted[i]}\u0000${sorted[j]}`;
            pairs.set(k, (pairs.get(k) ?? 0) + 1);
            pairMeta.set(k, [sorted[i], sorted[j]]);
          }
        }
      }
      return Promise.resolve({
        records: [...pairs.entries()].map(([k, weight]) => {
          const [source, target] = pairMeta.get(k)!;
          return { get: (key: string) => (key === "source" ? source : key === "target" ? target : weight) };
        }),
      });
    }
    if (query.includes("RELATION`]-(b") || query.includes(`:${ENTITY_RELATION_TYPE}]`)) {
      // Edge scan with endpoint communities: source/target/community pairs.
      const withCommunities = query.includes("sourceCommunity");
      return Promise.resolve({
        records: [...this.edges.values()].map((e) => ({
          get: (key: string) => {
            switch (key) {
              case "source":
                return e.source;
              case "target":
                return e.target;
              case "weight":
                return e.weight;
              case "sourceCommunity":
                return withCommunities ? (this.entities.get(e.source)?.communityId ?? null) : null;
              case "targetCommunity":
                return withCommunities ? (this.entities.get(e.target)?.communityId ?? null) : null;
              default:
                return null;
            }
          },
        })),
      });
    }
    // --- community-service writes (batched UNWIND SET e.community_id) ---
    if (query.includes("UNWIND $memberships")) {
      for (const m of (params!.memberships as Array<{ id: string; communityId: string }>) ?? []) {
        const entity = this.entities.get(m.id.toUpperCase());
        if (entity) entity.communityId = m.communityId;
      }
      return Promise.resolve({ records: [] });
    }
    // Everything else (Document/Chunk/Section/WikiPage/MENTIONED_IN) is out of scope.
    return Promise.resolve({ records: [] });
  }

  session(): { run: FakeGraphStore["run"]; close: () => Promise<void> } {
    return { run: (q, p) => this.run(q, p), close: async () => {} };
  }

  driver(): Neo4jDriverLike {
    return { session: () => this.session() };
  }
}

function graph(nodeIds: string[], edges: CommunityGraphInput["edges"]): CommunityGraphInput {
  return { nodeIds, edges };
}

// ---------------------------------------------------------------------------
// A. Pure deterministic community detection (Louvain, seeded by sorted order)
// ---------------------------------------------------------------------------

test("detectCommunities keeps two disconnected groups separate and is deterministic", () => {
  const nodes = ["A1", "A2", "A3", "B1", "B2", "B3"];
  const edges = [
    { source: "A1", target: "A2" },
    { source: "A2", target: "A3" },
    { source: "A3", target: "A1" },
    { source: "B1", target: "B2" },
    { source: "B2", target: "B3" },
    { source: "B3", target: "B1" },
  ];
  const first = detectCommunities(graph(nodes, edges));
  const second = detectCommunities(graph([...nodes].reverse(), [...edges].reverse()));
  assert.equal(first.communities.size, 2);
  assert.deepEqual(first.assignment, second.assignment, "input order must not change the partition");

  const [commA, commB] = [...first.communities.values()];
  assert.ok(commA);
  assert.ok(commB);
  // Each triangle's members land together.
  for (const member of ["A1", "A2", "A3"]) {
    assert.ok(commA?.includes(member) !== commB?.includes(member), `${member} assigned exactly once`);
  }
});

test("detectCommunities groups connected friends and separates unrelated groups", () => {
  // Two clusters joined nowhere: {hub, f1, f2} and {x1, x2}.
  const result = detectCommunities(
    graph(
      ["HUB", "F1", "F2", "X1", "X2"],
      [
        { source: "HUB", target: "F1" },
        { source: "HUB", target: "F2" },
        { source: "F1", target: "F2" },
        { source: "X1", target: "X2" },
      ],
    ),
  );
  const hubCommunity = result.assignment.get("HUB")!;
  assert.equal(result.assignment.get("F1"), hubCommunity);
  assert.equal(result.assignment.get("F2"), hubCommunity);
  assert.notEqual(result.assignment.get("X1"), hubCommunity);
  assert.equal(result.assignment.get("X2"), result.assignment.get("X1"));
});

test("detectCommunities assigns isolated entities singleton communities", () => {
  const result = detectCommunities(graph(["ALONE1", "ALONE2"], []));
  assert.notEqual(result.assignment.get("ALONE1"), result.assignment.get("ALONE2"));
  assert.equal(result.assignment.size, 2);
});

test("detectCommunities returns an empty partition for an empty graph", () => {
  const result = detectCommunities(graph([], []));
  assert.equal(result.assignment.size, 0);
  assert.equal(result.communities.size, 0);
});

test("communityIdForMembers is stable across member order and whitespace/case folding", () => {
  const a = communityIdForMembers(["CALEO", "ZOB MÜNCHEN"]);
  const b = communityIdForMembers([" zob münchen ", "caleo"]);
  assert.equal(a, b);
  assert.match(a, /^c_[0-9a-f]{12}$/);
});

// ---------------------------------------------------------------------------
// B. Incremental strategy policy (pure)
// ---------------------------------------------------------------------------

test("resolveStrategy always runs full below the size threshold", () => {
  const trigger: CommunityRefreshTrigger = { kind: "wiki-edit", touchedEntityNames: ["CALEO"] };
  assert.equal(resolveStrategy(DEFAULT_COMMUNITY_POLICY.fullRunThreshold - 1, trigger), "full");
});

test("resolveStrategy maps delete to full and big ingest to full", () => {
  assert.equal(resolveStrategy(5000, { kind: "delete" }), "full");
  assert.equal(resolveStrategy(5000, { kind: "ingest", entitiesStored: 5, relationsStored: DEFAULT_COMMUNITY_POLICY.bigIngestRelationsThreshold + 1 }), "full");
});

test("resolveStrategy maps small wiki-edit diffs above the threshold to local recompute", () => {
  const trigger: CommunityRefreshTrigger = {
    kind: "wiki-edit",
    touchedEntityNames: ["CALEO", "ZOB"],
  };
  assert.equal(resolveStrategy(DEFAULT_COMMUNITY_POLICY.fullRunThreshold + 1, trigger), "local");
});

test("resolveStrategy falls back to full when the diff touches too many entities", () => {
  const names = Array.from({ length: DEFAULT_COMMUNITY_POLICY.localDiffLimit + 1 }, (_, i) => `E${i}`);
  assert.equal(resolveStrategy(DEFAULT_COMMUNITY_POLICY.fullRunThreshold + 1, { kind: "wiki-edit", touchedEntityNames: names }), "full");
});

test("resolveStrategy maps small ingests above the threshold to local recompute", () => {
  assert.equal(
    resolveStrategy(5000, { kind: "ingest", entitiesStored: 2, relationsStored: 3, touchedEntityNames: ["NEW1"] }),
    "local",
  );
});

// ---------------------------------------------------------------------------
// C. Neo4jCommunityService — full refresh, local recompute, resilience
// ---------------------------------------------------------------------------

test("full refresh writes a stable community_id on every entity via batched UNWIND", async () => {
  const store = new FakeGraphStore();
  store.entities.set("CALEO", { name: "CALEO", nameUpper: "CALEO" });
  store.entities.set("ZOB", { name: "ZOB", nameUpper: "ZOB" });
  store.addRelation("CALEO", "ZOB");
  store.entities.set("LONER", { name: "Loner", nameUpper: "LONER" });

  const service = new Neo4jCommunityService({ driver: store.driver() });
  const result = await service.refresh({ kind: "delete" });

  assert.equal(result.strategy, "full");
  assert.equal(result.entitiesAssigned, 3);
  assert.ok((result.communities ?? 0) >= 2);

  const write = store.queries.find((q) => q.query.includes("UNWIND $memberships"));
  assert.ok(write, "memberships are written through one batched UNWIND");
  assert.ok(write!.query.includes("community_id"), "the node property is community_id");

  assert.equal(store.entities.get("CALEO")!.communityId, store.entities.get("ZOB")!.communityId);
  assert.notEqual(store.entities.get("CALEO")!.communityId, store.entities.get("LONER")!.communityId);
});

test("local recompute only rewrites the touched closure and preserves other communities", async () => {
  const store = new FakeGraphStore();
  // Group A (touched): CALEO-ZOB. Group B: SAP-BCS (far away, untouched).
  for (const [name, upper] of [["CALEO", "CALEO"], ["ZOB", "ZOB"], ["SAP", "SAP"], ["BCS", "BCS"]] as const) {
    store.entities.set(upper, { name, nameUpper: upper });
  }
  store.addRelation("CALEO", "ZOB");
  store.addRelation("SAP", "BCS");

  // Tiny full-run threshold so this 4-entity fixture exercises the local path.
  const tinyPolicy = { ...DEFAULT_COMMUNITY_POLICY, fullRunThreshold: 3 };
  const service = new Neo4jCommunityService({ driver: store.driver(), policy: tinyPolicy });

  await service.refresh({ kind: "ingest", entitiesStored: 4, relationsStored: 2 });
  const sapBefore = store.entities.get("SAP")!.communityId;

  // Wiki-edit adds a new entity bridged to CALEO only (nameUpper = foldName).
  store.entities.set("C-DAY", { name: "C-Day", nameUpper: "C-DAY" });
  store.addRelation("CALEO", "C-DAY");

  const result = await service.refresh({ kind: "wiki-edit", touchedEntityNames: ["C-Day"] });

  assert.equal(result.strategy, "local");
  assert.equal(store.entities.get("C-DAY")!.communityId, store.entities.get("CALEO")!.communityId, "new neighbour joins the CALEO community");
  assert.equal(store.entities.get("SAP")!.communityId, sapBefore, "untouched group keeps its assignment");
});

test("local recompute falls back to full when the closure exceeds the size cap", async () => {
  const store = new FakeGraphStore();
  // 120 chained entities pre-clustered into ONE community (above the local cap),
  // plus 80 untouched isolates.
  for (let i = 0; i < 120; i += 1) {
    store.entities.set(`E${i}`, { name: `E${i}`, nameUpper: `E${i}`, communityId: "c_big" });
    if (i > 0) store.addRelation(`E${i - 1}`, `E${i}`);
  }
  for (let i = 120; i < 200; i += 1) {
    store.entities.set(`E${i}`, { name: `E${i}`, nameUpper: `E${i}` });
  }

  const cappedPolicy = { ...DEFAULT_COMMUNITY_POLICY, fullRunThreshold: 50, localMaxNodes: 100 };
  const service = new Neo4jCommunityService({ driver: store.driver(), policy: cappedPolicy });
  const result = await service.refresh({ kind: "wiki-edit", touchedEntityNames: ["E0"] });
  assert.equal(result.strategy, "full", "a closure above localMaxNodes falls back to a full re-run");
  assert.equal(result.entitiesAssigned, 200);
});

test("refresh never throws into the caller — failures degrade to an error field", async () => {
  const failing: Neo4jDriverLike = {
    session: () => ({
      run: () => Promise.reject(new Error("bolt down")),
      close: async () => {},
    }),
  };
  const service = new Neo4jCommunityService({ driver: failing });
  const result = await service.refresh({ kind: "delete" });
  assert.equal(result.strategy, "skipped");
  assert.match(result.error ?? "", /bolt down/);
});

// ---------------------------------------------------------------------------
// D. Integration — Sommerseminar fixtures loaded through the REAL ingest,
//    then clustered; wiki-edit and delete flows keep memberships consistent.
// ---------------------------------------------------------------------------

interface SommerDoc {
  documentId: string;
  title: string;
  wikiPath: string;
  entities: RefineOutputRef["entities"];
  relations: RefineOutputRef["relations"];
  /** RAG chunk texts; several entities per chunk produce MENTIONED_IN co-mentions. */
  chunks: Array<{ id: string; text: string; heading_path: string }>;
}

/**
 * The two Sommerseminar corpus docs (G4.S9 Spec): doc A describes CALEO's
 * Sommerseminar event world; doc B its C-Day / finance side. Both share CALEO.
 * The unrelated SAP-code group (BCS/ZCONS) has no edges into either doc —
 * it must NOT join the CALEO-centric community.
 */
const SOMMER_DOC_A: SommerDoc = {
  documentId: "sommerseminar-2026",
  title: "Infos Sommerseminar 2026",
  wikiPath: "wiki/internal/events/sommerseminar-2026.md",
  entities: [
    { name: "CALEO", type: "org", description: "the consultancy", aliases: ["Caleo GmbH"] },
    { name: "Sommerseminar", type: "event", description: "annual summer seminar", aliases: [] },
    { name: "ZOB München", type: "place", description: "bus station", aliases: ["Zentraler Omnibusbahnhof"] },
    { name: "Lüsen", type: "place", description: "venue village", aliases: ["Luessen"] },
  ],
  relations: [
    { source: "CALEO", target: "Sommerseminar", keywords: ["organisiert"], description: "CALEO organizes the seminar" },
    { source: "Sommerseminar", target: "Lüsen", keywords: ["findet_statt_in"], description: "held in Lüsen" },
    { source: "CALEO", target: "ZOB München", keywords: ["nutzt"], description: "arrival via ZOB" },
  ],
  chunks: [
    {
      id: "c1",
      text: "Infos Sommerseminar 2026 — CALEO organisiert das Sommerseminar in Lüsen.",
      heading_path: "Infos Sommerseminar 2026",
    },
    {
      id: "c2",
      text: "Anreise über den ZOB München; die Caleo GmbH koordiniert die Busse.",
      heading_path: "Infos Sommerseminar 2026 / Anreise",
    },
  ],
};

const SOMMER_DOC_B: SommerDoc = {
  documentId: "cday-finance",
  title: "C-Day für die CALEOs",
  wikiPath: "wiki/internal/events/cday.md",
  entities: [
    { name: "C-Day", type: "event", description: "internal finance day", aliases: ["C Day"] },
    { name: "Mitarbeiter", type: "person", description: "employees", aliases: [] },
    // The page references the seminar series, so the per-document extraction
    // picks Sommerseminar up here too — this is what bridges the two docs.
    { name: "Sommerseminar", type: "event", description: "annual summer seminar", aliases: [] },
  ],
  relations: [
    { source: "CALEO", target: "C-Day", keywords: ["veranstaltet"], description: "CALEO hosts C-Day" },
    { source: "C-Day", target: "Mitarbeiter", keywords: ["richtet_sich_an"], description: "aimed at staff" },
  ],
  chunks: [
    {
      id: "c1",
      text: "C-Day für die CALEOs — der C-Day der Caleo GmbH richtet sich an alle Mitarbeiter und wird wie das Sommerseminar von CALEO veranstaltet.",
      heading_path: "C-Day für die CALEOs",
    },
    {
      id: "c2",
      text: "Anreise wie beim Sommerseminar über den ZOB München — alle Mitarbeiter treffen sich am Bus.",
      heading_path: "C-Day für die CALEOs / Anreise",
    },
  ],
};

const SAP_CODE_DOC: SommerDoc = {
  documentId: "zcons-bcs",
  title: "ZCONS BCS Konsolidierung",
  wikiPath: "wiki/sap/bcs/zcons.md",
  entities: [
    { name: "BCS", type: "module", description: "consolidation module", aliases: [] },
    { name: "ZCONS", type: "program", description: "consolidation report", aliases: [] },
  ],
  relations: [{ source: "ZCONS", target: "BCS", keywords: ["ruft_auf"], description: "calls BCS APIs" }],
  chunks: [
    {
      id: "c1",
      text: "Der Report ZCONS ruft die Schnittstellen des Konsolidierungsmoduls BCS auf.",
      heading_path: "ZCONS BCS Konsolidierung",
    },
  ],
};

function sommerRef(doc: SommerDoc): RefineOutputRef {
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
    keywords: ["sommerseminar"],
    quality: { complete: true, confidence: 0.95, issues: [], action: "auto_accept" },
    summary: doc.title,
    sections: [],
    mode: "single",
    section_paths: [],
  };
}

async function ingestSommerDoc(store: FakeGraphStore, doc: SommerDoc): Promise<void> {
  const chunks = doc.chunks;
  const ingest = new Neo4jIngestService({
    driver: store.driver(),
    embedder: { embed: async (texts) => texts.map(() => [0.1, 0.2]) },
    readChunks: async () => chunks as RefineOutputRef["chunks"],
    applySchema: false,
  });
  await ingest.ingest({
    ref: sommerRef(doc),
    documentId: doc.documentId,
    title: doc.title,
    wikiPath: doc.wikiPath,
  });
}

test("Sommerseminar fixtures: real ingest then cluster yields the CALEO-centric community", async () => {
  const store = new FakeGraphStore();
  await ingestSommerDoc(store, SOMMER_DOC_A);
  await ingestSommerDoc(store, SOMMER_DOC_B);
  await ingestSommerDoc(store, SAP_CODE_DOC);

  const service = new Neo4jCommunityService({ driver: store.driver() });
  const result = await service.refresh({ kind: "delete" });

  assert.equal(result.strategy, "full");
  const caleo = store.entities.get("CALEO")!;
  assert.ok(caleo.communityId, "CALEO has a persisted community_id");

  // CALEO + its relations live in ONE community.
  for (const partner of ["SOMMERSEMINAR", "ZOB MÜNCHEN", "LÜSEN", "C-DAY", "MITARBEITER"]) {
    const entity = store.entities.get(partner);
    assert.ok(entity?.communityId, `${partner} has a community_id`);
    assert.equal(entity!.communityId, caleo.communityId, `${partner} shares CALEO's community`);
  }

  // The unrelated SAP-code group stays OUT of the CALEO community.
  for (const outsider of ["BCS", "ZCONS"]) {
    const entity = store.entities.get(outsider);
    assert.ok(entity?.communityId, `${outsider} has a community_id`);
    assert.notEqual(entity!.communityId, caleo.communityId, `${outsider} is not in CALEO's community`);
  }
});

test("Sommerseminar fixtures: partition is deterministic across repeated full runs", async () => {
  const build = async (): Promise<FakeGraphStore> => {
    const store = new FakeGraphStore();
    await ingestSommerDoc(store, SOMMER_DOC_A);
    await ingestSommerDoc(store, SOMMER_DOC_B);
    await ingestSommerDoc(store, SAP_CODE_DOC);
    return store;
  };
  const one = await build();
  const two = await build();
  const service = new Neo4jCommunityService({ driver: two.driver() });
  const serviceOne = new Neo4jCommunityService({ driver: one.driver() });
  await serviceOne.refresh({ kind: "delete" });
  await service.refresh({ kind: "delete" });

  const assignmentOne = new Map([...one.entities.values()].map((e) => [e.nameUpper, e.communityId]));
  const assignmentTwo = new Map([...two.entities.values()].map((e) => [e.nameUpper, e.communityId]));
  assert.deepEqual(assignmentOne, assignmentTwo);
});

test("Sommerseminar fixtures: wiki-edit then delete keep memberships consistent without breaking reads", async () => {
  const store = new FakeGraphStore();
  await ingestSommerDoc(store, SOMMER_DOC_A);
  await ingestSommerDoc(store, SOMMER_DOC_B);
  const service = new Neo4jCommunityService({ driver: store.driver() });

  // Full run after the initial ingest (size < threshold ⇒ full anyway).
  const full = await service.refresh({ kind: "ingest", entitiesStored: 6, relationsStored: 5 });
  assert.equal(full.strategy, "full");
  const membersBefore = [...store.entities.values()]
    .filter((e) => e.communityId === store.entities.get("CALEO")!.communityId)
    .map((e) => e.nameUpper)
    .sort();

  // Small wiki-edit: a new relation partner appears → local recompute.
  store.entities.set("SÜDTIROL", { name: "Südtirol", nameUpper: "SÜDTIROL" });
  store.addRelation("LÜSEN", "SÜDTIROL");
  const local = await service.refresh({ kind: "wiki-edit", touchedEntityNames: ["Südtirol"] });
  assert.equal(local.strategy, "full", "below the full-run threshold the strategy stays full");
  assert.equal(store.entities.get("SÜDTIROL")!.communityId, store.entities.get("LÜSEN")!.communityId);
  // The partition is continuous: every former member of CALEO's community is
  // still with CALEO (no churn out); new neighbours may join.
  const membersAfter = [...store.entities.values()]
    .filter((e) => e.communityId === store.entities.get("CALEO")!.communityId)
    .map((e) => e.nameUpper)
    .sort();
  for (const member of membersBefore) {
    assert.ok(membersAfter.includes(member), `${member} stays in CALEO's community`);
  }

  // Online retrieval seam still works: every entity answers with a community_id.
  for (const entity of store.entities.values()) {
    assert.ok(entity.communityId, `${entity.nameUpper} still carries a community_id`);
  }

  // Delete cascade trigger → full rerun succeeds and reassigns everyone.
  store.entities.delete("MITARBEITER"); // simulate the graph cascade having removed a node
  store.edges.clear(); // (cascade removed this fixture's edges; rerun rebuilds from what remains)
  store.addRelation("CALEO", "SOMMERSEMINAR");
  const afterDelete = await service.refresh({ kind: "delete" });
  assert.equal(afterDelete.strategy, "full");
  assert.ok(!store.entities.has("MITARBEITER"));
  for (const entity of store.entities.values()) {
    assert.ok(entity.communityId, `${entity.nameUpper} reassigned after delete-triggered full run`);
  }
});
