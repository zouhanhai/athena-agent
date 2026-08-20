import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCdsViews, type CdsView } from "../../src/kb/codeparse/cds.js";

const fixturePath = join(import.meta.dirname, "..", "fixtures", "cds", "gr-cds-scope.cds");

test("parseCdsViews: splits a multi-view CDS source boundary-by-boundary (define view ... })", async () => {
  const source = await readFile(fixturePath, "utf8");
  const views = parseCdsViews(source);

  // The probe holds 5 views: 2 association-less master/transaction, 2 entity, 1 with associations.
  assert.equal(views.length, 5);
});

test("parseCdsViews: each view carries its technical name + full raw text (annotations through })", async () => {
  const source = await readFile(fixturePath, "utf8");
  const views = parseCdsViews(source);

  const names = views.map((v) => v.technicalName);
  assert.ok(names.includes("I_CnsldtnSubitem_2"));
  assert.ok(names.includes("I_CnsldtnGroup"));

  const subitem = views.find((v) => v.technicalName === "I_CnsldtnSubitem_2")!;
  assert.ok(subitem.rawText.includes("@EndUserText.label: 'Consolidation Subitem'"));
  assert.ok(subitem.rawText.includes("define view I_CnsldtnSubitem_2"));
  assert.ok(subitem.rawText.trimEnd().endsWith("}"));
  // raw text must NOT swallow the next view's define
  assert.ok(!subitem.rawText.includes("define view I_CnsldtnGroup"));
});

test("parseCdsViews: extracts source table name from 'as select from'", async () => {
  const source = await readFile(fixturePath, "utf8");
  const views = parseCdsViews(source);

  const subitem = views.find((v) => v.technicalName === "I_CnsldtnSubitem_2")!;
  assert.ok(subitem.sourceTables.includes("i_consolidationsubitem"));
});

test("parseCdsViews: collects annotations and associations", async () => {
  const source = await readFile(fixturePath, "utf8");
  const views = parseCdsViews(source);

  const subitem = views.find((v) => v.technicalName === "I_CnsldtnSubitem_2")!;
  assert.ok(subitem.annotations.some((a) => a.includes("@AbapCatalog.compiler.compareFilter")));
  assert.equal(subitem.associations.length, 1);
  assert.equal(subitem.associations[0]!.name, "_SubitemText");
  assert.equal(subitem.associations[0]!.target, "I_CnsldtnSubitmTx");
});

test("parseCdsViews: field list (rawMembers) captures the select body fields", async () => {
  const source = await readFile(fixturePath, "utf8");
  const views = parseCdsViews(source);

  const subitem = views.find((v) => v.technicalName === "I_CnsldtnSubitem_2")!;
  assert.ok(subitem.rawMembers.some((m) => m.includes("CnsldtnSubitem")));
  // no chunk is lost: the unparsed raw text is always present even if metadata misses
  assert.ok(subitem.rawText.length > 0);
});

test("parseCdsViews: view entity (define view entity) is parsed identically", async () => {
  const source = await readFile(fixturePath, "utf8");
  const views = parseCdsViews(source);
  assert.ok(views.some((v) => v.technicalName === "I_CompanyCode"));
});

test("parseCdsViews: transaction-data view with multiple associations", async () => {
  const source = await readFile(fixturePath, "utf8");
  const views = parseCdsViews(source);

  const posting = views.find((v) => v.technicalName === "I_CnsldtnPostingItem")!;
  assert.equal(posting.associations.length, 2);
});

test("parseCdsViews: a single define view is a single chunk", () => {
  const source = `@EndUserText.label: 'Solo'
define view I_Solo
  as select from i_solo as Solo
{
  key Solo.Id,
      Solo.Name
};
`;
  const views = parseCdsViews(source);
  assert.equal(views.length, 1);
  assert.equal(views[0]!.technicalName, "I_Solo");
  assert.equal(views[0]!.sourceTables[0], "i_solo");
});

test("parseCdsViews: data category hint is surfaced per view", async () => {
  const source = await readFile(fixturePath, "utf8");
  const views = parseCdsViews(source);
  for (const v of views) {
    assert.ok(typeof v.dataCategory === "string" && v.dataCategory.length > 0);
  }
});

test("parseCdsViews: returns empty for a source with no CDS views", () => {
  assert.deepEqual(parseCdsViews("this is not cds\nno view here\n"), []);
});
