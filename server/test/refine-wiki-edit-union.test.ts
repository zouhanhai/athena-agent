import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveWikiEditRefinement } from "../src/agents/refine-document.js";

/**
 * G4.S10.T4 — successor of the G4.S8.T18 union-hardening tests: with the
 * delta-over-baseline contract, resolution must keep every baseline entity
 * (implicit keep), apply renames/adds/removals, and still fold in legacy
 * full-list payloads so nothing a model genuinely extracted is lost.
 */

const BASELINE = [
  { name: "Lüsen", type: "location", description: "village" },
  { name: "CALEO", type: "org", description: "the group" },
];

describe("resolveWikiEditRefinement keeps the baseline + applies the delta (G4.S10.T4)", () => {
  it("keeps unmentioned baseline entities while adding the delta's new ones", () => {
    const raw = {
      markdown: "# Test\n\nbody",
      frontmatter: { type: "document", topic: "unclassified" },
      quality: { complete: true, confidence: 0.95, issues: [], action: "auto_accept" },
      renames: [],
      added: [{ name: "CALEO Office", type: "org", description: "The CALEO office near Puchheim." }],
      removed: [],
      changed_relations: [
        { source: "CALEO Office", target: "CALEO", keywords: ["belongs to"], description: "office belongs" },
      ],
      rechunked: false,
    };
    const out = resolveWikiEditRefinement(raw, BASELINE as never, "body");
    const names = (out.entities ?? []).map((e) => e.name);
    assert.ok(names.includes("CALEO Office"), "added entity created");
    assert.ok(names.includes("Lüsen"), "unmentioned baseline entity implicitly kept");
    assert.ok(names.includes("CALEO"), "baseline entity kept");
    const rel = (out.relations ?? []).find((r) => r.target === "CALEO");
    assert.ok(rel, "changed relation carried");
    assert.equal(rel?.source, "CALEO Office");
    assert.deepEqual((out.new_entities ?? []).map((e) => e.name), ["CALEO Office"]);
    assert.equal((out.new_relations ?? []).length, 1);
  });

  it("applies renames onto baseline entities without duplicating them", () => {
    const raw = {
      markdown: "# T\n\nbody",
      frontmatter: { type: "document", topic: "unclassified" },
      quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
      renames: [{ from: "Lüsen", to: "Lüsen Dorf" }],
      added: [],
      removed: [],
      changed_relations: [],
      rechunked: false,
    };
    const out = resolveWikiEditRefinement(raw, BASELINE as never, "body");
    const names = (out.entities ?? []).map((e) => e.name);
    assert.deepEqual(names.sort(), ["CALEO", "Lüsen Dorf"]);
    assert.equal((out.entities ?? []).filter((e) => e.name === "Lüsen Dorf").length, 1);
    assert.equal(
      (out.entities ?? []).find((e) => e.name === "Lüsen Dorf")?.description,
      "village",
      "rename preserves the baseline description",
    );
    assert.deepEqual(out.entity_renames ?? [], [{ from: "Lüsen", to: "Lüsen Dorf" }]);
  });

  it("folds LEGACY full-list payloads over the baseline instead of dropping them", () => {
    const raw = {
      markdown: "# T\n\nbody",
      frontmatter: { type: "document", topic: "unclassified" },
      quality: { complete: true, confidence: 0.95, issues: [], action: "auto_accept" },
      entities: [{ name: "Brand New", type: "other", description: "freshly extracted" }],
      relations: [],
      new_entities: [{ name: "Brand New", type: "other", description: "freshly extracted" }],
      rechunked: false,
    };
    const out = resolveWikiEditRefinement(raw, BASELINE as never, "body");
    assert.deepEqual(
      (out.entities ?? []).map((e) => e.name).sort(),
      ["Brand New", "CALEO", "Lüsen"],
      "baseline implicitly kept even when the model answered in the old full-list shape",
    );
  });
});
