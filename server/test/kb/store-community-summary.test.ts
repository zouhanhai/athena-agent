import { test } from "node:test";
import assert from "node:assert/strict";
import type { RefineOutputRef } from "../../src/agents/refine-output.js";
import {
  Neo4jCommunityService,
  communityIdForMembers,
} from "../../src/kb/store/community.js";
import {
  COMMUNITY_SUMMARY_MAX_TOKENS,
  COMMUNITY_SUMMARY_SCHEMA,
  buildCommunitySummaryPrompt,
  defaultCommunitySummarizer,
  parseCommunitySummaryText,
  Neo4jCommunitySummaryService,
  type CommunitySummarizer,
} from "../../src/kb/store/community-summary.js";
import { ENTITY_LABEL, ENTITY_RELATION_TYPE, foldName, type Neo4jDriverLike } from "../../src/kb/store/schema.js";
import { Neo4jIngestService } from "../../src/kb/store/ingest.js";

// ---------------------------------------------------------------------------
// In-memory graph double shared by the real ingest service, the T1 clustering
// service and the T2 summary service: Entity nodes + RELATION edges +
// community_id writes + :Community nodes with -[:MEMBER]-> edges. Every issued
// query is recorded for structural assertions.
// ---------------------------------------------------------------------------

interface FakeEntity {
  name: string;
  nameUpper: string;
  type?: string;
  description?: string;
  aliases?: string[];
  communityId?: string;
}

interface FakeCommunity {
  id: string;
  summary?: string;
  theme?: string;
  membersHash?: string;
  memberCount?: number;
  updatedAt?: string;
  embedding?: number[];
}

class FakeGraphStore {
  entities = new Map<string, FakeEntity>();
  /** Undirected edge set over folded names with summed weights. */
  edges = new Map<string, { source: string; target: string; weight: number }>();
  /** Directed relation payloads as written by the real ingest. */
  relations = new Map<string, { source: string; target: string; keywords: string[]; description: string }>();
  /** MENTIONED_IN edges: chunk id → folded entity names mentioned in it. */
  mentions = new Map<string, Set<string>>();
  communities = new Map<string, FakeCommunity>();
  /** MEMBER edges as `communityId\0memberNameUpper`. */
  memberEdges = new Set<string>();
  queries: Array<{ query: string; params?: Record<string, unknown> }> = [];

  private key(a: string, b: string): string {
    return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
  }

  addRelation(source: string, target: string, keywords: string[] = [], description = ""): void {
    const s = source.toUpperCase();
    const t = target.toUpperCase();
    const k = this.key(s, t);
    const existing = this.edges.get(k);
    if (existing) existing.weight += 1;
    else this.edges.set(k, { source: s, target: t, weight: 1 });
    this.relations.set(`${s}\u0000${t}`, { source: s, target: t, keywords, description });
  }

  removeRelation(a: string, b: string): void {
    this.edges.delete(this.key(a.toUpperCase(), b.toUpperCase()));
  }

  addMention(chunkId: string, ...names: string[]): void {
    const set = this.mentions.get(chunkId) ?? new Set<string>();
    for (const n of names) set.add(n.toUpperCase());
    this.mentions.set(chunkId, set);
  }

  addEntity(name: string, type?: string, description?: string): FakeEntity {
    const upper = foldName(name);
    const entity: FakeEntity = { name, nameUpper: upper, ...(type ? { type } : {}), ...(description ? { description } : {}) };
    this.entities.set(upper, entity);
    return entity;
  }

