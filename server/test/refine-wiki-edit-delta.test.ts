/**
 * G4.S10.T4 — delta-grounded wiki-edit refinement.
 *
 * The wiki-edit refine no longer re-emits the FULL entity list: the edit path
 * reads the document's CURRENT entities from the graph (KNOWN ENTITIES
 * baseline, capped) and the LLM emits only a DELTA over that baseline
 * ({renames, added, removed, changed_relations}). Resolution applies the delta
 * over the baseline so UNMENTIONED baseline entities are implicitly kept — an
 * LLM omission can no longer orphan a real entity (the GALILEO Office bug).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WIKI_EDIT_REFINE_SYSTEM_PROMPT,
  applyWikiEditDelta,
  buildWikiEditRefinePrompt,
  formatKnownEntitiesBlock,
  normalizeWikiEditDelta,
  resolveWikiEditRefinement,
  runWikiEditRefine,
  type WikiEditDelta,
} from "../src/agents/refine-document.js";
import { WIKI_KNOWN_ENTITIES_CAP, type KnownEntity } from "../src/kb/store/wiki-baseline.js";
import type { RefinementEntity } from "../src/agents/refine-document.js";

const BASELINE: RefinementEntity[] = [
  { name: "CALEO", type: "org", description: "The organizer.", aliases: ["CALEO Group"] },
  { name: "GALILEO Office", type: "location", description: "Office at Galileostraße." },
  { name: "Lüsen", type: "location", description: "Village in South Tyrol." },
];

const EMPTY_DELTA: WikiEditDelta = {
  renames: [],
  added: [],
  removed: [],
  changed_relations: [],
};

function names(entities: RefinementEntity[]): string[] {
  return entities.map((e) => e.name);
}

// --- implicit keep: the core no-orphan guarantee ---

test("an EMPTY delta keeps every baseline entity (implicit keep — LLM omission cannot orphan)", () => {
  const resolved = applyWikiEditDelta(BASELINE, EMPTY_DELTA, "CALEO meets at GALILEO Office near Lüsen.");
  assert.deepEqual(names(resolved.entities).sort(), ["CALEO", "GALILEO Office", "Lüsen"]);
  assert.deepEqual(resolved.renames, [], "no rename recorded");
});

test("unchanged baseline entities keep their type/description/aliases verbatim", () => {
  const resolved = applyWikiEditDelta(BASELINE, EMPTY_DELTA, "text");
  const caléo = resolved.entities.find((e) => e.name === "CALEO")!;
  assert.equal(caléo.type, "org");
  assert.equal(caléo.description, "The organizer.");
  assert.deepEqual(caléo.aliases, ["CALEO Group"]);
});

// --- renames ---

test("rename updates the node name, records the old name as alias and preserves the rest", () => {
  const resolved = applyWikiEditDelta(
    BASELINE,
    {
      ...EMPTY_DELTA,
      renames: [{ from: "GALILEO Office", to: "CALEO Office", type_match: true, reason: "image description corrected" }],
    },
    "The image shows the CALEO Office.",
  );
  assert.deepEqual(names(resolved.entities).sort(), ["CALEO", "CALEO Office", "Lüsen"]);
  const renamed = resolved.entities.find((e) => e.name === "CALEO Office")!;
  assert.equal(renamed.type, "location", "type preserved through the rename");
  assert.equal(renamed.description, "Office at Galileostraße.", "description preserved");
  assert.ok(
    (renamed.aliases ?? []).some((a) => a.toUpperCase() === "GALILEO OFFICE"),
    "the old name becomes an alias",
  );
  assert.deepEqual(resolved.renames, [{ from: "GALILEO Office", to: "CALEO Office" }]);
});

test("rename matching is case-insensitive; renaming an unknown entity is ignored", () => {
  const resolved = applyWikiEditDelta(
    BASELINE,
    { ...EMPTY_DELTA, renames: [{ from: "galileo office", to: "CALEO Office" }, { from: "Ghost Spa", to: "Ghost Bar" }] },
    "text",
  );
  assert.ok(resolved.entities.some((e) => e.name === "CALEO Office"));
  assert.ok(!resolved.entities.some((e) => e.name === "Ghost Bar"), "no phantom rename target");
  assert.deepEqual(
    resolved.renames.map((r) => r.from),
    ["galileo office"],
    "only the applied rename is transported to the store",
  );
});

test("changed_relations endpoints follow the rename map", () => {
  const resolved = applyWikiEditDelta(
    BASELINE,
    {
      ...EMPTY_DELTA,
      renames: [{ from: "GALILEO Office", to: "CALEO Office" }],
      changed_relations: [
        { source: "CALEO", target: "GALILEO Office", keywords: ["operates"], description: "CALEO runs its office." },
      ],
    },
    "text",
  );
  assert.deepEqual(resolved.relations, [
    { source: "CALEO", target: "CALEO Office", keywords: ["operates"], description: "CALEO runs its office." },
  ]);
});

// --- add / remove semantics ---

test("added entities are created; duplicates against the baseline are merged (aliases unioned)", () => {
  const resolved = applyWikiEditDelta(
    BASELINE,
    {
      ...EMPTY_DELTA,
      added: [
        { name: "ZOB München", type: "location", description: "Bus station." },
        { name: "CALEO", type: "org", description: "Re-derived description.", aliases: ["CALEO e.V."] },
      ],
    },
    "text",
  );
  assert.deepEqual(
    names(resolved.entities).sort(),
    ["CALEO", "GALILEO Office", "Lüsen", "ZOB München"],
    "exactly one CALEO — the added copy does not duplicate the baseline node",
  );
  const caléo = resolved.entities.find((e) => e.name === "CALEO")!;
  assert.deepEqual(caléo.aliases?.sort(), ["CALEO Group", "CALEO e.V."], "aliases unioned");
});

test("removed drops the entity ONLY when the corrected text really lacks it; a still-present name is kept", () => {
  const resolved = applyWikiEditDelta(
    BASELINE,
    { ...EMPTY_DELTA, removed: ["Lüsen", "CALEO"] },
    "CALEO hosts the seminar at GALILEO Office.",
  );
  assert.ok(!resolved.entities.some((e) => e.name === "Lüsen"), "absent from text → removal honored");
  assert.ok(resolved.entities.some((e) => e.name === "CALEO"), "still present (case-insensitive) → kept despite removal");
});

test("removal honors aliases too — a text mention of an alias blocks the removal", () => {
  const resolved = applyWikiEditDelta(
    BASELINE,
    { ...EMPTY_DELTA, removed: ["CALEO"] },
    "The CALEO Group runs the event.",
  );
  assert.ok(resolved.entities.some((e) => e.name === "CALEO"), "alias 'CALEO Group' occurs in the text");
});

// --- normalization ---

test("normalizeWikiEditDelta coerces a raw payload into the delta shape (JSON-string args tolerated)", () => {
  const raw = JSON.stringify({
    summary: "Edited page.",
    frontmatter: { type: "concept", topic: "ops" },
    renames: [{ from: "GALILEO Office", to: "CALEO Office", type_match: false, reason: "VLM misread" }],
    added: [{ name: "ZOB München", type: "location" }],
    removed: ["Ghost Spa"],
    changed_relations: [{ source: "CALEO", target: "CALEO Office", keywords: [], description: "" }],
    rechunked: false,
  });
  const delta = normalizeWikiEditDelta(raw);
  assert.equal(delta.renames.length, 1);
  assert.equal(delta.renames[0]!.to, "CALEO Office");
  assert.equal(delta.renames[0]!.type_match, false);
  assert.equal(delta.added.length, 1);
  assert.deepEqual(delta.removed, ["Ghost Spa"]);
  assert.equal(delta.changed_relations.length, 1);
});

// --- resolveWikiEditRefinement: delta + baseline → the FULL refinement ---

const RAW_DELTA_PAYLOAD = {
  markdown: "",
  summary: "Corrected runbook.",
  sections: [{ title: "Runbook", summary: "Corrected." }],
  frontmatter: { type: "concept", topic: "ops" },
  renames: [{ from: "GALILEO Office", to: "CALEO Office", type_match: true, reason: "image fix" }],
  added: [{ name: "ZOB München", type: "location", description: "Bus station." }],
  removed: [],
  changed_relations: [
    { source: "CALEO", target: "CALEO Office", keywords: ["operates"], description: "CALEO runs the office." },
  ],
  keywords: ["runbook"],
  rechunked: false,
  quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
};

test("resolveWikiEditRefinement produces the FULL entity set (baseline kept + delta applied)", () => {
  const doc = resolveWikiEditRefinement(RAW_DELTA_PAYLOAD, BASELINE, "Runbook at CALEO Office.");
  assert.deepEqual(names(doc.entities ?? []).sort(), ["CALEO", "CALEO Office", "Lüsen", "ZOB München"]);
  assert.equal(doc.relations?.length, 1);
  assert.deepEqual((doc.entity_renames ?? []).map((r) => [r.from, r.to]), [["GALILEO Office", "CALEO Office"]]);
  assert.deepEqual((doc.new_entities ?? []).map((e) => e.name), ["ZOB München"], "added = new_entities");
  assert.deepEqual(doc.new_relations ?? [], doc.relations ?? []);
  assert.equal(doc.rechunked, false);
  assert.equal(doc.frontmatter.type, "concept");
});

test("resolveWikiEditRefinement tolerates LEGACY full-list payloads (entities unioned in, nothing lost)", () => {
  const legacy = {
    ...RAW_DELTA_PAYLOAD,
    renames: [],
    added: [],
    changed_relations: [],
    // Old-contract model response: full lists instead of a delta.
    entities: [{ name: "Brand New Thing", type: "other", description: "freshly extracted" }],
    relations: [{ source: "Brand New Thing", target: "CALEO", keywords: ["x"], description: "rel" }],
    new_entities: [{ name: "Brand New Thing", type: "other", description: "freshly extracted" }],
    new_relations: [{ source: "Brand New Thing", target: "CALEO", keywords: ["x"], description: "rel" }],
  };
  const doc = resolveWikiEditRefinement(legacy, BASELINE, "text");
  assert.deepEqual(
    names(doc.entities ?? []).sort(),
    ["Brand New Thing", "CALEO", "GALILEO Office", "Lüsen"],
    "baseline implicitly kept even when the model re-emitted a legacy full list",
  );
  assert.equal(doc.entity_renames?.length ?? 0, 0);
});

// --- prompt: KNOWN ENTITIES baseline injection (golden) + cap ---

const KNOWN: KnownEntity[] = [
  { name: "GALILEO Office", type: "location", description: "Office at Galileostraße.", source_docs: ["doc-1"], aliases: ["Galileo Büro"] },
  { name: "CALEO", type: "org", description: "The organizer." },
];

test("the wiki-edit prompt injects the KNOWN ENTITIES baseline with a baseline-only contract (golden)", () => {
  const prompt = buildWikiEditRefinePrompt(
    {
      markdown: "# Runbook\n\nThe image shows CALEO Office.",
      before: "# Runbook\n\nThe image shows GALILEO Office.",
      diff: "-The image shows GALILEO Office.\n+The image shows CALEO Office.",
      structural: false,
      known_entities: KNOWN,
    },
    { type: "concept", topic: "ops" },
  );
  assert.match(prompt, /## KNOWN ENTITIES \(baseline/);
  assert.match(prompt, /- GALILEO Office \(location\) — Office at Galileostraße\. \[aliases: Galileo Büro\]/);
  assert.match(prompt, /- CALEO \(org\)/);
  assert.match(prompt, /Do NOT re-emit them/i);
  assert.match(prompt, /implicitly KEPT/i);
  assert.match(prompt, /renames \/ added \/ removed \/[\s]*changed_relations/s);
});

test("the prompt renders no baseline section content when the page has no known entities yet", () => {
  const block = formatKnownEntitiesBlock([]);
  assert.match(block, /none recorded/i);
});

test("the baseline is CAPPED at WIKI_KNOWN_ENTITIES_CAP entries in the prompt", () => {
  const many: KnownEntity[] = Array.from({ length: WIKI_KNOWN_ENTITIES_CAP + 37 }, (_, i) => ({
    name: `Entity ${String(i).padStart(3, "0")}`,
    type: "other",
  }));
  const rendered = formatKnownEntitiesBlock(many);
  const lines = rendered.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(lines.length, WIKI_KNOWN_ENTITIES_CAP, "exactly the cap number of entities are injected");
});

test("the system prompt describes the delta-over-baseline entity contract", () => {
  assert.match(WIKI_EDIT_REFINE_SYSTEM_PROMPT, /KNOWN ENTITIES/i);
  assert.match(WIKI_EDIT_REFINE_SYSTEM_PROMPT, /renames: a baseline entity whose NAME changed/s);
  assert.match(WIKI_EDIT_REFINE_SYSTEM_PROMPT, /implicit/i);
  assert.doesNotMatch(
    WIKI_EDIT_REFINE_SYSTEM_PROMPT,
    /FULL entities, relations/,
    "the old full-list re-emission rule is gone",
  );
});

// --- end-to-end: runWikiEditRefine resolves delta over baseline; LINK sees only delta candidates ---

test("runWikiEditRefine resolves the delta over the KNOWN ENTITIES baseline and links ONLY the delta candidates", async () => {
  const linkedCandidates: string[][] = [];
  let auditCalls = 0;
  const httpCaller = async (ctx: { userContent: string }) => {
    if (auditCalls === 0) {
      // extraction call — assert the baseline reached the prompt
      assert.match(ctx.userContent, /KNOWN ENTITIES/);
      assert.match(ctx.userContent, /GALILEO Office \(location\)/);
      return {
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: "Edited.",
                sections: [],
                frontmatter: { type: "concept", topic: "ops" },
                renames: [{ from: "GALILEO Office", to: "CALEO Office", type_match: true, reason: "image fix" }],
                added: [{ name: "ZOB München", type: "location", description: "Bus station." }],
                removed: [],
                changed_relations: [
                  { source: "CALEO", target: "CALEO Office", keywords: ["operates"], description: "runs it" },
                ],
                keywords: [],
                rechunked: false,
                quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
              }),
            },
          ],
        },
      };
    }
    auditCalls += 1;
    throw new Error("audit unavailable");
  };
  const linker = async (candidates: Array<{ name: string }>) => {
    linkedCandidates.push(candidates.map((c) => c.name));
    return { merges: [], new_edges: [], standalone: [] };
  };

  const { document } = await runWikiEditRefine(
    {
      markdown: "# Runbook\n\nThe image shows CALEO Office and ZOB München.",
      before: "# Runbook\n\nThe image shows GALILEO Office.",
      diff: "-…GALILEO Office.\n+…CALEO Office and ZOB München.",
      structural: false,
      known_entities: [
        { name: "GALILEO Office", type: "location", aliases: [] },
        { name: "Lüsen", type: "location", aliases: [] },
      ],
    },
    undefined,
    { httpCaller: httpCaller as never, entityLinker: linker, retries: 0 },
  );

  // Resolution kept the unmentioned baseline entity (no orphan) + applied rename + added.
  const resolvedNames = (document.entities ?? []).map((e) => e.name).sort();
  assert.deepEqual(resolvedNames, ["CALEO Office", "Lüsen", "ZOB München"]);
  assert.ok(document.entities!.some((e) => e.name === "CALEO Office" && (e.aliases ?? []).some((a) => a.toUpperCase() === "GALILEO OFFICE")));
  assert.deepEqual(document.entity_renames ?? [], [{ from: "GALILEO Office", to: "CALEO Office" }]);
  // LINK ran on the DELTA candidates ONLY (added + rename target), not the baseline.
  assert.deepEqual(linkedCandidates, [["ZOB München", "CALEO Office"]]);
});
