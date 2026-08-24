import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  MemoryKbAuditRunsStore,
  type KbAuditRunRecord,
} from "../../src/kb/audit-runs.js";
import { KbAuditService } from "../../src/kb/audit.js";
import {
  DEFAULT_LINK_ENGINE,
  KbRelinkService,
  type KbRelinkReport,
  type RelinkGraphPort,
} from "../../src/kb/relink/relink-service.js";
import {
  RELINK_SIMILARITY_THRESHOLD,
  scanRelinkCandidates,
  type RelinkEntitySnapshot,
} from "../../src/kb/relink/relink-scan.js";
import { linkCandidates, type LinkMerge, type LinkNewEdge } from "../../src/kb/link/link-engine.js";
import type { TextEmbedder } from "../../src/kb/embedding.js";
import {
  Neo4jRelinkGraphPort,
} from "../../src/kb/store/relink-graph.js";
import type { Neo4jDriverLike } from "../../src/kb/store/schema.js";

// --- fixtures -----------------------------------------------------------------

function snapshot(overrides: Partial<RelinkEntitySnapshot> & { name: string }): RelinkEntitySnapshot {
  return {
    nameUpper: overrides.name.toUpperCase(),
    degree: 0,
    ...overrides,
  };
}

/** Deterministic embedder: identity texts starting with a fixture name get that fixture's vector. */
function fakeEmbedder(vectorsByName: Record<string, number[]>): TextEmbedder {
  const names = Object.keys(vectorsByName).sort((a, b) => b.length - a.length);
  return {
    embed: async (texts: string[]) =>
      texts.map((text) => {
        for (const name of names) {
          if (text === name || text.startsWith(`${name} `) || text.startsWith(`${name}(`)) {
            return vectorsByName[name]!;
          }
        }
        return [0, 0, 1];
      }),
  };
}

function pairKey(a: string, b: string): string {
  const [x, y] = [a.toUpperCase(), b.toUpperCase()].sort();
  return `${x}|${y}`;
}

function findByPair(
  pairs: Array<{ a: string; b: string }>,
  nameA: string,
  nameB: string,
): { a: string; b: string; similarity: number; reasons: string[] } | undefined {
  const key = pairKey(nameA, nameB);
  return pairs.find((p) => pairKey(p.a, p.b) === key) as never;
}

// --- deterministic pre-scan -----------------------------------------------------

test("pre-scan discovers near-duplicate pairs via embedding cosine >= 0.85 (no LLM)", async () => {
  const entities = [
    snapshot({ name: "CALEO", type: "org", description: "the group" }),
    snapshot({ name: "CALEO Group", type: "org", description: "the group" }),
    snapshot({ name: "Unrelated Corp", type: "org", description: "something else" }),
  ];
  const pairs = await scanRelinkCandidates(entities, {
    embedder: fakeEmbedder({
      CALEO: [1, 0],
      "CALEO Group": [0.99, 0.14],
      "Unrelated Corp": [-1, 0],
    }),
  });

  const hit = findByPair(pairs, "CALEO", "CALEO Group");
  assert.ok(hit, "high-cosine pair discovered");
  assert.ok(hit.similarity >= RELINK_SIMILARITY_THRESHOLD);
  assert.ok(hit.reasons.includes("vector"));
  assert.equal(findByPair(pairs, "CALEO", "Unrelated Corp"), undefined);
});

test("pre-scan flags alias/name variants and identical-fold different-type clusters", async () => {
  const entities = [
    snapshot({ name: "CALEO", type: "org", aliases: ["Caleo Group"] }),
    snapshot({ name: "Caleo Group", type: "org" }),
    snapshot({ name: "zob", type: "location" }),
    snapshot({ name: "ZOB", type: "org" }),
  ];
  const pairs = await scanRelinkCandidates(entities);

  const aliasHit = findByPair(pairs, "CALEO", "Caleo Group");
  assert.ok(aliasHit, "alias variant discovered without embeddings");
  assert.ok(aliasHit.reasons.includes("name-variant"));

  const foldHit = findByPair(pairs, "zob", "ZOB");
  assert.ok(foldHit, "case-fold identity collision discovered");
  assert.ok(foldHit.reasons.includes("same-name-different-type"), "type conflict flagged");
});

