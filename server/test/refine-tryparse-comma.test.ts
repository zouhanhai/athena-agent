import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tryParseNestedJson } from "../src/agents/refine-document.js";

describe("tryParseNestedJson comma repair (G4.S8 follow-up)", () => {
  it("repairs a missing comma between adjacent objects inside an array", () => {
    const text = '{"items":[{"a":1,"d":"x" } {"b":2}]}';
    const out = tryParseNestedJson(text);
    assert.ok(out, "should parse");
    const arr = (out as { items: Array<Record<string, unknown>> }).items;
    assert.equal(arr.length, 2);
    assert.deepEqual(arr[0], { a: 1, d: "x" });
    assert.deepEqual(arr[1], { b: 2 });
  });

  it("repairs within an array of objects (the observed wiki-edit case)", () => {
    const text = '[{"name":"A","type":"place","description":"end." }, {"name":"ZOB München","type":"place"}]';
    const out = tryParseNestedJson(text);
    assert.ok(out, "should parse");
    const arr = out as Array<Record<string, unknown>>;
    assert.equal(arr.length, 2);
    assert.equal(arr[0].name, "A");
    assert.equal(arr[1].name, "ZOB München");
  });

  it("leaves valid JSON untouched", () => {
    const text = '{"ok":true,"items":[{"x":1},{"y":2}]}';
    assert.deepEqual(tryParseNestedJson(text), { ok: true, items: [{ x: 1 }, { y: 2 }] });
  });

  it("still returns undefined for garbage", () => {
    assert.equal(tryParseNestedJson("not json at all"), undefined);
    assert.equal(tryParseNestedJson(""), undefined);
  });
});