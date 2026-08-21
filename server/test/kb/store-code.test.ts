import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCdsViews, type CdsView } from "../../src/kb/codeparse/cds.js";
import { cdsViewsToChunks, cdsViewsToGraph, storeCodeOutput } from "../../src/kb/store/code.js";
import type { CdsCodeChunk } from "../../src/kb/store/code.js";

function makeView(opts: {
  name: string;
  sourceTables?: string[];
  associations?: Array<{ name: string; target: string }>;
}): CdsView {
  return {
    technicalName: opts.name,
    order: 0,
    rawText: `define view ${opts.name} as select from ... { }`,
    rawMembers: [],
    sourceTables: opts.sourceTables ?? [],
    annotations: [],
    associations: opts.associations ?? [],
    dataCategory: "unknown",
    warnings: [],
  };
}

const fixturePath = join(import.meta.dirname, "..", "fixtures", "cds", "gr-cds-scope.cds");

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "cds-code-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("cdsViewsToChunks: one chunk per view with path = dataCategory/technicalName", async () => {
  const source = await readFile(fixturePath, "utf8");
  const views = parseCdsViews(source);
  const chunks = cdsViewsToChunks(views);

  assert.equal(chunks.length, views.length);
  assert.equal(chunks.length, 5);

  const subitem = chunks.find((c) => c.technicalName === "I_CnsldtnSubitem_2")!;
  // Reuses the RefinementChunk contract: id + text + path (heading_path overloaded).
  assert.equal(typeof subitem.id, "string");
  assert.ok(subitem.id.length > 0);
  assert.ok(subitem.text.includes("@AbapCatalog"));
  // path = dataCategory/technicalName (not a markdown heading chain), with a
  // non-empty data-category prefix from best-effort classification.
  assert.ok(subitem.heading_path.endsWith("/I_CnsldtnSubitem_2"));
  assert.ok(subitem.dataCategory.length > 0);
  assert.ok(subitem.heading_path.startsWith(subitem.dataCategory));
  assert.ok(subitem.heading_path.includes("/"));
  assert.ok(!subitem.heading_path.includes(" # "));
});

test("cdsViewsToChunks: the raw DDL text is stored verbatim (no data left behind)", async () => {
  const source = await readFile(fixturePath, "utf8");
  const views = parseCdsViews(source);
  const chunks = cdsViewsToChunks(views);

  const first = chunks[0]!;
  assert.ok(first.text.includes("define view "));
  assert.ok(first.text.trimEnd().endsWith("}") || first.text.trimEnd().endsWith(";"));

  const names = chunks.map((c) => c.technicalName);
  assert.ok(names.includes("I_CnsldtnSubitem_2"));
  assert.ok(names.includes("I_CnsldtnGroup"));
});

test("storeCodeOutput: writes chunks.json (RefinementChunk[] shape) + markdown page, counts match views", async () => {
  const source = await readFile(fixturePath, "utf8");
  const views = parseCdsViews(source);
  assert.ok(views.length > 0);

  await withTempDir(async (dir) => {
    const result = await storeCodeOutput(source, views, { storageDir: dir });
    assert.equal(result.chunk_count, views.length);
    assert.equal(result.names.length, views.length);
    assert.ok(result.names.includes("I_CnsldtnSubitem_2"));

    const onDisk = JSON.parse(await readFile(result.chunks_ref, "utf8")) as CdsCodeChunk[];
    assert.equal(onDisk.length, views.length);
    for (const chunk of onDisk) {
      assert.ok(typeof chunk.id === "string" && chunk.id.length > 0);
      assert.ok(typeof chunk.text === "string" && chunk.text.length > 0);
      assert.ok(chunk.heading_path.includes("/"));
      assert.ok(chunk.heading_path.includes(chunk.technicalName));
    }
    // The joined markdown page is the full DDL text of every view.
    const md = await readFile(result.md_ref, "utf8");
    assert.ok(md.includes("define view I_CnsldtnSubitem_2"));
    assert.ok(md.includes("define view I_CnsldtnGroup"));
  });
});

