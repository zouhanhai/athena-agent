import { test } from "node:test";
import assert from "node:assert/strict";
import { KnowledgeIngestService } from "../../src/kb/ingest.js";

function makeFakes() {
  const calls: { kind: string; args: unknown[] }[] = [];
  const lightrag = {
    async ingestText(text: string, opts?: { fileSource?: string }) {
      calls.push({ kind: "lightrag.ingestText", args: [text, opts] });
      return { status: "success", message: "ok", track_id: "insert_123" };
    },
  };
  const llmwiki = {
    async rescan(projectId: string) {
      calls.push({ kind: "llmwiki.rescan", args: [projectId] });
      return { ok: true, tasks: [] };
    },
    async listProjects() {
      return {
        currentProject: null,
        projects: [{ id: "athena-wiki", name: "athena-wiki", path: "/data/wiki", current: false }],
      };
    },
  };
  const written: string[] = [];
  const fs = {
    async writeFile(path: string, content: string) {
      written.push(path);
      calls.push({ kind: "fs.writeFile", args: [path, content] });
    },
    async mkdir() {
      calls.push({ kind: "fs.mkdir", args: [] });
    },
  };
  return {
    calls,
    written,
    lightrag: lightrag as never,
    llmwiki: llmwiki as never,
    fs,
  };
}

test("ingestMarkdown feeds LightRAG and writes wiki file + rescans llm_wiki", async () => {
  const fakes = makeFakes();
  const service = new KnowledgeIngestService({
    lightrag: fakes.lightrag,
    llmwiki: fakes.llmwiki,
    wikiDir: "/data/wiki",
    projectId: "athena-wiki",
    ...fakes.fs,
  });

  const result = await service.ingestMarkdown({
    title: "Incident Runbook",
    content: "# Incident Runbook\n\nStep 1",
    source: "runbook.md",
  });

  assert.equal(result.documentId, "runbook");
  assert.equal(result.systems.lightrag.ok, true);
  assert.equal(result.systems.llmwiki.ok, true);

  const ingest = fakes.calls.find((c) => c.kind === "lightrag.ingestText");
  assert.deepEqual(ingest?.args, ["# Incident Runbook\n\nStep 1", { fileSource: "runbook.md" }]);

  const write = fakes.calls.find((c) => c.kind === "fs.writeFile");
  assert.equal(write?.args[0], "/data/wiki/runbook.md");
  assert.equal(write?.args[1], "# Incident Runbook\n\nStep 1");

  const rescan = fakes.calls.find((c) => c.kind === "llmwiki.rescan");
  assert.deepEqual(rescan?.args, ["athena-wiki"]);
});

test("ingestMarkdown resolves wiki dir from project path when not configured", async () => {
  const fakes = makeFakes();
  const service = new KnowledgeIngestService({
    lightrag: fakes.lightrag,
    llmwiki: fakes.llmwiki,
    ...fakes.fs,
  });
  const result = await service.ingestMarkdown({ title: "Resolved Doc", content: "hi" });
  assert.equal(result.systems.llmwiki.ok, true);
  const write = fakes.calls.find((c) => c.kind === "fs.writeFile");
  assert.equal(write?.args[0], "/data/wiki/wiki/resolved-doc.md");
  const rescan = fakes.calls.find((c) => c.kind === "llmwiki.rescan");
  assert.deepEqual(rescan?.args, ["athena-wiki"]);
});

test("ingestMarkdown sanitizes title into a safe filename when no source", async () => {
  const fakes = makeFakes();
  const service = new KnowledgeIngestService({
    lightrag: fakes.lightrag,
    llmwiki: fakes.llmwiki,
    wikiDir: "/data/wiki",
    projectId: "athena-wiki",
    ...fakes.fs,
  });
  const result = await service.ingestMarkdown({
    title: "My Wiki Page: Part 2!",
    content: "hello",
  });
  assert.match(result.documentId, /^my-wiki-page-part-2$/);
  assert.match(fakes.written[0], /\/my-wiki-page-part-2\.md$/);
  const ingest = fakes.calls.find((c) => c.kind === "lightrag.ingestText");
  assert.equal(ingest?.args[1].fileSource, "my-wiki-page-part-2.md");
});

test("ingestMarkdown reports partial status when LightRAG fails", async () => {
  const fakes = makeFakes();
  const lightrag = {
    async ingestText() {
      throw new Error("LightRAG down");
    },
  };
  const service = new KnowledgeIngestService({
    lightrag: lightrag as never,
    llmwiki: fakes.llmwiki,
    wikiDir: "/data/wiki",
    ...fakes.fs,
  });
  const result = await service.ingestMarkdown({ title: "Doc", content: "x" });
  assert.equal(result.systems.lightrag.ok, false);
  assert.match(result.systems.lightrag.error ?? "", /LightRAG down/);
  assert.equal(result.systems.llmwiki.ok, true);
});

test("ingestMarkdown reports partial status when llm_wiki fails", async () => {
  const fakes = makeFakes();
  const llmwiki = {
    async rescan() {
      throw new Error("rescan failed");
    },
    async listProjects() {
      return {
        currentProject: null,
        projects: [{ id: "athena-wiki", name: "athena-wiki", path: "/data/wiki", current: false }],
      };
    },
  };
  const service = new KnowledgeIngestService({
    lightrag: fakes.lightrag,
    llmwiki: llmwiki as never,
    projectId: "athena-wiki",
    ...fakes.fs,
  });
  const result = await service.ingestMarkdown({ title: "Doc", content: "x" });
  assert.equal(result.systems.lightrag.ok, true);
  assert.equal(result.systems.llmwiki.ok, false);
  assert.match(result.systems.llmwiki.error ?? "", /rescan failed/);
});

test("ingestMarkdown propagates total failure when both systems fail", async () => {
  const lightrag = {
    async ingestText() {
      throw new Error("lr down");
    },
  };
  const llmwiki = {
    async rescan() {
      throw new Error("wiki down");
    },
    async listProjects() {
      return {
        currentProject: null,
        projects: [{ id: "athena-wiki", name: "athena-wiki", path: "/data/wiki", current: false }],
      };
    },
  };
  const service = new KnowledgeIngestService({
    lightrag: lightrag as never,
    llmwiki: llmwiki as never,
    wikiDir: "/data/wiki",
    projectId: "athena-wiki",
    writeFile: async () => {},
    mkdir: async () => {},
  });
  const result = await service.ingestMarkdown({ title: "Doc", content: "x" });
  assert.equal(result.systems.lightrag.ok, false);
  assert.equal(result.systems.llmwiki.ok, false);
});

test("ingestMarkdown records track_id from LightRAG", async () => {
  const fakes = makeFakes();
  const service = new KnowledgeIngestService({
    lightrag: fakes.lightrag,
    llmwiki: fakes.llmwiki,
    wikiDir: "/data/wiki",
    ...fakes.fs,
  });
  const result = await service.ingestMarkdown({ title: "Doc", content: "x" });
  assert.equal(result.systems.lightrag.trackId, "insert_123");
});
