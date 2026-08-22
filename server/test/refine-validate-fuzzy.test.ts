import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateRefineDelta } from "../src/agents/refine-document.js";

describe("validateRefineDelta endpoint handling (T16 fuzzy tolerance + T19 strictness)", () => {
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

  it("flags a genuinely unknown endpoint again (T19) — the mandatory audit session rescues instead", () => {
    // 124b73c tolerated unknown endpoints outright, which let ghost names reach
    // the graph. T19 restores the error and routes drift through repair retries +
    // audit rescue BEFORE any mechanical fallback.
    const delta = {
      ...base,
      relations: [
        { source: "CALLE", target: "Totally Unknown Place Xyz", keywords: ["at"], description: "d" },
      ],
    };
    const errors = validateRefineDelta(delta as never, "# x\n");
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /does not match ANY declared entity/);
    assert.match(errors[0]!, /Totally Unknown Place Xyz/);
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