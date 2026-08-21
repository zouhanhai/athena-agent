import { test } from "node:test";
import assert from "node:assert/strict";
import { type Neo4jDriverLike } from "../../src/kb/store/schema.js";
import { EntityGraphService } from "../../src/kb/store/graph.js";

interface RecordedCall {
  query: string;
  params: Record<string, unknown>;
}

function record(obj: Record<string, unknown>): { get: (k: string) => unknown } {
  return { get: (k) => obj[k] };
}

/**
 * Driver double seeded with the G4.S8.T12 fixture: two ABAP classes
 * (`ZCL_FI_DELIVERY`, `ZCL_MM_GOODS`) CALL-ing one FM (`FICOMPUTE`) and one CDS
 * view (`I_CNSLDTN`) READS_FROM a table (`MARA`). The FM and the classes each
 * MENTIONED_IN a chunk that bridges to a wiki page; `MARA` has no wiki page.
 *
 * The handler dispatches on the SAME query fragments the real service issues,
 * mirroring the existing store-retrieval test-double pattern.
 */
function makeGraphDriver(): { driver: Neo4jDriverLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const driver: Neo4jDriverLike = {
    session() {
      return {
        run: async (query: string, params?: Record<string, unknown>) => {
          const p = params ?? {};
          calls.push({ query, params: p });
          let records: Record<string, unknown>[] = [];
          // Wiki-path resolution (batched by endpoint nameUpper).
          if (query.includes("IN $names")) {
            const names = (p.names as string[]) ?? [];
            const wikiByUpper: Record<string, string[]> = {
              FICOMPUTE: ["wiki/code/dev/fmcompute.md"],
              ZCL_FI_DELIVERY: ["wiki/code/dev/zcl_fi_delivery.md"],
              I_CNSLDTN: ["wiki/code/dev/i_cnsltdn.md"],
            };
            records = names.map((n) => ({ nameUpper: n, wikiPaths: wikiByUpper[n] ?? [] }));
          } else if (query.includes("-[r:RELATION]->")) {
            // outgoing (uses) for the FM → the table it reads
            if (p.nameUpper === "FICOMPUTE") {
              records = [
                {
                  keywords: ["READS_FROM"],
                  description: "FICOMPUTE READS_FROM MARA",
                  name: "MARA",
                  type: "table",
                },
              ];
            }
          } else if (query.includes("-[r:RELATION]-")) {
            // incoming (used by) for the FM → the two classes that call it
            if (p.nameUpper === "FICOMPUTE") {
              records = [
                {
                  keywords: ["CALLS"],
                  description: "ZCL_FI_DELIVERY CALLS FICOMPUTE",
                  name: "ZCL_FI_DELIVERY",
                  type: "abap_unit",
                },
                {
                  keywords: ["CALLS"],
                  description: "ZCL_MM_GOODS CALLS FICOMPUTE",
                  name: "ZCL_MM_GOODS",
                  type: "abap_unit",
                },
              ];
            } else if (p.nameUpper === "MARA") {
              records = [
                {
                  keywords: ["READS_FROM"],
                  description: "I_CNSLDTN READS_FROM MARA",
                  name: "I_CNSLDTN",
                  type: "cds_view",
                },
              ];
            }
          } else if (query.includes("ORDER BY e.name")) {
            // listEntities: filtered + ordered + limited
            const type = p.type as string | undefined;
            const q = (p.q as string | undefined)?.toUpperCase();
            records = [
              { name: "FICOMPUTE", type: "abap_unit", description: "ABAP function module FICOMPUTE" },
              { name: "I_CNSLDTN", type: "cds_view", description: "CDS view I_CNSLDTN" },
              { name: "MARA", type: "table", description: "SAP table MARA" },
              { name: "ZCL_FI_DELIVERY", type: "abap_unit", description: "ABAP class ZCL_FI_DELIVERY" },
            ]
              .filter((e) => (type ? e.type === type : true))
              .filter((e) => (q ? e.name.toUpperCase().includes(q) : true));
          } else {
            // single-entity lookup
            if (p.nameUpper === "FICOMPUTE") {
              records = [{ name: "FICOMPUTE", type: "abap_unit", description: "ABAP function module FICOMPUTE" }];
            } else if (p.nameUpper === "MARA") {
              records = [{ name: "MARA", type: "table", description: "SAP table MARA" }];
            }
          }
          return { records: records.map(record) };
        },
        close: async () => {},
      };
    },
  };
  return { driver, calls };
}

