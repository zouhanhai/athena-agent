import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { parseUi5Units, type Ui5Unit } from "../../src/kb/codeparse/ui5.js";
import { ui5UnitsToChunks, storeUi5Output, ui5UnitsToGraph, type Ui5CodeChunk } from "../../src/kb/store/code.js";

function makeUi5Unit(opts: { component?: string; references?: Ui5Unit["references"] }): Ui5Unit {
  return {
    id: "c1",
    kind: "controller",
    name: "Report.controller",
    file: "webapp/controller/Report.controller.js",
    component: opts.component ?? "com.caleo.consolidation",
    text: "sap.ui.define([...], function () {});",
    path: "com.caleo.consolidation/controller/Report.controller",
    method: null,
    references: opts.references ?? [],
    warnings: [],
  };
}

const FIXTURE_ROOT = join(import.meta.dirname, "..", "fixtures", "ui5", "webapp");

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

async function loadFixture(): Promise<Ui5Unit[]> {
  const files = await Promise.resolve(loadWebappDir(FIXTURE_ROOT));
  return parseUi5Units(files, { component: "com.caleo.consolidation" });
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ui5-code-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("ui5UnitsToChunks: one chunk per unit with path = <component>/<modulePath>[/<method>]", async () => {
  const units = await loadFixture();
  const chunks = ui5UnitsToChunks(units);

  assert.equal(chunks.length, units.length);
  assert.equal(chunks.length, 16); // 1 dashboard + 12 report-methods + 1 view + 1 manifest + 1 model

  const onInit = chunks.find((c) => c.method === "onInit")!;
  // Reuses the RefinementChunk contract: id + text + path (heading_path overloaded).
  assert.ok(onInit.heading_path.endsWith("controller/Report.controller/onInit"));
  assert.ok(onInit.heading_path.startsWith("com.caleo.consolidation/"));
  assert.equal(typeof onInit.text, "string");
  assert.ok(onInit.text.includes("onInit: function"));

  const view = chunks.find((c) => c.kind === "view")!;
  assert.equal(view.heading_path, "com.caleo.consolidation/view/Report.view");

  const manifest = chunks.find((c) => c.kind === "manifest")!;
  assert.equal(manifest.heading_path, "com.caleo.consolidation/manifest");
});

test("storeUi5Output: writes chunks.json + markdown page, counts match units", async () => {
  const units = await loadFixture();
  assert.ok(units.length > 0);

  await withTempDir(async (dir) => {
    const result = await storeUi5Output(units, { storageDir: dir });
    assert.equal(result.chunk_count, units.length);
    assert.equal(result.names.length, units.length);

    const onDisk = JSON.parse((await readFile(result.chunks_ref, "utf8"))) as Ui5CodeChunk[];
    assert.equal(onDisk.length, units.length);
    for (const chunk of onDisk) {
      assert.ok(typeof chunk.id === "string" && chunk.id.length > 0);
      assert.ok(typeof chunk.text === "string" && chunk.text.length > 0);
      assert.ok(chunk.heading_path.startsWith("com.caleo.consolidation/"));
    }
    const md = await readFile(result.md_ref, "utf8");
    assert.ok(md.includes("## webapp/controller/Report.controller.js"));
    assert.ok(md.includes("## webapp/view/Report.view.xml"));
  });
});

test("storeUi5Output: node_modules files never reach the stored chunks", async () => {
  const files = loadWebappDir(FIXTURE_ROOT);
  const units = parseUi5Units(files, { component: "com.caleo.consolidation" });

  await withTempDir(async (dir) => {
    const result = await storeUi5Output(units, { storageDir: dir });
    assert.ok(result.chunks.every((c) => !c.file.includes("node_modules")));
  });
});

test("storeUi5Output: provenance is rendered into the markdown frontmatter + topic code/<system>", async () => {
  const files = loadWebappDir(FIXTURE_ROOT);
  const units = parseUi5Units(files, { component: "com.caleo.consolidation" });
  await withTempDir(async (dir) => {
    const result = await storeUi5Output(units, {
      storageDir: dir,
      provenance: { system: "BTP", devclass: "ZCNSLD", transport: "K900124" },
    });
    const md = await readFile(result.md_ref, "utf8");
    assert.ok(md.includes("type: code"));
    assert.ok(md.includes("topic: code/btp"), `expected topic code/btp in:\n${md}`);
    assert.ok(md.includes("system: BTP"));
    assert.ok(md.includes("devclass: ZCNSLD"));
    assert.ok(md.includes("transport: K900124"));
  });
});

test("storeUi5Output: empty source stores zero chunks (no crash)", async () => {
  await withTempDir(async (dir) => {
    const result = await storeUi5Output([], { storageDir: dir });
    assert.equal(result.chunk_count, 0);
    assert.deepEqual(result.names, []);
  });
});

test("ui5UnitsToGraph: component + every reference target as uppercase entities, BINDS_TO relations", () => {
  const { entities, relations } = ui5UnitsToGraph([
    makeUi5Unit({
      component: "com.caleo.consolidation",
      references: [
        { kind: "cds", target: "I_CnsldtnSubitem_2" },
        { kind: "odata", service: "/reporting", target: "reporting" },
      ],
    }),
  ]);

  assert.deepEqual(
    entities.map((e) => e.name).sort(),
    ["COM.CALEO.CONSOLIDATION", "I_CNSLDTNSUBITEM_2", "REPORTING"],
  );
  assert.ok(entities.every((e) => e.name === e.name.toUpperCase()), "canonical uppercase");

  assert.deepEqual(relations.map((r) => `${r.keywords[0]!}|${r.source}|${r.target}`).sort(), [
    "BINDS_TO|COM.CALEO.CONSOLIDATION|I_CNSLDTNSUBITEM_2",
    "BINDS_TO|COM.CALEO.CONSOLIDATION|REPORTING",
  ]);
});

test("ui5UnitsToGraph: dedupes duplicate entities and relations within one ref", () => {
  const { entities, relations } = ui5UnitsToGraph([
    makeUi5Unit({ references: [{ kind: "cds", target: "CDS_VIEW" }] }),
    makeUi5Unit({ references: [{ kind: "cds", target: "CDS_VIEW" }] }),
  ]);

  assert.deepEqual(entities.map((e) => e.name).sort(), ["CDS_VIEW", "COM.CALEO.CONSOLIDATION"]);
  assert.deepEqual(
    relations.map((r) => `${r.keywords[0]!}|${r.source}|${r.target}`),
    ["BINDS_TO|COM.CALEO.CONSOLIDATION|CDS_VIEW"],
  );
});

test("ui5UnitsToGraph: empty units yield empty graph", () => {
  assert.deepEqual(ui5UnitsToGraph([]), { entities: [], relations: [] });
});

test("storeUi5Output: ref carries the mapped entities + relations from the parsed units", async () => {
  const units = await loadFixture();
  await withTempDir(async (dir) => {
    const result = await storeUi5Output(units, { storageDir: dir });
    assert.ok(result.ref.entities.length > 0, "entities mapped");
    assert.ok(result.ref.relations.length > 0, "relations mapped");
    assert.ok(result.ref.entities.some((e) => e.name === "COM.CALEO.CONSOLIDATION"));
  });
});