test("pre-scan dedupes lanes into one pair per unordered key and caps the queue", async () => {
  const entities = [
    snapshot({ name: "CALEO", type: "org", aliases: ["CALEO Group"], description: "x" }),
    snapshot({ name: "CALEO Group", type: "org", description: "x" }),
  ];
  const pairs = await scanRelinkCandidates(entities, {
    embedder: fakeEmbedder({ CALEO: [1, 0], "CALEO Group": [1, 0] }),
  });
  const sameKeyPairs = pairs.filter((p) => pairKey(p.a, p.b) === pairKey("CALEO", "CALEO Group"));
  assert.equal(sameKeyPairs.length, 1, "one pair despite alias + vector lanes both firing");
  assert.ok(sameKeyPairs[0]!.reasons.includes("vector"));
  assert.ok(sameKeyPairs[0]!.reasons.includes("name-variant"));

  const many = Array.from({ length: 50 }, (_, i) =>
    snapshot({ name: `Dup ${i}`, type: "concept", description: "same" }),
  );
  const capped = await scanRelinkCandidates(many, {
    embedder: fakeEmbedder(Object.fromEntries(many.map((m) => [m.name, [1, 0]]))),
    maxPairs: 10,
  });
  assert.equal(capped.length, 10, "pair queue cap honored");
});

// --- service: reuse of the T1 engine via dependency injection -------------------

interface FakePortOptions {
  entities?: RelinkEntitySnapshot[];
  changedSince?: string[];
  mergeErrors?: boolean;
}

function fakePort(options: FakePortOptions = {}): RelinkGraphPort & {
  merges: LinkMerge[][];
  edges: LinkNewEdge[][];
} {
  return {
    merges: [],
    edges: [],
    async listEntities() {
      return options.entities ?? [];
    },
    async entitiesChangedSince() {
      return options.changedSince ?? [];
    },
    async applyMerges(merges: LinkMerge[]) {
      if (options.mergeErrors) throw new Error("neo4j write failed");
      if (merges.length > 0) this.merges.push(merges);
      return merges.length;
    },
    async createEdges(edges: LinkNewEdge[]) {
      if (edges.length > 0) this.edges.push(edges);
      return edges.length;
    },
  };
}

test("DEFAULT_LINK_ENGINE is the T1 linkCandidates — the weekly pass adds no second engine", () => {
  assert.equal(DEFAULT_LINK_ENGINE, linkCandidates);
});

test("weekly re-link routes candidates through the injected linkCandidates engine and applies decisions", async () => {
  const entities = [
    snapshot({ name: "CALEO", type: "org", description: "the group", degree: 2 }),
    snapshot({ name: "CALEO Group", type: "org", description: "the group", degree: 0 }),
    snapshot({ name: "SAP", type: "org", description: "erp vendor", degree: 1 }),
    snapshot({ name: "BTP", type: "product", description: "platform", degree: 0 }),
  ];
  const port = fakePort({ entities });
  const engineInputs: Parameters<typeof linkCandidates>[0][] = [];
  // DI PROOF: the spy delegates to the REAL engine — same rules, same validation.
  const spyEngine: typeof linkCandidates = async (input) => {
    engineInputs.push(input);
    return linkCandidates(input);
  };
  const llm = async ({
    userContent,
  }: {
    userContent: string;
  }): Promise<{ message: { content: Array<{ type: string; text?: string }> } }> => {
    const parsed = JSON.parse(userContent) as {
      candidates: Array<{ name: string }>;
      existing_matches: Record<string, Array<{ name: string }>>;
    };
    const merges: unknown[] = [];
    const edges: unknown[] = [];
    const standalone: string[] = [];
    for (const candidate of parsed.candidates) {
      const match = parsed.existing_matches[candidate.name]?.[0];
      if (!match) {
        standalone.push(candidate.name);
      } else if (candidate.name === "BTP") {
        // different products stay separate
        standalone.push(candidate.name);
      } else if (candidate.name === "CALEO AG") {
        edges.push({
          source: candidate.name,
          target: match.name,
          relation: "HAS_OFFICE",
          evidence_quote: "office quote",
        });
      } else {
        merges.push({
          from: candidate.name,
          to: match.name,
          similarity: 0.75,
          evidence: "same thing",
        });
      }
    }
    return {
      message: {
        content: [{ type: "text", text: JSON.stringify({ merges, new_edges: edges, standalone }) }],
      },
    };
  };

  const service = new KbRelinkService({
    graph: port,
    embedder: fakeEmbedder({
      CALEO: [1, 0],
      "CALEO Group": [0.99, 0.14],
      SAP: [0.6, 0.6],
      BTP: [0.59, 0.61],
    }),
    llm,
    linkEngine: spyEngine,
  });
  const report = await service.run();

  assert.equal(engineInputs.length >= 1, true, "engine invoked through the DI seam");
  for (const input of engineInputs) {
    assert.ok(input.existingGraphApi, "candidates carried a pre-ranked match source");
  }
  assert.equal(report.trigger, "weekly");
  assert.equal(report.candidateCount, 2, "two pre-scan candidate pairs");
  assert.deepEqual(
    port.merges.flat().map((m) => [m.from, m.to]),
    [["CALEO Group", "CALEO"]],
    "only the deterministic high-similarity same-type pair merged",
  );
  assert.equal(report.mergesApplied, 1);
  assert.equal(report.unmergedCount, 1, "LLM-declined pair reported unmerged");
  const unmerged = report.unmergedCandidates[0]!;
  assert.equal(unmerged.similarity >= RELINK_SIMILARITY_THRESHOLD, true, "unmerged carries similarity");
});

