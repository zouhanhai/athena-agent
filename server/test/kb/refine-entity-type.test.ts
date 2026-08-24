/**
 * G4.S10.T2 — entity TYPE normalization + enum hard validation.
 *
 * The refinement channel must never leak ad-hoc type strings into the graph:
 * synonyms fold (organization/group→org, place→location), anything outside the
 * closed enum falls back to "other", and the emit schemas carry the enum so
 * constrained transports reject invalid types before parse.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ENTITY_TYPES, normalizeEntityType } from "../../src/kb/link/link-engine.js";
import {
  AUDIT_ENTITIES_SCHEMA,
  GLOBAL_MERGE_SCHEMA,
  REFINED_DOCUMENT_SCHEMA,
  WIKI_EDIT_REFINE_SCHEMA,
  normalizeEntityList,
} from "../../src/agents/refine-document.js";

test("normalizeEntityType folds synonyms and clamps to the closed enum", () => {
  assert.equal(normalizeEntityType("organization"), "org");
  assert.equal(normalizeEntityType("Organization"), "org");
  assert.equal(normalizeEntityType("group"), "org");
  assert.equal(normalizeEntityType("place"), "location");
  assert.equal(normalizeEntityType("LOCATION"), "location");
  // In-enum values pass through untouched.
  for (const t of ENTITY_TYPES) assert.equal(normalizeEntityType(t), t);
  // Out-of-enum / empty / missing → the default ("other"), never ad-hoc junk.
  assert.equal(normalizeEntityType("vehicle"), "other");
  assert.equal(normalizeEntityType(""), "other");
  assert.equal(normalizeEntityType(undefined), "other");
});

test("ENTITY_TYPES is exactly the documented enum", () => {
  assert.deepEqual([...ENTITY_TYPES], ["org", "person", "product", "event", "location", "concept", "other"]);
});

/** Collect every literal value of a TypeBox union (anyOf) field. */
function unionValues(schema: unknown): string[] {
  const anyOf = (schema as { anyOf?: Array<{ const?: string }> }).anyOf ?? [];
  return anyOf.map((entry) => entry.const ?? "");
}

test("emit schemas hard-validate the entity type enum", () => {
  const expected = [...ENTITY_TYPES];
  const typeSchemas = [
    // @ts-expect-error -- TypeBox property access is untyped at this depth
    REFINED_DOCUMENT_SCHEMA.properties.entities.items.properties.type,
    // @ts-expect-error -- TypeBox property access is untyped at this depth
    GLOBAL_MERGE_SCHEMA.properties.entities.items.properties.type,
    // @ts-expect-error -- TypeBox property access is untyped at this depth
    WIKI_EDIT_REFINE_SCHEMA.properties.new_entities.items.properties.type,
    // @ts-expect-error -- TypeBox property access is untyped at this depth
    AUDIT_ENTITIES_SCHEMA.properties.entities.items.properties.type,
  ];
  for (const schema of typeSchemas) {
    assert.deepEqual(unionValues(schema).sort(), [...expected].sort(), "entity type carries the full enum");
  }
});

test("normalizeEntityList folds synonym types and rejects out-of-enum types at parse time", () => {
  const entities = normalizeEntityList([
    { name: "CALEO Group", type: "organization", description: "leaked synonym" },
    { name: "HQ Tower", type: "place", description: "synonym location" },
    { name: "Mystery", type: "vehicle", description: "out-of-enum junk" },
    { name: "NoType", description: "missing type" },
    { name: "Fine", type: "concept", description: "already canonical" },
  ]);
  assert.deepEqual(
    entities.map((e) => e.type),
    ["org", "location", "other", "other", "concept"],
  );
});
