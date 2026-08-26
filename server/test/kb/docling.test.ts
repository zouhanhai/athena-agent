import { test } from "node:test";
import assert from "node:assert/strict";
import { DoclingParser } from "../../src/kb/docling.js";

function makeParser(opts: {
  stdout?: string;
  markdown?: string;
  error?: Error;
  hash?: string | null;
  exists?: Record<string, boolean>;
  sidecar?: Record<string, string>;
}) {
  const execCalls: [string, string[]][] = [];
  const readCalls: string[] = [];
  const written: Record<string, string> = {};
  const parser = new DoclingParser({
    pythonBin: "/opt/docling/bin/python",
    scriptPath: "/opt/parse_doc.py",
    outputDir: "/shared/input",
    execFileImpl: async (file, args) => {
      execCalls.push([file, args]);
      if (opts.error) throw opts.error;
      return { stdout: opts.stdout ?? "/shared/input/doc.md\n", stderr: "" };
    },
    readFileImpl: async (path) => {
      readCalls.push(path);
      if (path.endsWith(".sha256")) return opts.sidecar?.[path] ?? "deadbeef";
      if (path.endsWith(".outline.json")) return opts.sidecar?.[path] ?? opts.markdown ?? "# Doc";
      return opts.markdown ?? "# Doc";
    },
    mkdirImpl: async () => {},
    hashFileImpl: async () => opts.hash ?? null,
    existsImpl: async (path) => opts.exists?.[path] ?? false,
    writeSmallFileImpl: async (path, content) => {
      written[path] = content;
    },
  });
  return { parser, execCalls, readCalls, written };
}

test("parse invokes python parse_doc.py with input + shared input-dir + --images-dir and returns markdown", async () => {
  const { parser, execCalls, readCalls } = makeParser({
    stdout: "/shared/input/report.pdf.md\n",
    markdown: "# Report\n\nBody",
    hash: "abc",
  });
  const result = await parser.parse("/tmp/report.pdf");

  assert.deepEqual(execCalls, [
    [
      "/opt/docling/bin/python",
      [
        "/opt/parse_doc.py",
        "/tmp/report.pdf",
        "/shared/input",
        "--images-dir",
        "/shared/input/images/report.pdf",
      ],
    ],
  ]);
  assert.deepEqual(readCalls, ["/shared/input/report.pdf.md", "/shared/input/report.pdf.md.outline.json"]);
  assert.equal(result.markdown, "# Report\n\nBody");
  assert.equal(result.outputPath, "/shared/input/report.pdf.md");
  assert.equal(result.stem, "report.pdf");
  assert.equal(result.imagesDir, "/shared/input/images/report.pdf");
  assert.equal(result.outline, null, "missing/unusable outline sidecar → no TOC (never blocks)");
});

test("parse returns the docling outline from the .outline.json sidecar (TOC-first grading input)", async () => {
  const outlineJson = JSON.stringify({
    text: "",
    level: 0,
    children: [
      { text: "Chapter One", level: 1, children: [{ text: "Sub One", level: 2, children: [] }] },
      { text: "Chapter Two", level: 1, children: [] },
    ],
  });
  const { parser } = makeParser({
    stdout: "/shared/input/report.pdf.md\n",
    markdown: "# Report\n\nBody",
    hash: "abc",
    sidecar: { "/shared/input/report.pdf.md.outline.json": outlineJson },
  });
  const result = await parser.parse("/tmp/report.pdf");

  // the parsed tree carries the SAME structural hierarchy the grader consumes
  assert.ok(result.outline, "outline sidecar parsed");
  assert.equal(result.outline!.text, "");
  assert.equal(result.outline!.level, 0);
  assert.deepEqual(
    result.outline!.children!.map((c) => [c.text, c.level, c.children?.map((g) => g.text) ?? []]),
    [
      ["Chapter One", 1, ["Sub One"]],
      ["Chapter Two", 1, []],
    ],
  );
});

