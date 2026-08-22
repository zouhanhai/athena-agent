import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { auditWikiEditDocument, type WikiEditRefinement } from "../src/agents/refine-document.js";

/** A fake caller whose audit session outputs the given raw JSON text. */
function fakeCallerWith(raw: unknown): (params: unknown) => Promise<{ message: unknown }> {
  return async () => ({
    message: {
      role: "assistant",
      content: [{ type: "text", text: JSON.stringify(raw) }],
    },
  });
}

const doc: WikiEditRefinement = {
  markdown: "# Lüsen\n\nCALEO near München.",
  summary: "s",
  sections: [],
  frontmatter: { type: "event", topic: "internal/events" },
  chunks: [],
  entities: [
    { name: "Hotel Palma Bellver Affiliated by Melia", type: "location", description: "d" },
    { name: "CALLE", type: "org", description: "company" },
  ],
  relations: [
    { source: "CALLE", target: "Hotel Palma Bellver Belly by Melia", keywords: ["stays"], description: "d" },
  ],
  keywords: [],
  new_entities: [],
  new_relations: [],
  rechunked: false,
  quality: { complete: true, confidence: 1, issues: [], action: "auto_accept" },
};

describe("auditWikiEditDocument (G4.S8.T19 extension)", () => {
  it("canonicalizes a Belly-variant endpoint into the emitted entity name", async () => {
    const caller = fakeCallerWith({
      entities: [
        { name: "Hotel Palma Bellver Affiliated by Melia", type: "location", description: "" },
        { name: "CALLE", type: "org", description: "" },
      ],
      relations: [
        { source: "CALLE", target: "Hotel Palma Bellver Affiliated by Melia", keywords: ["stays"], description: "d" },
      ],
    });
    const out = await auditWikiEditDocument(caller as never, doc.markdown, doc, undefined);
    assert.notEqual(out, doc, "audit adopted a changed document");
    const target = out.relations[0]?.target;
    assert.equal(target, "Hotel Palma Bellver Affiliated by Melia");
    assert.ok(out.entities.some((e) => e.name === target));
  });

  it("returns the original doc when the audit output is invalid", async () => {
    const caller = fakeCallerWith({ entities: [], relations: [] }); // no entities + no relations => validate fails
    const out = await auditWikiEditDocument(caller as never, doc.markdown, doc, undefined);
    assert.equal(out, doc);
  });

  it("returns the original doc when the caller throws", async () => {
    const caller = async () => {
      throw new Error("boom");
    };
    const out = await auditWikiEditDocument(caller as never, doc.markdown, doc, undefined);
    assert.equal(out, doc);
  });

  it("keeps original relations when the audit returns an EMPTY relation list", async () => {
    // Audit canonicalizes entities but returns relations: [] — the empty array
    // must not wipe the extraction's relations (live regression: graph lost
    // all relations after a wiki-edit with an audit that returned no relations).
    const caller = fakeCallerWith({
      entities: [
        { name: "Hotel Palma Bellver Affiliated by Melia", type: "location", description: "" },
        { name: "CALLE", type: "org", description: "" },
      ],
      relations: [],
    });
    const out = await auditWikiEditDocument(caller as never, doc.markdown, doc, undefined);
    assert.notEqual(out, doc, "audit adopted the entity rewrite");
    assert.equal(out.relations.length, 1, "original relation must survive");
    assert.equal(out.relations[0]?.source, "CALLE");
  });
});