import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeWikiEditRefinement } from "../src/agents/refine-document.js";

describe("normalizeWikiEditRefinement unions new_* into the full lists (G4.S8.T18 hardening)", () => {
  it("forces new_entities into entities when the model wrote them only under new_*", () => {
    const raw = {
      markdown: "# Test\n\nbody",
      frontmatter: { type: "document", topic: "unclassified" },
      quality: { complete: true, confidence: 0.95, issues: [], action: "auto_accept" },
      entities: [{ name: "Lüsen", type: "location" }],
      relations: [],
      new_entities: [
        { name: "CALEO Office", type: "organization", description: "The CALEO office near Puchheim." },
      ],
      new_relations: [
        { source: "CALEO Office", target: "CALEO", keywords: ["belongs to"], description: "office belongs" },
      ],
      rechunked: false,
    };
    const out = normalizeWikiEditRefinement(raw as never);
    const names = (out.entities ?? []).map((e) => e.name);
    assert.ok(names.includes("CALEO Office"), "new entity must be in full entities");
    assert.ok(names.includes("Lüsen"), "existing entity must be preserved");
    const rel = (out.relations ?? []).find((r) => r.target === "CALEO");
    assert.ok(rel, "new relation must be in full relations");
    assert.equal(rel?.source, "CALEO Office");
    assert.deepEqual((out.new_entities ?? []).map((e) => e.name), ["CALEO Office"]);
    assert.equal((out.new_relations ?? []).length, 1);
  });

  it("dedupes by name (new wins) and does not duplicate", () => {
    const raw = {
      markdown: "# T\n\nbody",
      frontmatter: { type: "document", topic: "unclassified" },
      quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
      entities: [{ name: "Lüsen", type: "location", description: "old desc" }],
      relations: [],
      new_entities: [{ name: "Lüsen", type: "location", description: "new desc" }],
      new_relations: [],
      rechunked: false,
    };
    const out = normalizeWikiEditRefinement(raw as never);
    const lüsen = (out.entities ?? []).filter((e) => e.name === "Lüsen");
    assert.equal(lüsen.length, 1);
    assert.equal(lüsen[0].description, "new desc");
  });

  it("keeps pure-wiki-edit payloads (no new_*) unchanged", () => {
    const raw = {
      markdown: "# T\n\nbody",
      frontmatter: { type: "document", topic: "unclassified" },
      quality: { complete: true, confidence: 0.95, issues: [], action: "auto_accept" },
      entities: [{ name: "Lüsen", type: "location" }],
      relations: [],
      rechunked: false,
    };
    const out = normalizeWikiEditRefinement(raw as never);
    assert.deepEqual((out.entities ?? []).map((e) => e.name), ["Lüsen"]);
    assert.equal((out.new_entities ?? []).length, 0);
  });
});