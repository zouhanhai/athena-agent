import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAbapUnits, type AbapUnit } from "../../src/kb/codeparse/abap.js";
import { storeAbapOutput, abapUnitsToChunks, abapUnitsToGraph } from "../../src/kb/store/code.js";

function makeUnit(opts: {
  name: string;
  objectType?: AbapUnit["objectType"];
  dependencies?: AbapUnit["dependencies"];
}): AbapUnit {
  return {
    id: `c1`,
    objectType: opts.objectType ?? "class",
    devName: opts.name,
    devclass: null,
    system: null,
    text: `CLASS ${opts.name} IMPLEMENTATION.`,
    path: `${opts.name}`,
    method: null,
    dependencies: opts.dependencies ?? [],
    warnings: [],
  };
}

const CLASS_FIXTURE = join(import.meta.dirname, "..", "fixtures", "abap", "zcl_fi_delivery.clas.abap");

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "abap-code-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("abapUnitsToChunks: one chunk per unit with module_path = devclass/name/method", async () => {
  const source = await readFile(CLASS_FIXTURE, "utf8");
  const units = parseAbapUnits(source, { devclass: "ZFIDL", system: "S4H" });
  const chunks = abapUnitsToChunks(units);

  assert.equal(chunks.length, units.length);
  assert.equal(chunks.length, 3);

  const save = chunks.find((c) => c.method === "save")!;
  // Reuses the RefinementChunk contract: id + text + path (heading_path).
  assert.equal(typeof save.id, "string");
  assert.ok(save.id.length > 0);
  assert.ok(save.text.includes("METHOD save."));
  // path = devclass/name/method (heading_path overloaded, module_path literal).
  assert.equal(save.heading_path, "ZFIDL/zcl_fi_delivery/save");
  assert.equal(save.modulePath, "ZFIDL/zcl_fi_delivery/save");
  assert.equal(save.objectType, "class");
  assert.equal(save.devName, "zcl_fi_delivery");
});

test("storeAbapOutput: writes chunks.json (RefinementChunk[] shape) + markdown page, counts match units", async () => {
  const source = await readFile(CLASS_FIXTURE, "utf8");
  const units = parseAbapUnits(source, { devclass: "ZFIDL", system: "S4H" });
  assert.ok(units.length > 0);

  await withTempDir(async (dir) => {
    const result = await storeAbapOutput(units, { storageDir: dir });
    assert.equal(result.chunk_count, units.length);
    assert.equal(result.names.length, units.length);

    const onDisk = JSON.parse(await readFile(result.chunks_ref, "utf8")) as Array<{
      id: string;
      text: string;
      heading_path: string;
      modulePath: string;
    }>;
    assert.equal(onDisk.length, units.length);
    for (const chunk of onDisk) {
      assert.ok(typeof chunk.id === "string" && chunk.id.length > 0);
      assert.ok(typeof chunk.text === "string" && chunk.text.length > 0);
      assert.ok(chunk.heading_path.includes("/"));
      assert.equal(chunk.modulePath, chunk.heading_path);
    }
    // The joined markdown page holds every unit's source verbatim.
    const md = await readFile(result.md_ref, "utf8");
    assert.ok(md.includes("METHOD save."));
    assert.ok(md.includes("METHOD post."));
  });
});

test("storeAbapOutput: provenance is rendered into the markdown frontmatter + topic code/<system>", async () => {
  const source = await readFile(CLASS_FIXTURE, "utf8");
  const units = parseAbapUnits(source);
  await withTempDir(async (dir) => {
    const result = await storeAbapOutput(units, {
      storageDir: dir,
      provenance: { system: "S4H", devclass: "ZFIDL", transport: "K900456" },
    });
    const md = await readFile(result.md_ref, "utf8");
    assert.ok(md.includes("type: code"));
    assert.ok(md.includes("topic: code/s4h"), `expected topic code/s4h in:\n${md}`);
    assert.ok(md.includes("system: S4H"));
    assert.ok(md.includes("devclass: ZFIDL"));
    assert.ok(md.includes("transport: K900456"));
  });
});

test("storeAbapOutput: topic falls back to code/unknown when no system is reported", async () => {
  const source = await readFile(CLASS_FIXTURE, "utf8");
  const units = parseAbapUnits(source);
  await withTempDir(async (dir) => {
    const result = await storeAbapOutput(units, { storageDir: dir, provenance: { devclass: "ZFIDL" } });
    const md = await readFile(result.md_ref, "utf8");
    assert.ok(md.includes("topic: code/unknown"), `expected code/unknown fallback in:\n${md}`);
  });
});

test("storeAbapOutput: empty units stores zero chunks (no crash)", async () => {
  await withTempDir(async (dir) => {
    const result = await storeAbapOutput([], { storageDir: dir });
    assert.equal(result.chunk_count, 0);
    assert.deepEqual(result.names, []);
  });
});

test("abapUnitsToGraph: unit + every dependency as uppercase entities, READS_FROM/CALLS relations", () => {
  const { entities, relations } = abapUnitsToGraph([
    makeUnit({
      name: "zcl_fi_delivery",
      dependencies: [
        { kind: "table_read", name: "mara" },
        { kind: "call_function", name: "Z_FI_POST" },
        { kind: "call_method", name: "post" },
        { kind: "call_form", name: "init" },
      ],
    }),
  ]);

  assert.deepEqual(
    entities.map((e) => e.name).sort(),
    ["INIT", "MAR", "POST", "ZCL_FI_DELIVERY", "Z_FI_POST"].map((n) => (n === "MAR" ? "MARA" : n)).sort(),
  );
  assert.ok(entities.every((e) => e.name === e.name.toUpperCase()), "canonical uppercase");

  assert.deepEqual(relations.map((r) => `${r.keywords[0]!}|${r.source}|${r.target}`).sort(), [
    "CALLS|ZCL_FI_DELIVERY|INIT",
    "CALLS|ZCL_FI_DELIVERY|POST",
    "CALLS|ZCL_FI_DELIVERY|Z_FI_POST",
    "READS_FROM|ZCL_FI_DELIVERY|MARA",
  ]);
});

test("abapUnitsToGraph: dedupes duplicate entities and relations within one ref", () => {
  const { entities, relations } = abapUnitsToGraph([
    makeUnit({
      name: "zcl_a",
      dependencies: [
        { kind: "table_read", name: "mara" },
        { kind: "table_read", name: "MARA" },
      ],
    }),
    makeUnit({ name: "zcl_b", dependencies: [{ kind: "table_read", name: "mara" }] }),
  ]);

  assert.deepEqual(entities.map((e) => e.name).sort(), ["MARA", "ZCL_A", "ZCL_B"]);
  assert.deepEqual(relations.map((r) => `${r.source}|${r.target}`).sort(), ["ZCL_A|MARA", "ZCL_B|MARA"]);
});

test("abapUnitsToGraph: empty units yield empty graph", () => {
  assert.deepEqual(abapUnitsToGraph([]), { entities: [], relations: [] });
});

test("storeAbapOutput: ref carries the mapped entities + relations from the parsed units", async () => {
  const source = await readFile(CLASS_FIXTURE, "utf8");
  const parsed = parseAbapUnits(source, { devclass: "ZFIDL", system: "S4H" });
  await withTempDir(async (dir) => {
    const result = await storeAbapOutput(parsed, { storageDir: dir });
    assert.ok(result.ref.entities.length > 0, "entities mapped");
    assert.ok(result.ref.relations.length > 0, "relations mapped");
    assert.ok(result.ref.entities.some((e) => e.name === "ZCL_FI_DELIVERY"));
  });
});
