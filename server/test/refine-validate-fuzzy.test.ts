import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateRefineDelta } from "../src/agents/refine-document.js";

describe("validateRefineDelta fuzzy endpoint matching (G4.S8 follow-up)", () => {
  const base = {
    markdown: "# Sommerseminar Lüsen\n\nCALEO and the office.",
    frontmatter: { type: "event", topic: "internal/events" },
    entities: [
      { name: "Hotel Palma Bellver Affiliated by Melia", type: "location" },
      { name: "ZOB München", type: "location" },
      { name: "CALEO", type: "org" },
    ],
    relations: [] as Array<{ source: string; target: string; keywords: string[]; description: string }>,
    keywords: [] as string[],
  };

  it("tolerates a word-order/filler variant of an emitted entity (no error)", () => {
    const delta = {
      ...base,
      relations: [
        { source: "CALLE", target: "Hotel Palma Bellver By Affiliated by Melia", keywords: ["stays"], description: "d" },
        { source: "CALLE", target: "München", keywords: ["near"], description: "d" },
      ],
    };
    const errors = validateRefineDelta(delta as never, base.markdown);
    assert.deepEqual(errors, [], `expected no errors, got: ${JSON.stringify(errors)}`);
  });

  it("keeps flagging a genuinely unknown endpoint", () => {
    const delta = {
      ...base,
      relations: [
        { source: "CALLE", target: "Totally Unknown Place Xyz", keywords: ["at"], description: "d" },
      ],
    };
    const errors = validateRefineDelta(delta, "# x\n");
    assert.ok(errors.some((e) => e.includes("does not reference any emitted entity")));
  });

  it("keeps flagging empty relations", () => {
    const delta = {
      ...base,
      relations: [{ source: "", target: "CALLE", keywords: [], description: "d" }],
    };
    const errors = validateRefineDelta(delta, "# x\n");
    assert.ok(errors.some((e) => e.includes("EMPTY")));
  });
});