test("cdsViewsToChunks: members carries the select-body field/expression lines (G4.S8.T11)", async () => {
  const source = await readFile(fixturePath, "utf8");
  const views = parseCdsViews(source);
  const chunks = cdsViewsToChunks(views);

  assert.equal(chunks.length, views.length);
  for (const view of views) {
    const chunk = chunks.find((c) => c.technicalName === view.technicalName)!;
    assert.ok(chunk, `chunk exists for ${view.technicalName}`);
    // members mirrors the parser's rawMembers exactly.
    assert.deepEqual(chunk.members, view.rawMembers);
    assert.ok(Array.isArray(chunk.members));
    // members are real select-body lines (at least for a valued fixture view).
    const valued = views.find((v) => v.rawMembers.length > 0);
    if (valued) {
      const valuedChunk = chunks.find((c) => c.technicalName === valued.technicalName)!;
      assert.ok(valuedChunk.members.length > 0);
      assert.ok(valuedChunk.members.some((m) => /^[A-Za-z_][A-Za-z0-9_]*/.test(m)));
    }
  }

  // on-disk chunks.json also carries members (survives the store façade).
  await withTempDir(async (dir) => {
    const result = await storeCodeOutput(source, views, { storageDir: dir });
    const onDisk = JSON.parse(await readFile(result.chunks_ref, "utf8")) as CdsCodeChunk[];
    assert.ok(onDisk.every((c) => Array.isArray(c.members)));
  });
});

test("storeCodeOutput: deterministic chunk ids (stable path in chunks.json)", async () => {
  const source = await readFile(fixturePath, "utf8");
  const views = parseCdsViews(source);

  const ids = new Map<string, string[]>();
  await withTempDir(async (dir) => {
    const a = await storeCodeOutput(source, views, { storageDir: dir });
    ids.set("a", a.chunks.map((c) => c.id));
  });
  await withTempDir(async (dir) => {
    const b = await storeCodeOutput(source, views, { storageDir: dir });
    ids.set("b", b.chunks.map((c) => c.id));
  });
  assert.deepEqual(ids.get("a"), ids.get("b"));
});

test("storeCodeOutput: provenance is rendered into the markdown frontmatter + topic code/<system>", async () => {
  const source = await readFile(fixturePath, "utf8");
  const views = parseCdsViews(source);
  await withTempDir(async (dir) => {
    const result = await storeCodeOutput(source, views, {
      storageDir: dir,
      provenance: { system: "S4H", devclass: "ZCNSLD", transport: "K900123" },
    });
    const md = await readFile(result.md_ref, "utf8");
    assert.ok(md.includes("type: code"));
    assert.ok(md.includes("topic: code/s4h"), `expected topic code/s4h in:\n${md}`);
    assert.ok(md.includes("system: S4H"));
    assert.ok(md.includes("devclass: ZCNSLD"));
    assert.ok(md.includes("transport: K900123"));
  });
});

test("storeCodeOutput: topic defaults to code/unknown when no system is reported", async () => {
  const source = await readFile(fixturePath, "utf8");
  const views = parseCdsViews(source);
  await withTempDir(async (dir) => {
    const result = await storeCodeOutput(source, views, {
      storageDir: dir,
      provenance: { devclass: "ZCNSLD" },
    });
    const md = await readFile(result.md_ref, "utf8");
    assert.ok(md.includes("topic: code/unknown"), `expected code/unknown fallback in:\n${md}`);
  });
});

test("storeCodeOutput: topic system value is sanitized into a safe slug", async () => {
  const source = await readFile(fixturePath, "utf8");
  const views = parseCdsViews(source);
  await withTempDir(async (dir) => {
    const result = await storeCodeOutput(source, views, {
      storageDir: dir,
      provenance: { system: "PRD Backup/Test!" },
    });
    const md = await readFile(result.md_ref, "utf8");
    const topicLine = md.match(/^topic: (.+)$/m)?.[1];
    assert.equal(topicLine, "code/prd-backup-test", `unexpected topic: ${topicLine}`);
  });
});

