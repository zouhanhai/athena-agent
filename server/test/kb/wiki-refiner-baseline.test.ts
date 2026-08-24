/**
 * G4.S10.T4 — the wiki-edit REFINER wiring: the edited page's `wikiPath`
 * resolves the document's current graph entities (KNOWN ENTITIES baseline)
 * through an injected reader, the baseline reaches the refine prompt, applied
 * renames ride the stored ref (`entity_renames`) into the graph-side
 * overwrite, and a failing reader degrades to a baseline-less refine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createAthenaWikiEditRefiner } from "../../src/kb/refiner.js";
import type { KnownEntity } from "../../src/kb/store/wiki-baseline.js";

const BASELINE: KnownEntity[] = [
  { name: "GALILEO Office", type: "location", description: "Office at Galileostraße.", source_docs: ["doc-1"], aliases: [] },
  { name: "Lüsen", type: "location", description: "Village in South Tyrol.", source_docs: ["doc-1"], aliases: [] },
];

const DELTA_PAYLOAD = {
  summary: "Edited page.",
  sections: [],
  frontmatter: { type: "report", topic: "client/events" },
  renames: [{ from: "GALILEO Office", to: "CALEO Office", type_match: true, reason: "image fix" }],
  added: [],
  removed: [],
  changed_relations: [],
  keywords: [],
  rechunked: false,
  quality: { complete: true, confidence: 0.95, issues: [], action: "auto_accept" },
};

const MARKDOWN = "# Venue\n\nThe image shows the CALEO Office.";

function fakeCaller(payload: unknown) {
  const prompts: string[] = [];
  return {
    prompts,
    caller: async (ctx: { userContent: string }) => {
      prompts.push(ctx.userContent);
      return {
        message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(payload) }] },
      };
    },
  };
}

test("the refiner reads the KNOWN ENTITIES baseline via wikiPath and injects it into the refine prompt", async () => {
  const readPaths: string[] = [];
  const { prompts, caller } = fakeCaller(DELTA_PAYLOAD);
  const refiner = createAthenaWikiEditRefiner({
    storageDir: undefined,
    retries: 0,
    httpCaller: caller as never,
    readBaselineEntities: async (wikiPath) => {
      readPaths.push(wikiPath);
      return BASELINE;
    },
  });

  const result = await refiner({
    markdown: MARKDOWN,
    before: "# Venue\n\nThe image shows GALILEO Office.",
    diff: "-The image shows GALILEO Office.\n+The image shows CALEO Office.",
    structural: false,
    wikiPath: "wiki/events/luesen.md",
  });

  assert.deepEqual(readPaths, ["wiki/events/luesen.md"], "baseline resolved from the edited page's path");
  assert.match(prompts[0]!, /## KNOWN ENTITIES/);
  assert.match(prompts[0]!, /GALILEO Office \(location\)/);
  assert.match(prompts[0]!, /Lüsen \(location\)/);

  // Resolution kept the unmentioned baseline entity + applied the rename;
  // the rename rides the stored REF for the graph-side in-place rename.
  const names = result.ref.entities.map((e) => e.name).sort();
  assert.deepEqual(names, ["CALEO Office", "Lüsen"]);
  assert.deepEqual(result.ref.entity_renames ?? [], [{ from: "GALILEO Office", to: "CALEO Office" }]);
});

test("no wikiPath (or no reader) → no baseline section content, refine still completes", async () => {
  const { prompts, caller } = fakeCaller(DELTA_PAYLOAD);
  const refiner = createAthenaWikiEditRefiner({ retries: 0, httpCaller: caller as never });
  const result = await refiner({
    markdown: MARKDOWN,
    before: MARKDOWN,
    diff: "",
    structural: false,
  });
  assert.doesNotMatch(prompts[0]!, /GALILEO Office \(location\)/);
  // Rename over an empty baseline degrades to a TEXT-GROUNDED add: the new
  // name occurs in the corrected markdown, so the identity survives.
  assert.deepEqual(result.ref.entity_renames ?? [], []);
  assert.ok(
    result.ref.entities.some((e) => e.name === "CALEO Office"),
    "the renamed-to name enters the document set even without a baseline node",
  );
});

test("a FAILING baseline reader degrades to a baseline-less refine instead of breaking the save", async () => {
  const { prompts, caller } = fakeCaller(DELTA_PAYLOAD);
  const refiner = createAthenaWikiEditRefiner({
    retries: 0,
    httpCaller: caller as never,
    readBaselineEntities: async () => {
      throw new Error("neo4j down");
    },
  });
  const result = await refiner({
    markdown: MARKDOWN,
    before: MARKDOWN,
    diff: "",
    structural: false,
    wikiPath: "wiki/events/luesen.md",
  });
  assert.doesNotMatch(prompts[0]!, /GALILEO Office \(location\)/);
  assert.ok(result.ref.entities.length >= 1);
});
