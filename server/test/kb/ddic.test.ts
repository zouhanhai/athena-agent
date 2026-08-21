import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDdicTables, type DdicTable } from "../../src/kb/codeparse/ddic.js";
import { ddicTablesToChunks, ddicTablesToGraph, storeDdicOutput, type DdicCodeChunk } from "../../src/kb/store/ddic.js";

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "ddic", "mara-t001.json");

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ddic-code-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- parser (G4.S8.T9) -------------------------------------------------------

test("parseDdicTables: parses a JSON array of table descriptors, normalizing field metadata", () => {
  const tables = parseDdicTables('[{"name":"MARA","description":"General Material Data","fields":[{"name":"MATNR","key":true,"dataType":"CHAR","dataElement":"MATNR","domain":"MATNR","description":"Material Number"}]}]');
  assert.equal(tables.length, 1);
  const t = tables[0]!;
  assert.equal(t.name, "MARA");
  assert.equal(t.description, "General Material Data");
  assert.equal(t.fields.length, 1);
  assert.equal(t.fields[0]!.name, "MATNR");
  assert.equal(t.fields[0]!.key, true);
  assert.equal(t.fields[0]!.dataType, "CHAR");
  assert.equal(t.fields[0]!.dataElement, "MATNR");
});

test("parseDdicTables: tolerant of unknown fields and missing description/keys", () => {
  const input = JSON.stringify([
    {
      name: "T001",
      unknownExtra: "ignored",
      fields: [
        { name: "BUKRS", somethingExtra: true, key: true },
        { name: "BUTXT" },
      ],
    },
  ]);
  const tables = parseDdicTables(input);
  assert.equal(tables.length, 1);
  const t = tables[0]!;
  assert.equal(t.description, undefined);
  assert.equal(t.fields.length, 2);
  assert.equal(t.fields[0]!.key, true);
  assert.equal(t.fields[1]!.key, undefined);
});

test("parseDdicTables: empty fields array is allowed (header chunk only)", () => {
  const tables = parseDdicTables('[{"name":"EMPTY","fields":[]}]');
  assert.equal(tables.length, 1);
  assert.equal(tables[0]!.fields.length, 0);
});

test("parseDdicTables: rejects malformed JSON with a clear error", () => {
  assert.throws(() => parseDdicTables("not-json"), /JSON|parse|invalid/i);
});

test("parseDdicTables: rejects a non-array top-level with a clear error", () => {
  assert.throws(() => parseDdicTables('{"name":"MARA","fields":[]}'), /array|list/i);
});

test("parseDdicTables: rejects a malformed descriptor naming the offending index", () => {
  const input = JSON.stringify([{ name: "OK", fields: [] }, { fields: [] }]);
  assert.throws(
    () => parseDdicTables(input),
    /1/i, // table index 1 is missing `name`
  );
});

// --- chunking (G4.S8.T9) ------------------------------------------------------

test("ddicTablesToChunks: one header chunk per table plus ~20-field group chunks", async () => {
  const raw = await readFile(FIXTURE, "utf8");
  const tables = parseDdicTables(raw);

  const mara = tables.find((t) => t.name === "MARA")!;
  // 26 fields → 1 header + 2 field-group chunks (20 + 6).
  const maraChunks = ddicTablesToChunks([mara]);
  const maraHeaders = maraChunks.filter((c) => c.heading_path.endsWith("/_header"));
  const maraGroups = maraChunks.filter((c) => c.heading_path.includes("/fields/"));

  assert.equal(maraHeaders.length, 1);
  assert.equal(maraGroups.length, 2);
  assert.ok(maraChunks.some((c) => c.heading_path === "MARA/fields/1"));
  assert.ok(maraChunks.some((c) => c.heading_path === "MARA/_header"));

  // The path is `MARA/fields/<n>` — mirrors the code-channel RefinementChunk shape.
  const groupPaths = maraGroups.map((c) => c.heading_path).sort();
  assert.deepEqual(groupPaths, ["MARA/fields/1", "MARA/fields/2"]);

  // Header chunk text carries the table name + description + key-field names.
  const header = maraChunks.find((c) => c.heading_path === "MARA/_header")!;
  assert.ok(header.text.includes("MARA"));
  assert.ok(header.text.includes("General Material Data"));
  assert.ok(header.text.includes("MATNR"), "key field listed in header");

  // Field-group chunks carry fields (id + heading_path are RefinementChunk-shaped).
  for (const c of maraChunks) {
    assert.ok(typeof c.id === "string" && c.id.length > 0);
    assert.ok(c.heading_path.includes("MARA"));
  }
  // MARA field list preserved on chunks for downstream QA.
  assert.ok(maraChunks.every((c) => c.fields.length >= 0));
});