  run(query: string, params?: Record<string, unknown>): Promise<unknown> {
    this.queries.push({ query, params });
    // --- ingest-side Entity MERGEs ---
    if (query.includes("MERGE") && query.includes(`${ENTITY_LABEL} {name: $name}`)) {
      const name = String(params!.name);
      const upper = String(params!.nameUpper ?? name.toUpperCase()).toUpperCase();
      if (!this.entities.has(upper)) {
        this.entities.set(upper, { name, nameUpper: upper, ...(params!.type ? { type: String(params!.type) } : {}) });
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
      this.addRelation(
        source,
        target,
        (params!.keywords as string[]) ?? [],
        String(params!.description ?? ""),
      );
      return Promise.resolve({ records: [{ get: () => 1 }] });
    }
    // Entity→Chunk mention links written by the ingest.
    if (query.includes("UNWIND $mentions")) {
      for (const m of (params!.mentions as Array<{ entityName: string; chunkId: string }>) ?? []) {
        const set = this.mentions.get(m.chunkId) ?? new Set<string>();
        set.add(m.entityName.toUpperCase());
        this.mentions.set(m.chunkId, set);
      }
      return Promise.resolve({ records: [] });
    }
    // --- T2 summary-service reads (BEFORE the generic RELATION scan: the
    //     intra-relations query also contains the ":RELATION]" substring) ---
    if (query.includes("e.community_id AS communityId") && query.includes("e.type AS type")) {
      return Promise.resolve({
        records: [...this.entities.values()]
          .filter((e) => e.communityId)
          .map((e) => ({
            get: (key: string) => {
              switch (key) {
                case "communityId":
                  return e.communityId;
                case "id":
                  return e.nameUpper;
                case "name":
                  return e.name;
                case "type":
                  return e.type ?? null;
                case "description":
                  return e.description ?? null;
                default:
                  return null;
              }
            },
          })),
      });
    }
    if (query.includes("r.keywords AS keywords")) {
      const records = [...this.relations.values()]
        .filter((r) => {
          const a = this.entities.get(r.source);
          const b = this.entities.get(r.target);
          return Boolean(a?.communityId) && a?.communityId === b?.communityId;
        })
        .map((r) => ({
          get: (key: string) => {
            switch (key) {
              case "communityId":
                return this.entities.get(r.source)?.communityId ?? null;
              case "source":
                return r.source;
              case "target":
                return r.target;
              case "keywords":
                return r.keywords;
              case "description":
                return r.description || null;
              default:
                return null;
            }
          },
        }));
      return Promise.resolve({ records });
    }
    // --- T1 clustering reads ---
    if (query.includes("e.nameUpper AS id") && query.includes("community_id AS communityId")) {
      return Promise.resolve({
        records: [...this.entities.values()].map((e) => ({
          get: (key: string) =>
            key === "id" ? e.nameUpper : key === "communityId" ? (e.communityId ?? null) : null,
        })),
      });
    }
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
    if (query.includes(`:${ENTITY_RELATION_TYPE}]`)) {
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
    if (query.includes("UNWIND $memberships")) {
      for (const m of (params!.memberships as Array<{ id: string; communityId: string }>) ?? []) {
        const entity = this.entities.get(m.id.toUpperCase());
        if (entity) entity.communityId = m.communityId;
      }
      return Promise.resolve({ records: [] });
    }
    if (query.includes("c.members_hash AS membersHash")) {
      return Promise.resolve({
        records: [...this.communities.values()].map((c) => ({
          get: (key: string) => {
            switch (key) {
              case "id":
                return c.id;
              case "membersHash":
                return c.membersHash ?? null;
              case "hasSummary":
                return typeof c.summary === "string" && c.summary.length > 0;
              default:
                return null;
            }
          },
        })),
      });
    }
    // --- T2 summary-service writes ---
    if (query.includes("UNWIND $nodes")) {
      for (const n of (params!.nodes as Array<{ id: string; membersHash: string; memberCount: number }>) ?? []) {
        const existing = this.communities.get(n.id);
        if (existing) {
          existing.membersHash = n.membersHash;
          existing.memberCount = n.memberCount;
        } else {
          this.communities.set(n.id, { id: n.id, membersHash: n.membersHash, memberCount: n.memberCount });
        }
      }
      return Promise.resolve({ records: [] });
    }
    if (query.includes("UNWIND $edges")) {
      for (const e of (params!.edges as Array<{ communityId: string; memberId: string }>) ?? []) {
        if (this.communities.has(e.communityId) && this.entities.has(e.memberId.toUpperCase())) {
          this.memberEdges.add(`${e.communityId}\u0000${e.memberId.toUpperCase()}`);
        }
      }
      return Promise.resolve({ records: [] });
    }
    if (query.includes("UNWIND $prune")) {
      for (const p of (params!.prune as Array<{ id: string; keepIds: string[] }>) ?? []) {
        const keep = new Set(p.keepIds.map((k) => k.toUpperCase()));
        for (const edge of [...this.memberEdges]) {
          if (edge.startsWith(`${p.id}\u0000`) && !keep.has(edge.split("\u0000")[1]!)) {
            this.memberEdges.delete(edge);
          }
        }
      }
      return Promise.resolve({ records: [] });
    }
    if (query.includes("UNWIND $staleIds")) {
      for (const id of (params!.staleIds as string[]) ?? []) {
        this.communities.delete(id);
        for (const edge of [...this.memberEdges]) {
          if (edge.startsWith(`${id}\u0000`)) this.memberEdges.delete(edge);
        }
      }
      return Promise.resolve({ records: [] });
    }
    if (query.includes("c.summary = $summary")) {
      const community = this.communities.get(String(params!.id));
      if (community) {
        community.summary = String(params!.summary);
        community.theme = String(params!.theme);
        community.updatedAt = String(params!.updatedAt);
        if (params!.embedding !== undefined) community.embedding = params!.embedding as number[];
      }
      return Promise.resolve({ records: [] });
    }
    // Everything else (Document/Chunk/Section/WikiPage chains) is out of scope.
    return Promise.resolve({ records: [] });
  }

  session(): { run: FakeGraphStore["run"]; close: () => Promise<void> } {
    return { run: (q, p) => this.run(q, p), close: async () => {} };
  }

  driver(): Neo4jDriverLike {
    return { session: () => this.session() };
  }
}

// ---------------------------------------------------------------------------
// Mock summarizer
// ---------------------------------------------------------------------------

interface SummarizerCall {
  communityId: string;
  members: Array<{ name: string; type: string | null; description: string | null }>;
  relations: Array<{ source: string; target: string; keywords: string[]; description: string | null }>;
}

function mockSummarizer(
  answers: Map<string, { summary: string; theme: string }>,
  calls: SummarizerCall[],
  failFor: (call: SummarizerCall, index: number) => boolean = () => false,
): CommunitySummarizer {
  let index = 0;
  return async (input) => {
    const call: SummarizerCall = {
      communityId: input.communityId,
      members: input.members,
      relations: input.relations,
    };
    const callIndex = index++;
    calls.push(call);
    if (failFor(call, callIndex)) throw new Error(`summarizer down for ${input.communityId}`);
    const answer = answers.get(input.communityId) ?? {
      summary: `Summary of ${input.communityId}`,
      theme: `Theme ${input.communityId}`,
    };
    return answer;
  };
}

function makeService(store: FakeGraphStore, summarizer: CommunitySummarizer): Neo4jCommunitySummaryService {
  return new Neo4jCommunitySummaryService({ driver: store.driver(), summarizer });
}

// ---------------------------------------------------------------------------
// A. Pure helpers: prompt building + LLM output parsing + default caller shape
// ---------------------------------------------------------------------------

test("buildCommunitySummaryPrompt lists members and intra-community relations", () => {
  const prompt = buildCommunitySummaryPrompt({
    communityId: "c_abc123",
    members: [
      { name: "CALEO", type: "org", description: "the consultancy" },
      { name: "Sommerseminar", type: "event", description: null },
    ],
    relations: [
      { source: "CALEO", target: "Sommerseminar", keywords: ["organisiert"], description: "CALEO organizes it" },
    ],
  });
  assert.ok(prompt.includes("CALEO"), "member names appear");
  assert.ok(prompt.includes("(org)"), "member types appear");
  assert.ok(prompt.includes("the consultancy"), "member descriptions appear");
  assert.ok(prompt.includes("CALEO -> Sommerseminar"), "relations render as triples");
  assert.ok(prompt.includes("organisiert"), "relation keywords appear");
});

test("buildCommunitySummaryPrompt caps huge communities with an explicit omission note", () => {
  const prompt = buildCommunitySummaryPrompt(
    {
      communityId: "c_big",
      members: Array.from({ length: 8 }, (_, i) => ({ name: `E${i}`, type: null, description: null })),
      relations: [],
    },
    { maxMembers: 3, maxRelations: 5 },
  );
  assert.ok(prompt.includes("E0"));
  assert.ok(!prompt.includes("E7"), "members beyond the cap are omitted");
  assert.match(prompt, /\+5 more members omitted/);
  assert.match(prompt, /\(none recorded\)/);
});

test("parseCommunitySummaryText accepts the JSON contract and rejects everything else", () => {
  assert.deepEqual(parseCommunitySummaryText('{"summary":"s","theme":"t"}'), { summary: "s", theme: "t" });
  assert.throws(() => parseCommunitySummaryText("not json"), /invalid JSON/);
  assert.throws(() => parseCommunitySummaryText('{"summary":"s"}'), /theme/);
  assert.throws(() => parseCommunitySummaryText('{"summary":"","theme":"t"}'), /summary/);
});

test("defaultCommunitySummarizer calls OpenRouter extraction-class with json_schema and parses the result", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: string; headers?: Record<string, string> }) => {
    bodies.push(JSON.parse(init!.body!) as Record<string, unknown>);
    assert.equal(init!.headers.Authorization, "Bearer test-key");
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ summary: "CALEO organizes events.", theme: "Events" }) } }],
        }),
    };
  }) as unknown as typeof fetch;

  const summarizer = defaultCommunitySummarizer({ fetchImpl, apiKey: "test-key" });
  const result = await summarizer({
    communityId: "c_abc",
    members: [{ name: "CALEO", type: "org", description: "consultancy" }],
    relations: [],
  });

  assert.deepEqual(result, { summary: "CALEO organizes events.", theme: "Events" });
  assert.equal(bodies.length, 1);
  const body = bodies[0]!;
  assert.equal(body.max_tokens, COMMUNITY_SUMMARY_MAX_TOKENS);
  assert.deepEqual(body.reasoning, { effort: "none" }, "extraction class → reasoning OFF");
  const format = body.response_format as { type: string; json_schema: { schema: unknown } };
  assert.equal(format.type, "json_schema");
  assert.deepEqual(format.json_schema.schema, COMMUNITY_SUMMARY_SCHEMA);
  const messages = body.messages as Array<{ role: string; content: string }>;
  assert.ok(messages[1]!.content.includes("CALEO"), "the user content carries the community payload");
});