test("weekly report counts LLM calls (bounded cost: LLM only on candidate pairs)", async () => {
  const entities = [
    snapshot({ name: "CALEO", type: "org", description: "the group", degree: 2 }),
    snapshot({ name: "CALEO Group", type: "org", description: "the group", degree: 0 }),
    snapshot({ name: "Lone Wolf", type: "concept", description: "no duplicate", degree: 0 }),
  ];
  const port = fakePort({ entities });
  let llmCalls = 0;
  const service = new KbRelinkService({
    graph: port,
    embedder: fakeEmbedder({
      CALEO: [1, 0],
      // cosine ≈ 0.878 — above the 0.85 pre-scan floor, below the 0.92 auto-merge → LLM tier
      "CALEO Group": [0.88, 0.48],
      "Lone Wolf": [0, 1],
    }),
    llm: async () => {
      llmCalls += 1;
      return {
        message: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ merges: [], new_edges: [], standalone: ["CALEO Group"] }),
            },
          ],
        },
      };
    },
  });
  const report = await service.run();

  assert.equal(llmCalls, 1, "one adjudication call for the single ambiguous batch");
  assert.equal(report.llmCalls, 1, "llmCalls observable in the report");
  assert.equal(port.merges.length, 0, "nothing merged");
  assert.equal(report.unmergedCount, 1);
  // The no-pair entity cost ZERO LLM work: one call covered exactly the candidates.
  assert.ok(!report.merges.some((m) => m.from === "Lone Wolf"));
});

test("incremental sweep feeds changed-provenance and low-degree entities through the SAME engine", async () => {
  const entities = [
    snapshot({ name: "Fresh Entity", type: "org", description: "newly documented", degree: 0 }),
    snapshot({ name: "Old Hub", type: "org", description: "well connected", degree: 5 }),
  ];
  const port = fakePort({ entities, changedSince: ["FRESH ENTITY"] });
  const matchedAgainst: string[] = [];
  const service = new KbRelinkService({
    graph: port,
    existingGraphApi: {
      findMatches: async (candidate) => {
        matchedAgainst.push(candidate.name);
        if (candidate.name === "Fresh Entity") {
          return [
            {
              name: "Old Hub",
              type: "org",
              similarity: 0.8,
              evidence_quote: "same org",
              source: "vector",
            },
          ];
        }
        return [];
      },
    },
    llm: async ({ userContent }) => {
      const parsed = JSON.parse(userContent) as { candidates: Array<{ name: string }> };
      const merges = parsed.candidates
        .filter((c) => c.name === "Fresh Entity")
        .map((c) => ({ from: c.name, to: "Old Hub", similarity: 0.8, evidence: "same org" }));
      return {
        message: {
          content: [{ type: "text", text: JSON.stringify({ merges, new_edges: [], standalone: [] }) }],
        },
      };
    },
  });
  const report = await service.run();

  assert.ok(matchedAgainst.includes("Fresh Entity"), "changed entity went through the engine matcher");
  assert.ok(!matchedAgainst.includes("Old Hub"), "well-connected unchanged entity skipped");
  assert.equal(report.incrementalEntities, 1);
  assert.deepEqual(
    port.merges.flat().map((m) => [m.from, m.to]),
    [["Fresh Entity", "Old Hub"]],
  );
});

