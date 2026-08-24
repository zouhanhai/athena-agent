/**
 * G4.S10.T4 — the KNOWN ENTITIES baseline reader over Neo4j
 * (WikiPage ←IS_DOCUMENT— Document; entities bound by provenance OR mentions).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WIKI_KNOWN_ENTITIES_CAP,
  readWikiKnownEntities,
} from "../../src/kb/store/wiki-baseline.js";
import type { Neo4jDriverLike } from "../../src/kb/store/schema.js";

function recordingDriver(
  records: Array<Record<string, unknown>>,
  opts: { throwOnRun?: Error } = {},
) {
  const calls: Array<{ query: string; params?: Record<string, unknown> }> = [];
  let closed = false;
  const driver: Neo4jDriverLike = {
    session() {
      return {
        run: async (query: string, params?: Record<string, unknown>) => {
          calls.push({ query, params });
          if (opts.throwOnRun) throw opts.throwOnRun;
          return { records: records.map((row) => ({ get: (key: string) => row[key] ?? null })) };
        },
        close: async () => {
          closed = true;
        },
      };
    },
  };
  return { driver, calls, wasClosed: () => closed };
}

test("readWikiKnownEntities resolves the page's document entities in ONE capped query", async () => {
  const { driver, calls, wasClosed } = recordingDriver([
    {
      name: "GALILEO Office",
      type: "location",
      description: "Office at Galileostraße.",
      source_docs: ["doc-1"],
      aliases: ["Galileo Büro"],
    },
    { name: "CALEO", type: "org", description: null, source_docs: null, aliases: [] },
  ]);

  const known = await readWikiKnownEntities(driver, "wiki/events/luesen.md");

  assert.equal(calls.length, 1, "one round-trip per edit");
  const { query, params } = calls[0]!;
  assert.match(query, /WikiPage \{id: \$wikiPath\}/);
  assert.match(query, /IS_DOCUMENT/);
  assert.match(query, /MENTIONED_IN/, "entities bound via mention edges count too");
  assert.match(query, /LIMIT \$cap/);
  assert.equal(params!.wikiPath, "wiki/events/luesen.md");
  assert.equal(params!.cap, WIKI_KNOWN_ENTITIES_CAP, "default cap = 100");
  assert.equal(wasClosed(), true);

  assert.deepEqual(known, [
    {
      name: "GALILEO Office",
      type: "location",
      description: "Office at Galileostraße.",
      source_docs: ["doc-1"],
      aliases: ["Galileo Büro"],
    },
    { name: "CALEO", type: "org" as const },
  ]);
});

test("the cap parameter is enforced (caller can lower it; default stays 100)", async () => {
  WIKI_KNOWN_ENTITIES_CAP;
  const { driver, calls } = recordingDriver([]);
  await readWikiKnownEntities(driver, "wiki/x.md");
  assert.equal(calls[0]!.params!.cap, 100);
  await readWikiKnownEntities(driver, "wiki/x.md", 7);
  assert.equal(calls[1]!.params!.cap, 7);
});

test("a page with no ingested Document yields an empty baseline (first edit before any graph state)", async () => {
  const { driver } = recordingDriver([]);
  assert.deepEqual(await readWikiKnownEntities(driver, "wiki/new/page.md"), []);
});

test("an EMPTY wikiPath short-circuits without touching the graph", async () => {
  const { driver, calls } = recordingDriver([{ name: "X", type: "other" }]);
  assert.deepEqual(await readWikiKnownEntities(driver, ""), []);
  assert.equal(calls.length, 0);
});

test("a graph failure degrades to an empty baseline instead of breaking the edit", async () => {
  const { driver } = recordingDriver([], { throwOnRun: new Error("neo4j down") });
  assert.deepEqual(await readWikiKnownEntities(driver, "wiki/x.md"), []);
});