// ---------------------------------------------------------------------------
// B. Neo4jCommunitySummaryService — upsert, summarize, refresh policy, cleanup
// ---------------------------------------------------------------------------

async function seedTwoClusters(store: FakeGraphStore): Promise<{ caleoCommunityId: string; sapCommunityId: string }> {
  store.addEntity("CALEO", "org", "the consultancy");
  store.addEntity("Sommerseminar", "event", "annual summer seminar");
  store.addRelation("CALEO", "Sommerseminar", ["organisiert"], "CALEO organizes the seminar");
  store.addEntity("SAP", "module", "erp system");
  store.addEntity("BCS", "module", "consolidation module");
  store.addRelation("SAP", "BCS", ["ruft_auf"], "SAP calls BCS");

  const clustering = new Neo4jCommunityService({ driver: store.driver() });
  await clustering.refresh({ kind: "delete" });

  const caleoCommunityId = store.entities.get("CALEO")!.communityId!;
  const sapCommunityId = store.entities.get("SAP")!.communityId!;
  assert.notEqual(caleoCommunityId, sapCommunityId);
  return { caleoCommunityId, sapCommunityId };
}

test("sync summarizes each fixture community once and stores summary/theme on the node", async () => {
  const store = new FakeGraphStore();
  const { caleoCommunityId, sapCommunityId } = await seedTwoClusters(store);
  const calls: SummarizerCall[] = [];
  const service = makeService(
    store,
    mockSummarizer(new Map([[caleoCommunityId, { summary: "CALEO organizes the Sommerseminar.", theme: "Events" }]]), calls),
  );

  const result = await service.sync();

  assert.deepEqual(result.errors, []);
  assert.equal(result.communities, 2);
  assert.deepEqual([...result.summarized].sort(), [caleoCommunityId, sapCommunityId].sort());
  assert.equal(calls.length, 2, "one LLM call per community");

  const caleoNode = store.communities.get(caleoCommunityId)!;
  assert.ok(caleoNode, "a Community node exists per detected community");
  assert.equal(caleoNode.summary, "CALEO organizes the Sommerseminar.");
  assert.equal(caleoNode.theme, "Events");
  assert.ok(caleoNode.updatedAt, "updatedAt stamped");

  const callForCaleo = calls.find((c) => c.communityId === caleoCommunityId)!;
  assert.ok(callForCaleo.members.some((m) => m.name === "CALEO"));
  assert.ok(callForCaleo.relations.some((r) => r.source === "CALEO" && r.target === "SOMMERSEMINAR"));

  // MEMBER edges reach every member; ids are stable T1 keys.
  assert.equal(caleoCommunityId, communityIdForMembers(["CALEO", "SOMMERSEMINAR"]));
  for (const member of ["CALEO", "SOMMERSEMINAR"]) {
    assert.ok(store.memberEdges.has(`${caleoCommunityId}\u0000${member}`), `MEMBER edge to ${member}`);
  }
});

