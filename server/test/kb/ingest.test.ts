import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KnowledgeIngestService,
  buildWikiIndex,
  localClassify,
  rebuildWikiIndex,
  withFrontmatter,
} from "../../src/kb/ingest.js";
import type { WikiClassification } from "../../src/kb/llmwiki.js";

function makeFakes(opts: { classify?: (input: { title: string; content: string }) => Promise<WikiClassification> } = {}) {
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
  const rebuildIndex = async (wikiDir: string) => {
    calls.push({ kind: "rebuildIndex", args: [wikiDir] });
  };
  return {
    calls,
    written,
    rebuildIndex,
    lightrag: lightrag as never,
    llmwiki: llmwiki as never,
    fs,
    ...(opts.classify ? { classify: opts.classify } : {}),
  };
}

test("ingestMarkdown feeds LightRAG and writes the wiki page into a category dir + rebuilds index", async () => {
  const fakes = makeFakes();
  const service = new KnowledgeIngestService({
    lightrag: fakes.lightrag,
    llmwiki: fakes.llmwiki,
    wikiDir: "/data/wiki",
    projectId: "athena-wiki",
    rebuildIndex: fakes.rebuildIndex,
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
  assert.ok(write?.args[0]);
  assert.equal(write.args[0], "/data/wiki/concepts/runbook.md");
  const content = write.args[1] as string;
  assert.match(content, /^---\ntype: concept\ntitle: Incident Runbook\n/);
  assert.ok(content.endsWith("\n\n# Incident Runbook\n\nStep 1"));

  const rebuild = fakes.calls.find((c) => c.kind === "rebuildIndex");
  assert.equal(rebuild?.args[0], "/data/wiki");

  const rescan = fakes.calls.find((c) => c.kind === "llmwiki.rescan");
  assert.deepEqual(rescan?.args, ["athena-wiki"]);
});

test("ingest uses the llm_wiki agent classification when available", async () => {
  const classify: (input: { title: string; content: string }) => Promise<WikiClassification> = async () => ({
    category: "entity",
    pagePath: "wiki/entities/acme-corp.md",
  });
  const fakes = makeFakes({ classify });
  const service = new KnowledgeIngestService({
    lightrag: fakes.lightrag,
    llmwiki: fakes.llmwiki,
    wikiDir: "/data/wiki",
    projectId: "athena-wiki",
    classify,
    rebuildIndex: fakes.rebuildIndex,
    ...fakes.fs,
  });

  await service.ingestMarkdown({ title: "Acme Corp", content: "# Acme Corp\n\nRobot maker." });
  const write = fakes.calls.find((c) => c.kind === "fs.writeFile");
  assert.equal(write?.args[0], "/data/wiki/entities/acme-corp.md");
  assert.match(write?.args[1] as string, /^---\ntype: entity\n/);
});

test("ingestMarkdown resolves wiki dir from project path when not configured", async () => {
  const fakes = makeFakes();
  const service = new KnowledgeIngestService({
    lightrag: fakes.lightrag,
    llmwiki: fakes.llmwiki,
    rebuildIndex: fakes.rebuildIndex,
    ...fakes.fs,
  });
  const result = await service.ingestMarkdown({ title: "Resolved Doc", content: "hi" });
  assert.equal(result.systems.llmwiki.ok, true);
  const write = fakes.calls.find((c) => c.kind === "fs.writeFile");
  assert.equal(write?.args[0], "/data/wiki/wiki/concepts/resolved-doc.md");
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
    rebuildIndex: fakes.rebuildIndex,
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
    rebuildIndex: fakes.rebuildIndex,
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
    rebuildIndex: fakes.rebuildIndex,
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
    rebuildIndex: async () => {},
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
    rebuildIndex: fakes.rebuildIndex,
    ...fakes.fs,
  });
  const result = await service.ingestMarkdown({ title: "Doc", content: "x" });
  assert.equal(result.systems.lightrag.trackId, "insert_123");
});

test("withFrontmatter emits the llm_wiki schema frontmatter", () => {
  const out = withFrontmatter("concept", "Chain of Thought", "# Chain of Thought\n\nbody");
  assert.match(out, /^---\ntype: concept\ntitle: Chain of Thought\ncreated: \d{4}-\d{2}-\d{2}\nupdated: \d{4}-\d{2}-\d{2}\n---\n\n# Chain of Thought\n\nbody$/);
});

test("localClassify maps keyword-heavy docs to the right category", () => {
  assert.equal(localClassify("Alpha vs Beta", "comparing both approaches").category, "comparison");
  assert.equal(localClassify("Open question", "is there a better way?").category, "query");
  assert.equal(localClassify("Paper review", "this paper from arxiv").category, "source");
  assert.equal(localClassify("Summary", "overview of findings").category, "synthesis");
  assert.equal(localClassify("Acme Corp", "the company dataset").category, "entity");
  assert.equal(localClassify("Unclear", "some text").category, "concept");
});

test("buildWikiIndex groups pages by frontmatter type", () => {
  const index = buildWikiIndex([
    { type: "entity", title: "Acme", target: "entities/acme" },
    { type: "concept", title: "Chain of Thought", target: "concepts/chain-of-thought" },
    { type: "entity", title: "Beta", target: "entities/beta" },
  ]);
  assert.ok(index.includes("# Wiki Index"));
  assert.ok(index.includes("## concept"));
  assert.ok(index.includes("## entity"));
  const entitySection = index.split("## entity")[1].split("## ")[0];
  assert.ok(entitySection.includes("- [[entities/acme|Acme]]\n"));
  assert.ok(entitySection.includes("- [[entities/beta|Beta]]\n"));
});

test("rebuildWikiIndex scans the wiki dir and writes index.md", async () => {
  const files = new Map<string, string>();
  files.set("/data/wiki/concepts/chain-of-thought.md", "---\ntype: concept\ntitle: CoT\n---\n\nbody");
  files.set("/data/wiki/entities/acme.md", "---\ntype: entity\ntitle: Acme\n---\n\nbody");
  files.set("/data/wiki/index.md", "# stale");
  const written: string[] = [];
  await rebuildWikiIndex("/data/wiki", {
    readDir: async (path) => {
      if (path === "/data/wiki") {
        return [
          { name: "concepts", isDir: true },
          { name: "entities", isDir: true },
          { name: "index.md", isDir: false },
        ];
      }
      if (path === "/data/wiki/concepts") return [{ name: "chain-of-thought.md", isDir: false }];
      if (path === "/data/wiki/entities") return [{ name: "acme.md", isDir: false }];
      return [];
    },
    readFile: async (path) => files.get(path) ?? "",
    writeFile: async (path, content) => {
      written.push(path);
      files.set(path, content);
    },
  });
  assert.equal(written[0], "/data/wiki/index.md");
  assert.ok((files.get("/data/wiki/index.md") ?? "").includes("- [[concepts/chain-of-thought|CoT]]"));
  assert.ok((files.get("/data/wiki/index.md") ?? "").includes("- [[entities/acme|Acme]]"));
});