test("new edges retarget through merge renames and apply counts are truthful", async () => {
  // Cluster: CALEO (hub) ← CALEO Group (auto-merge) ← Caleo GmbH (ambiguous).
  // The LLM legally emits Caleo GmbH -[PART_OF]-> CALEO Group (both in the
  // candidate/existing universe); after CALEO Group merges into CALEO the edge
  // must land on the survivor.
  const entities = [
    snapshot({ name: "CALEO", type: "org", description: "the group", degree: 2 }),
    snapshot({ name: "CALEO Group", type: "org", description: "the group", degree: 0 }),
    snapshot({ name: "Caleo GmbH", type: "org", description: "the gmbh", degree: 0 }),
  ];
  const port = fakePort({ entities });
  const service = new KbRelinkService({
    graph: port,
    embedder: fakeEmbedder({
      // cos(CALEO, CALEO Group) ≈ 0.96 → auto-merge tier;
      // cos(CALEO, Caleo GmbH) ≈ 0.87 → ambiguous (LLM tier);
      // cos(CALEO Group, Caleo GmbH) ≈ 0.72 → below the 0.85 floor (no pair).
      CALEO: [1, 0, 0],
      "CALEO Group": [0.96, 0.28, 0],
      "Caleo GmbH": [0.87, -0.4, 0.28],
    }),
    llm: async ({ userContent }) => {
      const parsed = JSON.parse(userContent) as { candidates: Array<{ name: string }> };
      return {
        message: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                merges: [],
                new_edges: parsed.candidates.map((c) => ({
                  source: c.name,
                  target: "CALEO Group",
                  relation: "PART_OF",
                  evidence_quote: "group quote",
                })),
                standalone: [],
              }),
            },
          ],
        },
      };
    },
  });
  const report = await service.run();

  assert.deepEqual(
    port.merges.flat().map((m) => [m.from, m.to]),
    [["CALEO Group", "CALEO"]],
    "high-similarity same-type pair auto-merged",
  );
  const edges = port.edges.flat();
  assert.equal(edges.length, 1, "edge from the surviving cluster, retargeted onto the canonical node");
  assert.equal(edges[0]!.source, "Caleo GmbH");
  assert.equal(edges[0]!.target, "CALEO", "edge endpoint renamed through the merge map");
  assert.equal(report.newEdgesCreated, 1);
  assert.ok(report.newEdges[0]!.relation.length > 0);
});

test("graph failures degrade into report errors instead of throwing", async () => {
  const entities = [
    snapshot({ name: "CALEO", type: "org", description: "g" }),
    snapshot({ name: "CALEO Group", type: "org", description: "g" }),
  ];
  const port = fakePort({ entities, mergeErrors: true });
  const service = new KbRelinkService({
    graph: port,
    embedder: fakeEmbedder({ CALEO: [1, 0], "CALEO Group": [0.99, 0.1] }),
  });
  const report = await service.run();
  assert.equal(report.mergesApplied, 0);
  assert.ok(report.errors.some((e) => e.includes("neo4j write failed")));
});

test("concurrent second run rejects while one re-link is running", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const slowPort: RelinkGraphPort = {
    ...fakePort(),
    listEntities: async () => {
      await gate;
      return [];
    },
  };
  const service = new KbRelinkService({ graph: slowPort });
  const first = service.run();
  await assert.rejects(() => service.run(), /already running/);
  release();
  await first;
});

// --- Neo4j graph port ------------------------------------------------------------

interface RecordedCall {
  query: string;
  params?: Record<string, unknown>;
}

function makeRecordingDriver(handlers: Array<(call: RecordedCall) => unknown> = []): {
  driver: Neo4jDriverLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const driver: Neo4jDriverLike = {
    session() {
      return {
        run: async (query: string, params?: Record<string, unknown>) => {
          const call = { query, params };
          calls.push(call);
          for (const handler of handlers) {
            const result = handler(call);
            if (result !== undefined) return result;
          }
          return { records: [] };
        },
        close: async () => {},
      };
    },
  };
  return { driver, calls };
}