test("an unchanged second sync burns zero tokens and preserves summaries", async () => {
  const store = new FakeGraphStore();
  const { caleoCommunityId } = await seedTwoClusters(store);
  const calls: SummarizerCall[] = [];
  const service = makeService(store, mockSummarizer(new Map(), calls));

  await service.sync();
  const before = { ...store.communities.get(caleoCommunityId)! };
  const callsAfterFirst = calls.length;

  const second = await service.sync();

  assert.equal(calls.length, callsAfterFirst, "no additional LLM calls on unchanged membership");
  assert.deepEqual(second.summarized, []);
  assert.equal(second.unchanged, 2);
  assert.deepEqual({ ...store.communities.get(caleoCommunityId)! }, before, "node untouched");
});

test("membership change re-summarizes ONLY the changed community", async () => {
  const store = new FakeGraphStore();
  const { caleoCommunityId, sapCommunityId } = await seedTwoClusters(store);
  const calls: SummarizerCall[] = [];
  const service = makeService(store, mockSummarizer(new Map(), calls));
  await service.sync();

  // A wiki-edit bridges Lüsen into the CALEO cluster → new composition → NEW stable id.
  store.addEntity("Lüsen", "place", "venue village");
  store.addRelation("SOMMERSEMINAR", "LÜSEN", ["findet_statt_in"], "held in Lüsen");
  const clustering = new Neo4jCommunityService({ driver: store.driver() });
  await clustering.refresh({ kind: "wiki-edit", touchedEntityNames: ["Lüsen"] });
  const newCaleoId = store.entities.get("CALEO")!.communityId!;
  assert.notEqual(newCaleoId, caleoCommunityId, "changed composition yields a fresh stable id");
  assert.equal(store.entities.get("SAP")!.communityId, sapCommunityId, "the SAP group keeps its id");

  const sapUpdatedAtBefore = store.communities.get(sapCommunityId)!.updatedAt;
  const second = await service.sync();

  assert.deepEqual(second.summarized, [newCaleoId], "only the changed community is re-summarized");
  assert.equal(second.unchanged, 1);
  assert.equal(calls.length, 3, "two initial + exactly one re-summarize call");
  assert.equal(calls.at(-1)!.communityId, newCaleoId);
  assert.equal(store.communities.get(sapCommunityId)!.updatedAt, sapUpdatedAtBefore, "unchanged community untouched");
});

