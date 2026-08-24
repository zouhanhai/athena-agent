/**
 * G4.S10.T1 — `Neo4jExistingGraphApi`: the ExistingGraphApi port over the
 * Neo4j store (exact nameUpper / folded aliases / substring / BM25 pool +
 * on-the-fly vector cosine over entity identity text).
 *
 * The fake driver below simulates the relevant Cypher semantics so the lane
 * logic, similarity bands and dedupe/sort behavior are verified without a DB.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ENTITY_NAME_ALIASES_FTX,
  ENTITY_LABEL,
  type Neo4jDriverLike,
} from "../../src/kb/store/schema.js";
import {
  cosineSimilarity,
  entityIdentityText,
  Neo4jExistingGraphApi,
  type EntityIdentity,
} from "../../src/kb/store/entity-match.js";

interface Call {
  query: string;
  params?: Record<string, unknown>;
}

function makeDriver(entities: EntityIdentity[]): {
  driver: Neo4jDriverLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const upper = (value: string) => value.toUpperCase();
  const tokens = (value: string) => value.toLowerCase().split(/[^a-z0-9äöüß]+/i).filter(Boolean);
  return {
    calls,
    driver: {
      session() {
        return {
          run: async (query: string, params: Record<string, unknown> = {}) => {
            calls.push({ query, params });
            if (query.includes(`${ENTITY_LABEL} {nameUpper: $nameUpper}`) && !query.includes("CONTAINS")) {
              const hit = entities.find((e) => e.nameUpper === String(params.nameUpper));
              return {
                records: hit
                  ? [{
                      get: (key: string) =>
                        key === "name" ? hit.name : key === "type" ? (hit.type ?? null) : key === "description" ? (hit.description ?? null) : null,
                    }]
                  : [],
              };
            }
            if (query.includes("IN e.aliases")) {
              const hits = entities.filter(
                (e) => Array.isArray(e.aliases) && e.aliases.map(upper).includes(String(params.nameUpper)),
              );
              return { records: hits.slice(0, Number(params.limit ?? 5)).map(toRecord) };
            }
            if (query.includes("CONTAINS")) {
              const candidate = String(params.nameUpper);
              const hits = entities.filter((e) => {
                if (e.nameUpper === candidate) return false;
                const longEnough = (short: string) => short.length >= 4;
                if (e.nameUpper.includes(candidate) && longEnough(candidate)) return true;
                if (candidate.includes(e.nameUpper) && longEnough(e.nameUpper)) return true;
                return false;
              });
              return { records: hits.slice(0, Number(params.limit ?? 5)).map(toRecord) };
            }
            if (query.includes(`db.index.fulltext.queryNodes('${ENTITY_NAME_ALIASES_FTX}'`)) {
              const queryTokens = new Set(tokens(String(params.queryText)));
              const scored = entities
                .map((entity) => {
                  const hay = new Set([...tokens(entity.name), ...(entity.aliases ?? []).flatMap(tokens)]);
                  let overlap = 0;
                  for (const token of queryTokens) if (hay.has(token)) overlap += 1;
                  return { entity, score: overlap };
                })
                .filter((entry) => entry.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, Number(params.poolLimit ?? 20));
              return {
                records: scored.map(({ entity }) => toRecord(entity)),
              };
            }
            return { records: [] };
          },
          close: async () => {},
        };
      },
    },
  };
}

function toRecord(entity: EntityIdentity): { get(key: string): unknown } {
  return {
    get: (key: string) =>
      key === "name"
        ? entity.name
        : key === "type"
          ? (entity.type ?? null)
          : key === "description"
            ? (entity.description ?? null)
            : null,
  };
}

test("exact nameUpper identity → similarity 1 with an evidence quote", async () => {
  const { driver } = makeDriver([
    { name: "CALEO", nameUpper: "CALEO", type: "org", description: "the parent organization of the group" },
  ]);
  const api = new Neo4jExistingGraphApi({ driver });
  const matches = await api.findMatches({ name: "CALEO", type: "org" }, 5);
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0], {
    name: "CALEO",
    type: "org",
    similarity: 1,
    evidence_quote: "the parent organization of the group",
    source: "exact",
  });
});

test("folded alias hit → high-similarity alias match without an embedder", async () => {
  const { driver } = makeDriver([
    { name: "CALEO", nameUpper: "CALEO", type: "org", aliases: ["CALEO HQ"], description: "hq" },
  ]);
  const api = new Neo4jExistingGraphApi({ driver });
  const matches = await api.findMatches({ name: "Caleo HQ", type: "org" }, 5);
  assert.equal(matches.length, 1, "alias lookup folds case");
  assert.equal(matches[0]!.source, "alias");
  assert.ok(matches[0]!.similarity >= 0.9);
});

test("substring containment (both directions, ≥4 chars) surfaces a deterministic match", async () => {
  const { driver } = makeDriver([
    { name: "CALEO Office", nameUpper: "CALEO OFFICE", type: "org", description: "munich branch" },
  ]);
  const api = new Neo4jExistingGraphApi({ driver });
  const matches = await api.findMatches({ name: "CALEO Office Munich", type: "org" }, 5);
  assert.equal(matches[0]!.source, "substring");

  // Short names never substring-match (noise guard).
  const shortDriver = makeDriver([{ name: "ABCD", nameUpper: "ABCD", type: "org" }]);
  const strictApi = new Neo4jExistingGraphApi({ driver: shortDriver.driver });
  const noNoise = await strictApi.findMatches({ name: "AB", type: "org" }, 5);
  assert.deepEqual(noNoise, []);
});

test("vector tier: pooled candidates are embedded and ranked by real cosine; sub-floor hits dropped", async () => {
  const entities: EntityIdentity[] = [
    { name: "Twin Peaks Org", nameUpper: "TWIN PEAKS ORG", type: "org", description: "nearly identical twin" },
    { name: "Unrelated Corp", nameUpper: "UNRELATED CORP", type: "org", description: "different domain entirely" },
  ];
  const { driver } = makeDriver(entities);
  // Deterministic fake embedder: hash-based vectors so the twin lands close
  // and the unrelated one far away.
  const embed = async (texts: string[]) =>
    texts.map((text) => {
      const vec = new Array(8).fill(0);
      for (let i = 0; i < text.length; i += 1) vec[text.charCodeAt(i) % 8]! += 1;
      return vec;
    });
  const api = new Neo4jExistingGraphApi({ driver, embedder: { embed } });
  const matches = await api.findMatches({ name: "Twin Peaks Ork", type: "org" }, 5);

  assert.ok(matches.some((m) => m.source === "vector"), "BM25-pooled near match got a real vector score");
  const vectorHits = matches.filter((m) => m.source === "vector");
  assert.equal(vectorHits[0]!.name, "Twin Peaks Org", "closest pool entry ranks first");
  assert.ok(vectorHits.every((m) => m.similarity >= 0.6), "sub-floor similarities dropped");
});

test("results merge by identity keeping the best lane and sort descending under the requested limit", async () => {
  const { driver } = makeDriver([
    { name: "CALEO Office", nameUpper: "CALEO OFFICE", type: "org", aliases: ["GALLEO OFFICE"], description: "branch" },
  ]);
  const api = new Neo4jExistingGraphApi({ driver });
  // Candidate equals an alias AND is a superstring — exact-lane wins (sim 0.98 > 0.9).
  const matches = await api.findMatches({ name: "galleo office", type: "org" }, 5);
  assert.equal(matches.length, 1, "one entry per existing entity");
  assert.equal(matches[0]!.source, "alias");
});

test("cosineSimilarity handles zero vectors and unit direction", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [2, 4, 6]) - 1) < 1e-9);
});

test("entityIdentityText folds name/type/description into one bounded embedding input", () => {
  const text = entityIdentityText({ name: "CALEO", type: "org", description: "the group" });
  assert.ok(text.startsWith("CALEO"));
  assert.ok(text.includes("org"));
  assert.ok(text.length <= 320);
});
