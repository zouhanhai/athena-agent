import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseAbapUnits, type AbapUnit } from "../../src/kb/codeparse/abap.js";

const CLASS_FIXTURE = join(import.meta.dirname, "..", "fixtures", "abap", "zcl_fi_delivery.clas.abap");
const REPORT_FIXTURE = join(import.meta.dirname, "..", "fixtures", "abap", "z_report_sample.abap");
const FUGROUP_FIXTURE = join(import.meta.dirname, "..", "fixtures", "abap", "z_function_top.fugr.abap");

test("parseAbapUnits: a class emits one chunk per METHOD (body inclusive) with object path", async () => {
  const source = await readFile(CLASS_FIXTURE, "utf8");
  const units = parseAbapUnits(source, { devclass: "ZFIDL", system: "S4H" });

  // constructor + save + post = 3 methods
  assert.equal(units.length, 3);
  assert.ok(units.every((u) => u.objectType === "class"));

  const save = units.find((u) => u.method === "save")!;
  assert.equal(save.devName, "zcl_fi_delivery");
  // path = <devclass>/<devName>/<method>
  assert.equal(save.path, "ZFIDL/zcl_fi_delivery/save");
  // method body + signature kept verbatim
  assert.ok(save.text.includes("METHOD save."));
  assert.ok(save.text.includes("ENDMETHOD."));
  assert.ok(save.text.includes("CALL FUNCTION 'Z_FI_POST'"));
  // devclass + system metadata carried
  assert.equal(save.devclass, "ZFIDL");
  assert.equal(save.system, "S4H");
});

test("parseAbapUnits: method boundaries fall on METHOD/ENDMETHOD lines (no cross-contamination)", async () => {
  const source = await readFile(CLASS_FIXTURE, "utf8");
  const units = parseAbapUnits(source, { devclass: "ZFIDL", system: "S4H" });

  const constructor = units.find((u) => u.method === "constructor")!;
  // constructor body must not swallow save/post bodies
  assert.ok(constructor.text.includes("METHOD constructor."));
  assert.ok(constructor.text.includes("ENDMETHOD."));
  assert.ok(!constructor.text.includes("METHOD save."));
});

test("parseAbapUnits: identifiers are stable and unique per method", async () => {
  const source = await readFile(CLASS_FIXTURE, "utf8");
  const units = parseAbapUnits(source);
  const ids = new Set(units.map((u) => u.id));
  assert.equal(ids.size, units.length);
  assert.ok(units.every((u) => typeof u.id === "string" && u.id.length > 0));
});

test("parseAbapUnits: a report emits one chunk per FORM (boundary ENDFORM)", async () => {
  const source = await readFile(REPORT_FIXTURE, "utf8");
  const units = parseAbapUnits(source);

  // initialize + run_report = 2 forms
  assert.equal(units.length, 2);
  assert.ok(units.every((u) => u.objectType === "form"));

  const run = units.find((u) => u.method === "run_report")!;
  assert.equal(run.devName, "z_report_sample");
  assert.ok(run.text.includes("FORM run_report."));
  assert.ok(run.text.includes("ENDFORM."));
  assert.ok(!run.text.includes("FORM initialize."));
});

test("parseAbapUnits: a function group emits one chunk per FUNCTION + includes", async () => {
  const source = await readFile(FUGROUP_FIXTURE, "utf8");
  const units = parseAbapUnits(source);

  // 2 FUNCTION blocks + 2 INCLUDE
  assert.equal(units.length, 4);
  const fnCount = units.filter((u) => u.objectType === "function").length;
  const incCount = units.filter((u) => u.objectType === "include").length;
  assert.equal(fnCount, 2);
  assert.equal(incCount, 2);

  const fn = units.find((u) => u.objectType === "function" && u.devName === "z_fi_post")!;
  assert.ok(fn.text.includes("FUNCTION z_fi_post."));
  assert.ok(fn.text.includes("ENDFUNCTION."));

  const inc = units.find((u) => u.objectType === "include")!;
  assert.ok(inc.text.includes("INCLUDE"));
});

test("parseAbapUnits: dependency extraction — SELECT tables + CALL FUNCTION/PERFORM/METHOD", async () => {
  const source = await readFile(CLASS_FIXTURE, "utf8");
  const units = parseAbapUnits(source, { devclass: "ZFIDL" });

  // save method: no SELECT (call-only) — table_read sits with its own method
  const save = units.find((u) => u.method === "save")!;
  const saveTables = save.dependencies.filter((d) => d.kind === "table_read").map((d) => d.name);
  assert.deepEqual(saveTables, []);
  const calls = save.dependencies.filter((d) => d.kind === "call_function").map((d) => d.name);
  assert.ok(calls.includes("Z_FI_POST"));

  // constructor reads t001
  const constructor = units.find((u) => u.method === "constructor")!;
  assert.ok(
    constructor.dependencies.some((d) => d.kind === "table_read" && d.name === "t001"),
  );

  // post reads vbap + calls a method + a form
  const post = units.find((u) => u.method === "post")!;
  assert.ok(post.dependencies.some((d) => d.kind === "table_read" && d.name === "vbap"));
  assert.ok(post.dependencies.some((d) => d.kind === "call_method" && d.name === "mark_complete"));
  assert.ok(post.dependencies.some((d) => d.kind === "call_form" && d.name === "validate_delivery"));
});

test("parseAbapUnits: empty/non-ABAP source returns no chunks", () => {
  assert.deepEqual(parseAbapUnits("this is not abap\nnothing here\n"), []);
});

test("parseAbapUnits: unclosed METHOD emits partial chunk with a warning (no data lost)", () => {
  const source = `CLASS zcl_foo DEFINITION.
ENDCLASS.
CLASS zcl_foo IMPLEMENTATION.
  METHOD broken.
    WRITE 'hi'.
`;
  const units = parseAbapUnits(source);
  assert.equal(units.length, 1);
  assert.equal(units[0]!.method, "broken");
  assert.equal(units[0]!.objectType, "class");
  assert.ok(units[0]!.text.includes("METHOD broken."));
  assert.ok(units[0]!.warnings.some((w) => w.code === "UNCLOSED_METHOD"));
});
