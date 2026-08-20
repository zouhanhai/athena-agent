import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseUi5Units, type Ui5Unit } from "../../src/kb/codeparse/ui5.js";

const FIXTURE_ROOT = join(import.meta.dirname, "..", "fixtures", "ui5", "webapp");

/** Walk a fixture dir recursively into a `relPath -> content` map (POSIX paths),
 *  preserving the `webapp/` app-root prefix). */
function loadWebappDir(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else files[`webapp/${relative(root, abs).split(sep).join("/")}`] = readFileSync(abs, "utf8");
    }
  };
  walk(root);
  return files;
}

test("parseUi5Units: one unit per controller; a >400-line controller splits per method", () => {
  const files = loadWebappDir(FIXTURE_ROOT);
  const units = parseUi5Units(files, { component: "com.caleo.consolidation" });

  // Dashboard.controller.js is short -> 1 unit; Report.controller.js is >400
  // lines -> split into 1 unit per top-level method.
  const dashboard = units.filter((u) => u.name === "Dashboard.controller");
  const report = units.filter((u) => u.name === "Report.controller");

  assert.equal(dashboard.length, 1);
  assert.equal(report.length, 12); // onInit, onBeforeRendering, onAfterRendering,
  // onPeriodChange, onCompanyChange, onLoadGrid, onRefreshGrid, onExportExcel,
  // onNavToDetail, _buildFilters, _loadConsolidationGrid, _mapRowToEntity

  // Short controller keeps the whole body verbatim.
  assert.equal(dashboard[0]!.text.includes("onTilePress"), true);
  assert.equal(dashboard[0]!.method, null);

  // Every split method unit carries its method name + verbatim body.
  const onInit = report.find((u) => u.method === "onInit")!;
  assert.ok(onInit.text.includes("onInit: function"));
  assert.ok(onInit.text.includes("aRows.push"));
  assert.ok(!onInit.text.includes("onLoadGrid"));

  // path = <component>/<modulePath> preserves app location + controller name.
  assert.equal(dashboard[0]!.path, "com.caleo.consolidation/controller/Dashboard.controller");
  assert.equal(onInit.path, "com.caleo.consolidation/controller/Report.controller/onInit");
});

test("parseUi5Units: view.xml, manifest.json and .model.json each yield one unit", () => {
  const files = loadWebappDir(FIXTURE_ROOT);
  const units = parseUi5Units(files, { component: "com.caleo.consolidation" });

  const view = units.filter((u) => u.kind === "view");
  const manifests = units.filter((u) => u.kind === "manifest");
  const models = units.filter((u) => u.kind === "model");

  assert.equal(view.length, 1);
  assert.equal(manifests.length, 1);
  assert.equal(models.length, 1);

  assert.equal(view[0]!.text.includes("controllerName"), true);
  assert.ok(view[0]!.text.includes("<Table"));
  assert.equal(view[0]!.path, "com.caleo.consolidation/view/Report.view");

  // manifest carries the data-source config (OData / odata service uris).
  assert.equal(manifests[0]!.text.includes('"/odata/consolidation"'), true);
  assert.equal(models[0]!.text.includes("CDS_VIEW"), true);
});

test("parseUi5Units: node_modules / third-party files are excluded from intake", () => {
  const files = loadWebappDir(FIXTURE_ROOT);
  const units = parseUi5Units(files, { component: "com.caleo.consolidation" });

  assert.ok(units.every((u) => !u.file.includes("node_modules")));
  assert.ok(units.every((u) => !u.file.includes("somelib")));
});

test("parseUi5Units: deterministic ids + stable unique id per unit", () => {
  const files = loadWebappDir(FIXTURE_ROOT);
  const a = parseUi5Units(files, { component: "com.caleo.consolidation" });
  const b = parseUi5Units(files, { component: "com.caleo.consolidation" });

  const ids = new Set(a.map((u) => u.id));
  assert.equal(ids.size, a.length);
  assert.deepEqual(a.map((u) => u.id), b.map((u) => u.id));
});

test("parseUi5Units: empty input yields no units (no crash)", () => {
  const units = parseUi5Units({}, { component: "com.caleo.consolidation" });
  assert.deepEqual(units, []);
});

test("parseUi5Units: locally extracts OData service + CDS-view references (enrichment hook)", () => {
  const files = loadWebappDir(FIXTURE_ROOT);
  const units = parseUi5Units(files, { component: "com.caleo.consolidation" });

  // The Report controller binds the /reporting/ OData service and the CDS_VIEW.
  const report = units.filter((u) => u.name === "Report.controller");
  assert.ok(report.length >= 1);

  const services = report.flatMap((u) => u.references);
  assert.ok(services.some((r) => r.kind === "odata" && (r.service ?? "").includes("reporting")));
  assert.ok(services.some((r) => r.kind === "cds" && r.target === "CDS_VIEW"));

  // The manifest carries the /odata/consolidation + /reporting/ services.
  const manifest = units.find((u) => u.kind === "manifest")!;
  assert.ok(manifest.references.some((r) => (r.service ?? "").includes("odata/consolidation")));
});
