import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MemorySemanticMappingStore,
  parseCanonicals,
  expandTerms,
  type SemanticMapping,
} from "../../src/kb/semantic-mappings.js";

test("MemorySemanticMappingStore upsert inserts a term→canonical mapping", async () => {
  const store = new MemorySemanticMappingStore();
  const mapping = await store.upsert({ term: "C-Day", canonical: "CALEO Day" });

  assert.ok(mapping.id.length > 0);
  assert.equal(mapping.term, "C-Day");
  assert.deepEqual(mapping.canonicals, ["CALEO Day"]);
  assert.ok(mapping.created_at);
});

test("MemorySemanticMappingStore upsert stores MULTIPLE canonicals from a comma/slash list", async () => {
  const store = new MemorySemanticMappingStore();
  const mapping = await store.upsert({
    term: "EDay",
    canonical: "Expert Day / Principle Day, Expert Day 2",
  });

  assert.deepEqual(mapping.canonicals, ["Expert Day", "Principle Day", "Expert Day 2"]);
});

test("MemorySemanticMappingStore upsert accepts an explicit canonicals array (one-to-many)", async () => {
  const store = new MemorySemanticMappingStore();
  const mapping = await store.upsert({
    term: "EDay",
    canonicals: ["Expert Day", "Principle Day"],
  });

  assert.deepEqual(mapping.canonicals, ["Expert Day", "Principle Day"]);
});

test("MemorySemanticMappingStore upsert updates the canonicals of an existing term (no duplicate)", async () => {
  const store = new MemorySemanticMappingStore();
  await store.upsert({ term: "C-Day", canonical: "CALEO Day" });
  const updated = await store.upsert({ term: "C-Day", canonical: "CALEO International Day" });

  assert.deepEqual(updated.canonicals, ["CALEO International Day"]);
  const list = await store.list();
  assert.equal(list.length, 1, "still one row for the same term");
});

test("MemorySemanticMappingStore list returns stored mappings", async () => {
  const store = new MemorySemanticMappingStore();
  await store.upsert({ term: "C-Day", canonical: "CALEO Day" });
  await store.upsert({ term: "HW", canonical: "Haushaltswaren" });

  const list = await store.list();
  assert.equal(list.length, 2);
});

test("MemorySemanticMappingStore remove deletes a mapping by id", async () => {
  const store = new MemorySemanticMappingStore();
  const mapping = await store.upsert({ term: "C-Day", canonical: "CALEO Day" });

  assert.equal(await store.remove(mapping.id), true);
  assert.equal(await store.remove("missing"), false);
  assert.equal((await store.list()).length, 0);
});

test("MemorySemanticMappingStore findByTerm returns the mapping or null", async () => {
  const store = new MemorySemanticMappingStore();
  await store.upsert({ term: "C-Day", canonical: "CALEO Day" });

  assert.deepEqual((await store.findByTerm("C-Day"))?.canonicals, ["CALEO Day"]);
  assert.equal(await store.findByTerm("HW"), null);
});

test("parseCanonicals splits comma- and slash-separated values, trims and dedupes", () => {
  assert.deepEqual(parseCanonicals("CALEO Day"), ["CALEO Day"]);
  assert.deepEqual(parseCanonicals("Expert Day / Principle Day"), ["Expert Day", "Principle Day"]);
  assert.deepEqual(parseCanonicals("Expert Day, Principle Day"), ["Expert Day", "Principle Day"]);
  assert.deepEqual(parseCanonicals("  A , B / C  "), ["A", "B", "C"]);
  assert.deepEqual(parseCanonicals("Expert Day / expert day"), ["Expert Day"], "dedupes case-insensitively");
  assert.deepEqual(parseCanonicals("  / , "), []);
});

test("expandTerms replaces colloquial terms with the canonical form (case-insensitive, word boundary)", () => {
  const mappings: SemanticMapping[] = [
    { id: "1", term: "C-Day", canonicals: ["CALEO Day"], created_at: "", updated_at: "" },
    { id: "2", term: "HW", canonicals: ["Haushaltswaren"], created_at: "", updated_at: "" },
  ];

  assert.equal(expandTerms("when is C-Day?", mappings), "when is CALEO Day?");
  assert.equal(expandTerms("c-day planning", mappings), "CALEO Day planning");
  assert.equal(expandTerms("HW sales", mappings), "Haushaltswaren sales");
  assert.equal(
    expandTerms("C-Day and HW both", mappings),
    "CALEO Day and Haushaltswaren both",
  );
});

test("expandTerms expands a one-to-many term into an OR alternative", () => {
  const mappings: SemanticMapping[] = [
    {
      id: "1",
      term: "EDay",
      canonicals: ["Expert Day", "Principle Day"],
      created_at: "",
      updated_at: "",
    },
  ];

  assert.equal(expandTerms("what is EDay?", mappings), "what is (Expert Day OR Principle Day)?");
  assert.equal(
    expandTerms("eday planning", mappings),
    "(Expert Day OR Principle Day) planning",
  );
});

test("expandTerms is backward-compatible with a single canonical (plain expansion)", () => {
  const single: SemanticMapping[] = [
    { id: "1", term: "C-Day", canonicals: ["CALEO Day"], created_at: "", updated_at: "" },
  ];
  assert.equal(expandTerms("C-Day", single), "CALEO Day");
  assert.equal(expandTerms("C-Day", single), "CALEO Day", "no OR wrapper for one canonical");

  const multi: SemanticMapping[] = [
    { id: "1", term: "C-Day", canonicals: ["CALEO Day", "Company Day"], created_at: "", updated_at: "" },
  ];
  assert.equal(expandTerms("C-Day", multi), "(CALEO Day OR Company Day)");
});

test("expandTerms leaves unknown terms and empty mappings untouched", () => {
  assert.equal(expandTerms("what about monday?", []), "what about monday?");
  const mappings: SemanticMapping[] = [
    { id: "1", term: "C-Day", canonicals: ["CALEO Day"], created_at: "", updated_at: "" },
  ];
  assert.equal(expandTerms("how many days until Friday?", mappings), "how many days until Friday?");
});