test("dissolved communities (zero members) are deleted with their MEMBER edges", async () => {
  const store = new FakeGraphStore();
  const { caleoCommunityId, sapCommunityId } = await seedTwoClusters(store);
  const calls: SummarizerCall[] = [];
  const service = makeService(store, mockSummarizer(new Map(), calls));
  await service.sync();
  assert.equal(store.communities.size, 2);

  // Simulate the delete cascade removing the whole SAP group, then re-cluster.
  for (const name of ["SAP", "BCS"]) store.entities.delete(name);
  store.removeRelation("SAP", "BCS");
  const clustering = new Neo4jCommunityService({ driver: store.driver() });
  await clustering.refresh({ kind: "delete" });

  const third = await service.sync();
  assert.ok(third.removed.includes(sapCommunityId), "the dissolved community is removed");
  assert.equal(store.communities.has(sapCommunityId), false);
  assert.equal(store.communities.has(caleoCommunityId), true);
  for (const edge of store.memberEdges) {
    assert.ok(!edge.startsWith(`${sapCommunityId}\u0000`), "its MEMBER edges are gone too");
  }
});

test("the orphan-less invariant holds after refresh+sync: one MEMBER edge per entity", async () => {
  const store = new FakeGraphStore();
  const { caleoCommunityId, sapCommunityId } = await seedTwoClusters(store);
  const service = makeService(store, mockSummarizer(new Map(), []));
  await service.sync();

  store.addEntity("ZOB München", "place");
  store.addRelation("CALEO", "ZOB München");
  await new Neo4jCommunityService({ driver: store.driver() }).refresh({
    kind: "wiki-edit",
    touchedEntityNames: ["ZOB München"],
  });
  await service.sync();

  for (const entity of store.entities.values()) {
    const edges = [...store.memberEdges].filter((e) => e.endsWith(`\u0000${entity.nameUpper}`));
    assert.equal(edges.length, 1, `${entity.nameUpper} belongs to exactly one community`);
    assert.equal(edges[0], `${entity.communityId}\u0000${entity.nameUpper}`, "…and it matches its persisted community_id");
  }
  for (const id of [caleoCommunityId, sapCommunityId]) {
    if (!store.communities.has(id)) continue;
    const hasEdge = [...store.memberEdges].some((e) => e.startsWith(`${id}\u0000`));
    assert.ok(hasEdge, `community ${id} still has members or was deleted`);
  }
});