const EXIST_HANDLER = (call: RecordedCall) => {
  if (call.query.includes("relink_endpoints_exist")) {
    return { records: [{ get: () => 1 }] };
  }
  return undefined;
};

test("applyMerges redirects relations, folds provenance and deletes the source node under the write lock", async () => {
  const { driver, calls } = makeRecordingDriver([EXIST_HANDLER]);
  const port = new Neo4jRelinkGraphPort({ driver });

  const applied = await port.applyMerges([
    { from: "caleo group", to: "CALEO", similarity: 0.93, evidence: "same" },
  ]);

  assert.equal(applied, 1);
  const joined = calls.map((c) => c.query).join("\n");
  assert.ok(joined.includes("RELATION"), "outgoing + incoming relation redirect");
  assert.ok(joined.includes("MENTIONED_IN"), "mention edges move to the survivor");
  assert.ok(joined.includes("DETACH DELETE"), "source node removed");
  assert.ok(joined.includes("source_docs"), "provenance union folds into the target");
  const fold = calls.find((c) => c.query.includes("DETACH DELETE"));
  assert.equal(fold!.params!.fromUpper, "CALEO GROUP");
  assert.equal(fold!.params!.toUpper, "CALEO");
});

test("applyMerges skips self-merges and pairs whose endpoints are not both present", async () => {
  const { driver, calls } = makeRecordingDriver(); // existence probe returns nothing
  const port = new Neo4jRelinkGraphPort({ driver });

  const applied = await port.applyMerges([
    { from: "CALEO", to: "CALEO", similarity: 1, evidence: "self" },
    { from: "Ghost", to: "CALEO", similarity: 0.9, evidence: "missing endpoint" },
  ]);

  assert.equal(applied, 0, "validation rule mirrors the T1 endpoint checks");
  assert.equal(calls.filter((c) => c.query.includes("DETACH DELETE")).length, 0);
});

test("createEdges writes only genuinely-missing edges and counts truthfully", async () => {
  const { driver, calls } = makeRecordingDriver([
    (call) => {
      if (call.query.includes("$names")) {
        // every probed endpoint exists
        const names = (call.params?.names as string[]) ?? [];
        return {
          records: names.map((n) => ({ get: (key: string) => (key === "name" ? n : null) })),
        };
      }
      if (call.query.includes("$pairs")) {
        return {
          records: [
            // CALEO -[RELATION]-> ZOB München already exists…
            { get: (key: string) => (key === "exists" ? true : "CALEO|ZOB MÜNCHEN") },
            // …but CALEO -[RELATION]-> BTP does not.
            { get: (key: string) => (key === "exists" ? false : "CALEO|BTP") },
          ],
        };
      }
      return undefined;
    },
  ]);
  const port = new Neo4jRelinkGraphPort({ driver });

  const created = await port.createEdges([
    { source: "CALEO", target: "ZOB München", relation: "HAS_OFFICE", evidence_quote: "hq" },
    { source: "CALEO", target: "BTP", relation: "RUNS_ON", evidence_quote: "q2" },
  ]);

  assert.equal(created, 1, "existing edge not double-written, missing one created");
  const creates = calls.filter((c) => c.query.includes("CREATE (s)-[r:RELATION]->(t)"));
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0]!.params!.relation, "RUNS_ON");

  // Phantom endpoints (either side missing) are dropped by the existence probe.
  const phantomDriver = makeRecordingDriver(); // probes return nothing
  const phantomPort = new Neo4jRelinkGraphPort({ driver: phantomDriver.driver });
  const phantom = await phantomPort.createEdges([
    { source: "Ghost", target: "CALEO", relation: "X", evidence_quote: "" },
  ]);
  assert.equal(phantom, 0, "phantom endpoints dropped");
});