test("listEntities returns entities filtered by type and case-insensitive name substring", async () => {
  const { driver } = makeGraphDriver();
  const service = new EntityGraphService({ driver });

  const abap = await service.listEntities({ type: "abap_unit", q: "zcl_", limit: 10 });
  assert.deepEqual(
    abap.map((e) => e.name),
    ["ZCL_FI_DELIVERY"],
    "case-insensitive name substring + type filter",
  );

  const all = await service.listEntities({ limit: 10 });
  assert.equal(all.length, 4, "no type filter lists every entity");
});

test("listEntities passes type/q/limit into the Cypher params", async () => {
  const { driver, calls } = makeGraphDriver();
  const service = new EntityGraphService({ driver });

  await service.listEntities({ type: "cds_view", q: "cns", limit: 5 });

  const call = calls.find((c) => c.query.includes("toUpper(e.name) CONTAINS"))!;
  assert.ok(call, "listEntities query issued");
  assert.deepEqual(call.params.type, "cds_view");
  assert.deepEqual(call.params.q, "cns");
  assert.deepEqual(call.params.limit, 5);
  assert.match(call.query, /ORDER BY e\.name/, "ordered by name");
});

test("getEntity returns both directions: outgoing uses + incoming used-by with wiki links", async () => {
  const { driver } = makeGraphDriver();
  const service = new EntityGraphService({ driver });

  const detail = await service.getEntity("FICOMPUTE");
  assert.ok(detail, "entity found");
  assert.equal(detail!.name, "FICOMPUTE");
  assert.equal(detail!.type, "abap_unit");

  // Outgoing = what the FM uses: the MARA table (no wiki page → plain).
  assert.equal(detail!.outgoing.length, 1);
  assert.equal(detail!.outgoing[0]!.entity, "MARA");
  assert.deepEqual(detail!.outgoing[0]!.keywords, ["READS_FROM"]);
  assert.deepEqual(detail!.outgoing[0]!.wikiPaths, [], "no wiki page → no link");

  // Incoming = the WHERE-USED list: both callers appear.
  assert.equal(detail!.incoming.length, 2, "an object referenced by N sources shows all N under used-by");
  const callers = detail!.incoming.map((r) => r.entity).sort();
  assert.deepEqual(callers, ["ZCL_FI_DELIVERY", "ZCL_MM_GOODS"]);
  const fi = detail!.incoming.find((r) => r.entity === "ZCL_FI_DELIVERY")!;
  assert.deepEqual(fi.keywords, ["CALLS"]);
  assert.deepEqual(
    fi.wikiPaths,
    ["wiki/code/dev/zcl_fi_delivery.md"],
    "incoming relation resolves to the caller's wiki page (deep link)",
  );
});

test("getEntity resolves wiki pages via MENTIONED_IN for the outgoing target", async () => {
  const { driver } = makeGraphDriver();
  const service = new EntityGraphService({ driver });

  // A CDS view (I_CNSLDTN) reads MARA; MARA's own page resolution:
  // the outgoing target MARA has no mention → no link.
  const mara = await service.getEntity("MARA");
  assert.ok(mara);
  // MARA's incoming = I_CNSLDTN (the view that reads it) — that source HAS a wiki page.
  assert.equal(mara!.incoming.length, 1);
  assert.deepEqual(
    mara!.incoming[0]!.wikiPaths,
    ["wiki/code/dev/i_cnsltdn.md"],
    "used-by source links to its own wiki page",
  );
});

test("getEntity returns null when the entity does not exist", async () => {
  const { driver } = makeGraphDriver();
  const service = new EntityGraphService({ driver });

  const detail = await service.getEntity("NOPE_NOT_THERE");
  assert.equal(detail, null);
});