test("storeCodeOutput: empty source stores zero chunks (no crash)", async () => {
  await withTempDir(async (dir) => {
    const result = await storeCodeOutput("", [], { storageDir: dir });
    assert.equal(result.chunk_count, 0);
    assert.deepEqual(result.names, []);
  });
});

test("cdsViewsToGraph: view + every sourceTable/association target as uppercase entities, READS_FROM/ASSOCIATES relations", () => {
  const { entities, relations } = cdsViewsToGraph([
    makeView({
      name: "i_cnsldtnsubitem_2",
      sourceTables: ["mara", "I_T005"],
      associations: [
        { name: "_Text", target: "I_CnsldtnSubitmTx" },
        { name: "_Group", target: "i_cnsldtngroup" },
      ],
    }),
  ]);

  // Entities: the submitted view + every external target, all canonical uppercase.
  assert.deepEqual(
    entities.map((e) => e.name).sort(),
    ["I_CNSLDTNGROUP", "I_CNSLDTNSUBITEM_2", "I_CNSLDTNSUBITMTX", "I_T005", "MARA"],
  );
  assert.ok(entities.every((e) => e.name === e.name.toUpperCase()), "canonical uppercase");

  // Relations: view READS_FROM each sourceTable, view ASSOCIATES each target.
  const relationPairs = relations
    .map((r) => `${r.keywords[0]!}|${r.source}|${r.target}`)
    .sort();
  assert.deepEqual(relationPairs, [
    "ASSOCIATES|I_CNSLDTNSUBITEM_2|I_CNSLDTNGROUP",
    "ASSOCIATES|I_CNSLDTNSUBITEM_2|I_CNSLDTNSUBITMTX",
    "READS_FROM|I_CNSLDTNSUBITEM_2|I_T005",
    "READS_FROM|I_CNSLDTNSUBITEM_2|MARA",
  ]);
  assert.ok(relations.every((r) => typeof r.description === "string" && r.description.length > 0));
});

test("cdsViewsToGraph: dedupes duplicate entities and relations within one ref", () => {
  const { entities, relations } = cdsViewsToGraph([
    makeView({ name: "V1", sourceTables: ["mara", "mara", "MARA"], associations: [{ name: "A", target: "T1" }] }),
    makeView({ name: "V2", sourceTables: ["mara"], associations: [{ name: "A", target: "T1" }] }),
  ]);

  assert.deepEqual(entities.map((e) => e.name).sort(), ["MARA", "T1", "V1", "V2"]);
  assert.deepEqual(
    relations.map((r) => `${r.source}|${r.keywords[0]!}|${r.target}`).sort(),
    ["V1|ASSOCIATES|T1", "V1|READS_FROM|MARA", "V2|ASSOCIATES|T1", "V2|READS_FROM|MARA"],
  );
});

test("cdsViewsToGraph: empty views yield empty graph", () => {
  assert.deepEqual(cdsViewsToGraph([]), { entities: [], relations: [] });
});

test("storeCodeOutput: ref carries the mapped entities + relations from the parsed views", async () => {
  const source = await readFile(fixturePath, "utf8");
  const views = parseCdsViews(source);
  const cdsView = views.find((v) => v.technicalName === "I_CnsldtnSubitem_2")!;
  const expected: CdsView[] = [
    makeView({ name: cdsView.technicalName, sourceTables: cdsView.sourceTables, associations: cdsView.associations }),
  ];
  await withTempDir(async (dir) => {
    const result = await storeCodeOutput("", expected, { storageDir: dir });
    assert.ok(result.ref.entities.length > 0, "entities mapped");
    assert.ok(result.ref.relations.length > 0, "relations mapped");
    assert.ok(result.ref.entities.some((e) => e.name === "I_CNSLDTNSUBITEM_2"));
    assert.ok(result.ref.relations.every((r) => r.source === "I_CNSLDTNSUBITEM_2"));
  });
});