test("sync embeds each freshly written summary onto the Community node (G4.S9.T3 global retrieval)", async () => {
  const store = new FakeGraphStore();
  const { caleoCommunityId, sapCommunityId } = await seedTwoClusters(store);
  const embedded: string[] = [];
  const service = new Neo4jCommunitySummaryService({
    driver: store.driver(),
    summarizer: mockSummarizer(
      new Map([[caleoCommunityId, { summary: "CALEO organizes the Sommerseminar.", theme: "Events" }]]),
      [],
    ),
    embedder: {
      embed: async (texts) => texts.map((t) => {
        embedded.push(t);
        return [t.length, 1];
      }),
    },
  });

  const result = await service.sync();
  assert.deepEqual(result.errors, []);
  assert.ok(embedded.includes("CALEO organizes the Sommerseminar."), "summary text embedded");
  assert.equal(embedded.length, 2, "one embed per freshly written summary");
  const caleoWrite = store.communities.get(caleoCommunityId)!;
  assert.deepEqual(caleoWrite.embedding, [caleoWrite.summary!.length, 1], "embedding stored on the node");

  // Unchanged second sync: no re-embed (no token burn).
  const second = await service.sync();
  assert.deepEqual(second.summarized, []);
  assert.equal(embedded.length, 2, "unchanged communities are not re-embedded");
});