test("ddicTablesToChunks: table with <=20 fields yields header + one group", () => {
  const table: DdicTable = {
    name: "T001",
    description: "Company Codes",
    fields: [
      { name: "MANDT", key: true },
      { name: "BUKRS", key: true },
    ],
  };
  const chunks = ddicTablesToChunks([table]);
  assert.equal(chunks.length, 2); // header + one fields group
  assert.ok(chunks.some((c) => c.heading_path === "T001/_header"));
  assert.ok(chunks.some((c) => c.heading_path === "T001/fields/1"));
});

test("ddicTablesToChunks: empty fields → header chunk only", () => {
  const table: DdicTable = { name: "EMPTY", fields: [] };
  const chunks = ddicTablesToChunks([table]);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.heading_path, "EMPTY/_header");
});

// --- store façade (G4.S8.T9) --------------------------------------------------

test("storeDdicOutput: writes chunks.json + markdown.md with frontmatter type=code topic=code/<system>", async () => {
  const raw = await readFile(FIXTURE, "utf8");
  const tables = parseDdicTables(raw);

  await withTempDir(async (dir) => {
    const result = await storeDdicOutput(tables, { storageDir: dir, provenance: { system: "prd", devclass: "ZFI" } });
    assert.ok(result.chunk_count > 0);
    assert.equal(result.names.includes("MARA"), true);

    const chunks = JSON.parse(await readFile(result.chunks_ref, "utf8")) as DdicCodeChunk[];
    assert.ok(chunks.length > 0);
    assert.ok(chunks.some((c) => c.heading_path === "MARA/_header"));

    const md = await readFile(result.md_ref, "utf8");
    assert.ok(md.includes("type: code"));
    assert.ok(md.includes("topic: code/prd"), `expected topic code/prd in:\n${md}`);
    assert.ok(md.includes("system: prd"));
    // Markdown renders the field tables (field documentation).
    assert.ok(md.includes("MATNR"));
  });
});

test("storeDdicOutput: topic defaults to code/unknown when no system is reported", async () => {
  const raw = await readFile(FIXTURE, "utf8");
  const tables = parseDdicTables(raw);
  await withTempDir(async (dir) => {
    const result = await storeDdicOutput(tables, { storageDir: dir, provenance: {} });
    const md = await readFile(result.md_ref, "utf8");
    assert.ok(md.includes("topic: code/unknown"), `expected code/unknown in:\n${md}`);
  });
});

test("storeDdicOutput: ref carries table entities + REFERENCES edges incl. external FK targets", async () => {
  const raw = await readFile(FIXTURE, "utf8");
  const tables = parseDdicTables(raw);
  const mara = tables.find((t) => t.name === "MARA")!;

  await withTempDir(async (dir) => {
    const result = await storeDdicOutput(tables, { storageDir: dir });
    const { entities, relations } = result.ref;

    // table entity for every submitted table, canonical uppercase (G4.S8.T12:
    // lowercase `table` type, aligned with the other code emitters).
    assert.ok(entities.some((e) => e.name === "MARA" && e.type === "table"));
    assert.ok(entities.some((e) => e.name === "T001" && e.type === "table"));
    assert.ok(entities.every((e) => e.name === e.name.toUpperCase()), "canonical uppercase");

    // External foreign-key targets (T134/T023/T006) are emitted as entities too.
    assert.ok(entities.some((e) => e.name === "T134"), "external FK target T134 emitted");
    assert.ok(entities.some((e) => e.name === "T023"), "external FK target T023 emitted");
    assert.ok(entities.some((e) => e.name === "T006"), "external FK target T006 emitted");

    // REFERENCES edges from the table to its FK targets.
    assert.ok(relations.some((r) => r.source === "MARA" && r.target === "T134" && r.keywords.includes("REFERENCES")));

    const maraRefs = relations.filter((r) => r.source === mara.name.toUpperCase());
    assert.equal(maraRefs.length, mara.foreignKeys!.length);
  });
});

test("storeDdicOutput: no foreignKeys → only the Table entity, no relations", async () => {
  const table: DdicTable = { name: "T001", description: "Company Codes", fields: [{ name: "BUKRS", key: true }] };
  await withTempDir(async (dir) => {
    const result = await storeDdicOutput([table], { storageDir: dir });
    assert.ok(result.ref.entities.some((e) => e.name === "T001"));
    assert.deepEqual(result.ref.relations, []);
  });
});

test("storeDdicOutput: empty tables store zero chunks (no crash)", async () => {
  await withTempDir(async (dir) => {
    const result = await storeDdicOutput([], { storageDir: dir });
    assert.equal(result.chunk_count, 0);
    assert.deepEqual(result.names, []);
  });
});
