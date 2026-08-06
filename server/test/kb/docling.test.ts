import { test } from "node:test";
import assert from "node:assert/strict";
import { DoclingParser } from "../../src/kb/docling.js";

function makeParser(opts: {
  stdout?: string;
  markdown?: string;
  error?: Error;
}) {
  const execCalls: [string, string[]][] = [];
  const readCalls: string[] = [];
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
      return opts.markdown ?? "# Doc";
    },
    mkdirImpl: async () => {},
  });
  return { parser, execCalls, readCalls };
}

test("parse invokes python parse_doc.py with input + shared input-dir and returns markdown", async () => {
  const { parser, execCalls, readCalls } = makeParser({
    stdout: "/shared/input/report.md\n",
    markdown: "# Report\n\nBody",
  });
  const result = await parser.parse("/tmp/report.pdf");

  assert.deepEqual(execCalls, [
    ["/opt/docling/bin/python", ["/opt/parse_doc.py", "/tmp/report.pdf", "/shared/input"]],
  ]);
  assert.deepEqual(readCalls, ["/shared/input/report.md"]);
  assert.equal(result.markdown, "# Report\n\nBody");
  assert.equal(result.outputPath, "/shared/input/report.md");
  assert.equal(result.stem, "report");
});

test("parse uses the last stdout line as output path (URL produces host-path stem)", async () => {
  const { parser } = makeParser({
    stdout: "log line one\n/shared/input/example.com-index.md\n",
    markdown: "# Example Domain",
  });
  const result = await parser.parse("https://example.com/");
  assert.equal(result.outputPath, "/shared/input/example.com-index.md");
  assert.equal(result.stem, "example.com-index");
});

test("parse rejects when docling produces no output path", async () => {
  const { parser } = makeParser({ stdout: "\n" });
  await assert.rejects(() => parser.parse("/tmp/x.pdf"), /no output path/);
});

test("parse propagates exec errors", async () => {
  const { parser } = makeParser({ error: new Error("docling crashed") });
  await assert.rejects(() => parser.parse("/tmp/x.pdf"), /docling crashed/);
});