test("LLM failures degrade without throwing and are retried on the next sync", async () => {
  const store = new FakeGraphStore();
  const { caleoCommunityId, sapCommunityId } = await seedTwoClusters(store);
  const calls: SummarizerCall[] = [];
  const failing = makeService(
    store,
    mockSummarizer(
      new Map(),
      calls,
      (call) => call.communityId === caleoCommunityId,
    ),
  );

  const first = await failing.sync();
  assert.deepEqual(first.errors.map((e) => e.includes(caleoCommunityId)), [true], "failure recorded, not thrown");
  assert.ok(first.summarized.includes(sapCommunityId), "the healthy community still lands");
  assert.ok(!store.communities.get(caleoCommunityId)!.summary, "no summary stored for the failed one");

  const healthy = makeService(store, mockSummarizer(new Map(), calls));
  const second = await healthy.sync();
  assert.deepEqual(second.summarized, [caleoCommunityId], "only the missing summary is retried");
  assert.ok(store.communities.get(caleoCommunityId)!.summary, "retry stores the summary");
  assert.deepEqual(second.errors, []);
});

// ---------------------------------------------------------------------------
// C. Integration — Sommerseminar fixtures through the REAL ingest + T1
//    clustering + T2 summaries; stable ids across independent rebuilds.
// ---------------------------------------------------------------------------

interface SommerDoc {
  documentId: string;
  title: string;
  wikiPath: string;
  entities: RefineOutputRef["entities"];
  relations: RefineOutputRef["relations"];
  chunks: Array<{ id: string; text: string; heading_path: string }>;
}

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

test("Sommerseminar end-to-end: real ingest → cluster → summarize lands a CALEO-centric summary", async () => {
  const store = new FakeGraphStore();
  await ingestSommerDoc(store, SOMMER_DOC_A);
  await ingestSommerDoc(store, SOMMER_DOC_B);

  const clustering = new Neo4jCommunityService({ driver: store.driver() });
  await clustering.refresh({ kind: "delete" });

  const caleoCommunityId = store.entities.get("CALEO")!.communityId!;
  const calls: SummarizerCall[] = [];
  const service = makeService(
    store,
    mockSummarizer(
      new Map([[caleoCommunityId, { summary: "CALEOs Eventwelt: Sommerseminar und C-Day.", theme: "CALEO Events" }]]),
      calls,
    ),
  );
  const result = await service.sync();

  assert.deepEqual(result.errors, []);
  const caleoNode = store.communities.get(caleoCommunityId)!;
  assert.ok(caleoNode?.summary?.includes("Sommerseminar"), "summary text present on the node");

  const call = calls.find((c) => c.communityId === caleoCommunityId)!;
  const memberNames = call.members.map((m) => m.name).sort();
  for (const expected of ["CALEO", "Sommerseminar", "ZOB München", "Lüsen", "C-Day", "Mitarbeiter"]) {
    assert.ok(memberNames.includes(expected), `${expected} is in the summarized member list`);
  }

  // Stable community id survives an independent rebuild of the same corpus.
  const store2 = new FakeGraphStore();
  await ingestSommerDoc(store2, SOMMER_DOC_A);
  await ingestSommerDoc(store2, SOMMER_DOC_B);
  await new Neo4jCommunityService({ driver: store2.driver() }).refresh({ kind: "delete" });
  assert.equal(store2.entities.get("CALEO")!.communityId, caleoCommunityId);
});
