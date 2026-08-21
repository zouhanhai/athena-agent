import { test } from "node:test";
import assert from "node:assert/strict";
import { DOC_TYPES, DOC_TYPE_DIRS } from "../../src/kb/taxonomy.js";
import { isValidTopic, parseClassification } from "../../src/kb/llmwiki.js";

test("taxonomy: code is the 14th DocType", () => {
  assert.ok(DOC_TYPES.includes("code"), `DOC_TYPES should include "code" but is ${DOC_TYPES.join(", ")}`);
  assert.equal(DOC_TYPES.length, 14);
  assert.ok("code" in DOC_TYPE_DIRS, "DOC_TYPE_DIRS should have a directory for code");
  assert.equal(DOC_TYPE_DIRS.code, "code");
});

test("taxonomy: code is accepted as a valid category by the classifier", () => {
  const parsed = parseClassification('{"category":"code","pagePath":"wiki/code/i_cnsldtnsubitem.md"}');
  assert.ok(parsed, "code should be a valid classification category");
  assert.equal(parsed!.category, "code");
});

test("taxonomy: code/<system> passes topic validation", () => {
  assert.equal(isValidTopic("code/prd"), true);
  assert.equal(isValidTopic("code/dev"), true);
  assert.equal(isValidTopic("code/qas"), true);
  assert.equal(isValidTopic("code/unknown"), true);
  assert.equal(isValidTopic("code/prd/projectchild"), true);
});

test("taxonomy: whether the classifier routes code topics (code/<system>)", () => {
  const parsed = parseClassification('{"category":"code","topic":"code/prd","pagePath":"wiki/code/i_cnsldtnsubitem.md"}');
  assert.ok(parsed);
  assert.equal(parsed!.topic, "code/prd");
});
