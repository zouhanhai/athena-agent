import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MemorySemanticMappingStore,
  expandTerms,
  type SemanticMapping,
} from "../../src/kb/semantic-mappings.js";

test("MemorySemanticMappingStore upsert inserts a term→canonical mapping", async () => {
  const store = new MemorySemanticMappingStore();
  const mapping = await store.upsert({ term: "C-Day", canonical: "CALEO Day" });

  assert.ok(mapping.id.length > 0);
  assert.equal(mapping.term, "C-Day");
  assert.equal(mapping.canonical, "CALEO Day");
  assert.ok(mapping.created_at);
});

test("MemorySemanticMappingStore upsert updates the canonical of an existing term (no duplicate)", async () => {
  const store = new MemorySemanticMappingStore();
  await store.upsert({ term: "C-Day", canonical: "CALEO Day" });
  const updated = await store.upsert({ term: "C-Day", canonical: "CALEO International Day" });

  assert.equal(updated.canonical, "CALEO International Day");
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

  assert.equal((await store.findByTerm("C-Day"))?.canonical, "CALEO Day");
  assert.equal(await store.findByTerm("HW"), null);
});

test("expandTerms replaces colloquial terms with the canonical form (case-insensitive, word boundary)", () => {
  const mappings: SemanticMapping[] = [
    { id: "1", term: "C-Day", canonical: "CALEO Day", created_at: "", updated_at: "" },
    { id: "2", term: "HW", canonical: "Haushaltswaren", created_at: "", updated_at: "" },
  ];

  assert.equal(expandTerms("when is C-Day?", mappings), "when is CALEO Day?");
  assert.equal(expandTerms("c-day planning", mappings), "CALEO Day planning");
  assert.equal(expandTerms("HW sales", mappings), "Haushaltswaren sales");
  assert.equal(
    expandTerms("C-Day and HW both", mappings),
    "CALEO Day and Haushaltswaren both",
  );
});

test("expandTerms leaves unknown terms and empty mappings untouched", () => {
  assert.equal(expandTerms("what about monday?", []), "what about monday?");
  const mappings: SemanticMapping[] = [
    { id: "1", term: "C-Day", canonical: "CALEO Day", created_at: "", updated_at: "" },
  ];
  assert.equal(expandTerms("how many days until Friday?", mappings), "how many days until Friday?");
});
