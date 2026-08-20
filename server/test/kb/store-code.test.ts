import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCdsViews, type CdsView } from "../../src/kb/codeparse/cds.js";
import { cdsViewsToChunks, storeCodeOutput } from "../../src/kb/store/code.js";
import type { CdsCodeChunk } from "../../src/kb/store/code.js";

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

test("storeCodeOutput: provenance is rendered into the markdown frontmatter", async () => {
  const source = await readFile(fixturePath, "utf8");
  const views = parseCdsViews(source);
  await withTempDir(async (dir) => {
    const result = await storeCodeOutput(source, views, {
      storageDir: dir,
      provenance: { system: "S4H", devclass: "ZCNSLD", transport: "K900123" },
    });
    const md = await readFile(result.md_ref, "utf8");
    assert.ok(md.includes("system: S4H"));
    assert.ok(md.includes("devclass: ZCNSLD"));
    assert.ok(md.includes("transport: K900123"));
  });
});

test("storeCodeOutput: empty source stores zero chunks (no crash)", async () => {
  await withTempDir(async (dir) => {
    const result = await storeCodeOutput("", [], { storageDir: dir });
    assert.equal(result.chunk_count, 0);
    assert.deepEqual(result.names, []);
  });
});
