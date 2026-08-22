import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateRefineDelta } from "../src/agents/refine-document.js";

describe("validateRefineDelta lenient endpoint handling (G4.S8 follow-up)", () => {
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

  it("tolerates a filler variant of an emitted entity (no error)", () => {
    const delta = {
      ...base,
      relations: [
        { source: "CALLE", target: "Hotel Palma Bellver By Affiliated by Melia", keywords: ["stays"], description: "d" },
      ],
    };
    assert.deepEqual(validateRefineDelta(delta as never, base.markdown), []);
  });

  it("tolerates a hallucinated-token variant of an emitted entity (Belly ≈ Affiliated)", () => {
    const delta = {
      ...base,
      relations: [
        { source: "CALLE", target: "Hotel Palma Bellver Belly by Melia", keywords: ["stays"], description: "d" },
      ],
    };
    assert.deepEqual(validateRefineDelta(delta as never, base.markdown), []);
  });

  it("tolerates a genuinely unknown endpoint (created implicitly at ingest)", () => {
    const delta = {
      ...base,
      relations: [
        { source: "CALLE", target: "Totally Unknown Place Xyz", keywords: ["at"], description: "d" },
      ],
    };
    assert.deepEqual(validateRefineDelta(delta as never, "# x\n"), []);
  });

  it("still flags relations with an EMPTY endpoint", () => {
    const delta = {
      ...base,
      relations: [{ source: "", target: "CALLE", keywords: [], description: "d" }],
    };
    const errors = validateRefineDelta(delta as never, "# x\n");
    assert.ok(errors.some((e) => e.includes("EMPTY")));
  });

  it("still flags relations with NO entities at all", () => {
    const delta = {
      ...base,
      entities: [],
      relations: [{ source: "X", target: "Y", keywords: [], description: "d" }],
    };
    const errors = validateRefineDelta(delta as never, "# x\n");
    assert.ok(errors.some((e) => e.includes("entities array is EMPTY")));
  });
});