test("parse invalidates a malformed outline sidecar (null, never blocks)", async () => {
  const { parser } = makeParser({
    stdout: "/shared/input/report.pdf.md\n",
    markdown: "# Report",
    hash: "abc",
    sidecar: { "/shared/input/report.pdf.md.outline.json": "not json {{{" },
  });
  const result = await parser.parse("/tmp/report.pdf");
  assert.equal(result.outline, null);
});

test("parse writes a sha256 sidecar after a fresh parse", async () => {
  const { parser, written } = makeParser({
    stdout: "/shared/input/report.pdf.md\n",
    markdown: "# Doc",
    hash: "abc123",
  });
  await parser.parse("/tmp/report.pdf");
  assert.equal(written["/shared/input/report.pdf.md.sha256"], "abc123");
});

test("parse SKIPS python when the md exists and the sidecar hash matches the input", async () => {
  const { parser, execCalls, readCalls } = makeParser({
    stdout: "/shared/input/report.pdf.md\n",
    markdown: "# Cached Doc",
    hash: "abc123",
    exists: {
      "/shared/input/report.pdf.md": true,
      "/shared/input/report.pdf.md.sha256": true,
    },
    sidecar: { "/shared/input/report.pdf.md.sha256": "abc123" },
  });
  const result = await parser.parse("/tmp/report.pdf");

  assert.equal(execCalls.length, 0, "docling NOT invoked on cache hit");
  assert.equal(result.markdown, "# Cached Doc");
  assert.equal(result.outputPath, "/shared/input/report.pdf.md");
  assert.equal(result.imagesDir, "/shared/input/images/report.pdf");
  // The cached path + sidecar are read; no python.
  assert.ok(readCalls.some((p) => p === "/shared/input/report.pdf.md"));
});

test("parse re-runs python when the sidecar hash does NOT match (new upload)", async () => {
  const { parser, execCalls } = makeParser({
    stdout: "/shared/input/report.pdf.md\n",
    markdown: "# Fresh Doc",
    hash: "NEWHASH",
    exists: {
      "/shared/input/report.pdf.md": true,
      "/shared/input/report.pdf.md.sha256": true,
    },
    sidecar: { "/shared/input/report.pdf.md.sha256": "OLDHASH" },
  });
  const result = await parser.parse("/tmp/report.pdf");

  assert.equal(execCalls.length, 1, "docling invoked when hash differs");
  assert.equal(result.markdown, "# Fresh Doc");
});

test("parse re-runs python when the sidecar is missing even if md exists", async () => {
  const { parser, execCalls } = makeParser({
    stdout: "/shared/input/report.pdf.md\n",
    markdown: "# Doc",
    hash: "abc123",
    exists: { "/shared/input/report.pdf.md": true }, // no sidecar
  });
  await parser.parse("/tmp/report.pdf");
  assert.equal(execCalls.length, 1, "no sidecar → no cache trust");
});

test("URL inputs never use the cache (hash is null) — always parse", async () => {
  const { parser, execCalls } = makeParser({
    stdout: "/shared/input/example.com-index.md\n",
    markdown: "# Example Domain",
    hash: null,
    exists: {
      "/shared/input/example.com-index.md": true,
      "/shared/input/example.com-index.md.sha256": true,
    },
  });
  const result = await parser.parse("https://example.com/");
  assert.equal(execCalls.length, 1, "URL inputs always re-parse");
  assert.equal(result.stem, "example.com-index");
});

test("parse returns the images dir for URL inputs (host-path stem)", async () => {
  const { parser } = makeParser({
    stdout: "log line one\n/shared/input/example.com-index.md\n",
    markdown: "# Example Domain",
  });
  const result = await parser.parse("https://example.com/");
  assert.equal(result.imagesDir, "/shared/input/images/example.com-index");
});

test("parse rejects when docling produces no output path", async () => {
  const { parser } = makeParser({ stdout: "\n", hash: "abc" });
  await assert.rejects(() => parser.parse("/tmp/x.pdf"), /no output path/);
});

test("parse propagates exec errors", async () => {
  const { parser } = makeParser({ error: new Error("docling crashed"), hash: "abc" });
  await assert.rejects(() => parser.parse("/tmp/x.pdf"), /docling crashed/);
});