test("listEntities snapshots identities with provenance + degree; entitiesChangedSince reads fresh docs", async () => {
  const { driver, calls } = makeRecordingDriver([
    (call) => {
      if (call.query.includes("degree")) {
        return {
          records: [
            {
              get: (key: string) => {
                switch (key) {
                  case "name":
                    return "CALEO";
                  case "nameUpper":
                    return "CALEO";
                  case "type":
                    return "org";
                  case "description":
                    return "the group";
                  case "aliases":
                    return ["Caleo"];
                  case "sourceDocs":
                    return ["doc-1"];
                  case "degree":
                    return 3;
                  default:
                    return null;
                }
              },
            },
          ],
        };
      }
      if (call.query.includes("ingested_at")) {
        return { records: [{ get: (key: string) => (key === "names" ? ["CALEO"] : null) }] };
      }
      return undefined;
    },
  ]);
  const port = new Neo4jRelinkGraphPort({ driver });

  const entities = await port.listEntities();
  assert.equal(entities.length, 1);
  assert.equal(entities[0]!.nameUpper, "CALEO");
  assert.deepEqual(entities[0]!.sourceDocs, ["doc-1"]);
  assert.equal(entities[0]!.degree, 3);

  const changed = await port.entitiesChangedSince("2026-08-17T00:00:00.000Z");
  assert.deepEqual([...changed], ["CALEO"]);
  assert.ok(
    calls.some((c) => c.params?.since === "2026-08-17T00:00:00.000Z"),
    "the watermark rides the changed-since lookup",
  );
});

// --- audit integration (T15 flow) -------------------------------------------------

function fakeReview(scanned = 1) {
  return {
    reviewAll: async () => ({
      runAt: "2026-08-24",
      scanned,
      changed: 0,
      archive: [],
      results: [],
    }),
  };
}

test("the weekly audit runs the full-graph re-link and persists the trigger=weekly report", async () => {
  const runs = new MemoryKbAuditRunsStore();
  await runs.insert({
    id: "prev",
    trigger: "scheduled",
    startedAt: "2026-08-17T03:00:00.000Z",
    durationMs: 1,
    review: { runAt: "2026-08-17", scanned: 0, changed: 0, archive: [], results: [] },
    fileCheck: { repaired: 0, details: [] },
    orphans: { scannedDirs: 0, removed: [], kept: [] },
  });
  const seenWatermarks: Array<string | undefined> = [];
  const relinkReport: KbRelinkReport = {
    trigger: "weekly",
    scannedEntities: 12,
    candidateCount: 3,
    llmCalls: 1,
    mergesApplied: 1,
    unmergedCount: 1,
    newEdgesCreated: 1,
    incrementalEntities: 2,
    merges: [{ from: "CALEO Group", to: "CALEO", similarity: 0.95, evidence: "same" }],
    unmergedCandidates: [{ a: "SAP", b: "BTP", similarity: 0.86, reasons: ["vector"] }],
    newEdges: [{ source: "CALEO", target: "ZOB München", relation: "HAS_OFFICE", evidence_quote: "q" }],
    errors: [],
  };

  const service = new KbAuditService({
    review: fakeReview(),
    runsStore: runs,
    relink: {
      run: async (input) => {
        seenWatermarks.push(input.sinceIso);
        return relinkReport;
      },
    },
  });
  const record = await service.run("scheduled");

  assert.deepEqual(seenWatermarks, ["2026-08-17T03:00:00.000Z"], "watermark = last audit time");
  assert.equal(record.relink?.trigger, "weekly");
  assert.equal(record.relink?.mergesApplied, 1);
  assert.equal(record.relink?.llmCalls, 1);
  const persisted = await runs.latestByTrigger("scheduled");
  assert.equal(persisted?.relink?.candidateCount, 3, "report survives the runs store roundtrip");
});

test("a failing re-link degrades to a details line without failing the audit", async () => {
  const runs = new MemoryKbAuditRunsStore();
  const service = new KbAuditService({
    review: fakeReview(),
    runsStore: runs,
    relink: {
      run: async () => {
        throw new Error("embedder down");
      },
    },
  });
  const record = await service.run("manual");

  assert.equal(record.relink, undefined);
  assert.ok(record.fileCheck.details.some((d) => d.includes("re-link") && d.includes("embedder down")));
});

test("audits without a relink port simply omit the section", async () => {
  const runs = new MemoryKbAuditRunsStore();
  const service = new KbAuditService({ review: fakeReview(), runsStore: runs });
  const record = await service.run("scheduled");
  assert.equal(record.relink, undefined);
});

let _recordShape: KbAuditRunRecord | undefined;
beforeEach(() => {
  _recordShape = undefined;
});
