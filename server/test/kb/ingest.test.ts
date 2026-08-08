import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KnowledgeIngestService,
  buildWikiIndex,
  distinctiveProbe,
  localClassify,
  localTopic,
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

test("ingestMarkdown feeds LightRAG frontmatter-wrapped content and writes the wiki page into a type dir + rebuilds index", async () => {
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

  // G3.S8.T2: LightRAG receives content WITH frontmatter (type + title), not raw content.
  const ingest = fakes.calls.find((c) => c.kind === "lightrag.ingestText");
  assert.equal(ingest?.args[1]?.fileSource, "runbook.md");
  const lightragContent = ingest?.args[0] as string;
  assert.match(lightragContent, /^---\ntype: manual\ntitle: Incident Runbook\n/);
  assert.ok(lightragContent.endsWith("\n\n# Incident Runbook\n\nStep 1"));

  const write = fakes.calls.find((c) => c.kind === "fs.writeFile");
  assert.ok(write?.args[0]);
  assert.equal(write.args[0], "/data/wiki/manuals/runbook.md");
  const content = write.args[1] as string;
  assert.match(content, /^---\ntype: manual\ntitle: Incident Runbook\n/);
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

test("ingest passes existing wiki topics to the agent classifier so it reuses them", async () => {
  const calls: { existingTopics?: string[] }[] = [];
  const llmwiki = {
    async rescan(projectId: string) {
      return { ok: true, tasks: [] };
    },
    async listProjects() {
      return {
        currentProject: null,
        projects: [{ id: "athena-wiki", name: "athena-wiki", path: "/data/wiki", current: false }],
      };
    },
    async listWikiPages() {
      return [
        { path: "wiki/sommerseminar/s1.md", type: "concept", topic: "sommerseminar" },
        { path: "wiki/sap/fiori/f1.md", type: "concept", topic: "sap/fiori" },
        { path: "wiki/concepts/example.md", type: "concept" },
      ];
    },
    async classify(_id: string, _input: unknown, existingTopics: string[]) {
      calls.push({ existingTopics });
      return { category: "concept", pagePath: "wiki/concepts/foo.md", topic: "sommerseminar" };
    },
  };
  const fakes = makeFakes();
  const service = new KnowledgeIngestService({
    lightrag: fakes.lightrag,
    llmwiki: llmwiki as never,
    wikiDir: "/data/wiki",
    projectId: "athena-wiki",
    rebuildIndex: fakes.rebuildIndex,
    ...fakes.fs,
  });

  await service.ingestMarkdown({ title: "Sommerseminar 4", content: "# Sommerseminar 4\n\nagenda" });
  assert.deepEqual(calls[0]?.existingTopics, ["sap/fiori", "sommerseminar"]);
  const write = fakes.calls.find((c) => c.kind === "fs.writeFile");
  assert.equal(write?.args[0], "/data/wiki/sommerseminar/sommerseminar-4.md");
});

test("deleteDocument removes the page from LightRAG and llm_wiki and rebuilds the index", async () => {
  const calls: { kind: string; args: unknown[] }[] = [];
  const lightrag = {
    async listDocuments() {
      calls.push({ kind: "lightrag.listDocuments", args: [] });
      return [
        { id: "doc-1", file_path: "foo.md" },
        { id: "doc-2", file_path: "bar.md" },
      ];
    },
    async deleteDocument(docId: string) {
      calls.push({ kind: "lightrag.deleteDocument", args: [docId] });
      return { status: "deletion_started" };
    },
  };
  const llmwiki = {
    async listProjects() {
      return {
        currentProject: null,
        projects: [{ id: "athena-wiki", name: "athena-wiki", path: "/data/wiki", current: false }],
      };
    },
    async deleteFile(projectId: string, path: string) {
      calls.push({ kind: "llmwiki.deleteFile", args: [projectId, path] });
    },
  };
  const rebuildIndex = async (wikiDir: string) => {
    calls.push({ kind: "rebuildIndex", args: [wikiDir] });
  };
  const service = new KnowledgeIngestService({
    lightrag: lightrag as never,
    llmwiki: llmwiki as never,
    wikiDir: "/data/wiki",
    projectId: "athena-wiki",
    rebuildIndex,
  });

  const result = await service.deleteDocument("wiki/concepts/foo.md");
  assert.equal(result.ok, true);
  assert.deepEqual(result.lightrag?.deleted, ["doc-1"]);
  assert.ok(
    calls.some((c) => c.kind === "lightrag.deleteDocument" && c.args[0] === "doc-1"),
    "only the doc whose file_path matches is deleted",
  );
  assert.ok(calls.some((c) => c.kind === "llmwiki.deleteFile" && c.args[1] === "wiki/concepts/foo.md"));
  assert.ok(calls.some((c) => c.kind === "rebuildIndex" && c.args[0] === "/data/wiki"));
});

test("deleteDocument reports ok when llm_wiki succeeds but LightRAG fails", async () => {
  const lightrag = {
    async listDocuments() {
      throw new Error("lightrag down");
    },
  };
  const llmwiki = {
    async listProjects() {
      return {
        currentProject: null,
        projects: [{ id: "athena-wiki", name: "athena-wiki", path: "/data/wiki", current: false }],
      };
    },
    async deleteFile() {},
  };
  const service = new KnowledgeIngestService({
    lightrag: lightrag as never,
    llmwiki: llmwiki as never,
    projectId: "athena-wiki",
    rebuildIndex: async () => {},
  });

  const result = await service.deleteDocument("wiki/concepts/foo.md");
  assert.equal(result.ok, true);
  assert.match(result.lightrag?.error ?? "", /lightrag down/);
});

test("deleteDocument reports failure when the wiki file cannot be deleted", async () => {
  const llmwiki = {
    async listProjects() {
      return {
        currentProject: null,
        projects: [{ id: "athena-wiki", name: "athena-wiki", path: "/data/wiki", current: false }],
      };
    },
    async deleteFile() {
      throw new Error("cannot delete");
    },
  };
  const service = new KnowledgeIngestService({
    lightrag: { listDocuments: async () => [], deleteDocument: async () => ({}) } as never,
    llmwiki: llmwiki as never,
    projectId: "athena-wiki",
    rebuildIndex: async () => {},
  });

  const result = await service.deleteDocument("wiki/concepts/foo.md");
  assert.equal(result.ok, false);
  assert.match(result.llmwiki?.error ?? "", /cannot delete/);
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

test("withFrontmatter includes the topic field when provided", () => {
  const out = withFrontmatter("concept", "Sommerseminar", "# S\n\nbody", "sommerseminar");
  assert.match(out, /^---\ntype: concept\ntitle: Sommerseminar\ntopic: sommerseminar\ncreated: \d{4}-\d{2}-\d{2}\n/);
});

test("localTopic groups related Sommerseminar documents under internal/events", () => {
  assert.equal(localTopic("Sommerseminar Lüsen/Südtirol 2026", "C-Day für die CALEOs"), "internal/events");
  assert.equal(localTopic("Infos Sommerseminar 2026", "Sommerseminar vom 12. - 14. Juni 2026"), "internal/events");
  assert.equal(localTopic("Sommerseminar Mallorca 2023", "CALEO Sommerseminar vom 15.06.2023"), "internal/events");
  assert.equal(localTopic("Chain of Thought", "some reasoning text"), undefined);
});

test("localTopic maps SAP subjects to the hierarchical topic tree", () => {
  assert.equal(localTopic("Group Reporting", "SAP Group Reporting for consolidation"), "sap/consolidation/group-reporting");
  assert.equal(localTopic("SAP BCS Guide", "business consolidation system"), "sap/consolidation/bcs");
  assert.equal(localTopic("BW/4", "business warehouse migration"), "sap/business-warehouse/bw");
  assert.equal(localTopic("SAC", "reporting with SAC"), "sap/reporting/sac");
  assert.equal(localTopic("Fiori", "UI5 development"), "sap/development/fiori");
  assert.equal(localTopic("S/4HANA", "migration"), "sap/migration/s4hana");
});

test("localClassify derives a topic for Sommerseminar docs while classifying them as events", () => {
  const result = localClassify("Sommerseminar Lüsen/Südtirol 2026", "C-Day für die CALEOs");
  assert.equal(result.category, "event");
  assert.equal(result.topic, "internal/events");
  assert.match(result.pagePath, /^wiki\/events\/sommerseminar-/);
});

test("ingest writes under wiki/<topic>/ when the classifier returns a topic", async () => {
  const classify: (input: { title: string; content: string }) => Promise<WikiClassification> = async () => ({
    category: "concept",
    pagePath: "wiki/concepts/sommerseminar-lusen-sudtirol-2026.md",
    topic: "sommerseminar",
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

  await service.ingestMarkdown({ title: "Sommerseminar", content: "# Sommerseminar\n\nC-Day" });
  const write = fakes.calls.find((c) => c.kind === "fs.writeFile");
  assert.equal(write?.args[0], "/data/wiki/sommerseminar/sommerseminar.md");
  assert.match(write?.args[1] as string, /^---\ntype: concept\ntitle: Sommerseminar\ntopic: sommerseminar\n/);
});

test("localClassify maps docs to the 13-kind CALEO taxonomy", () => {
  assert.equal(localClassify("Incident Runbook", "step-by-step troubleshooting guide").category, "manual");
  assert.equal(localClassify("Annual Report", "financial results and revenue").category, "report");
  assert.equal(localClassify("Sprint Retro", "attendees, action items, decisions").category, "minute");
  assert.equal(localClassify("Paper review", "this paper from arxiv").category, "source");
  assert.equal(localClassify("SAP Fiori Configuration", "interface specification and requirements").category, "spec");
  assert.equal(localClassify("Migration Offer", "implementation plan and roadmap").category, "proposal");
  assert.equal(localClassify("NDA", "terms and conditions agreement").category, "contract");
  assert.equal(localClassify("Compliance", "code of conduct policy").category, "policy");
  assert.equal(localClassify("Quarterly Deck", "slides for the steering committee").category, "presentation");
  assert.equal(localClassify("Acme Corp", "the company dataset").category, "entity");
  assert.equal(localClassify("Unclear", "some text").category, "concept");
});

test("localClassify maps the external SAP Group Reporting doc to source + sap/consolidation/group-reporting (not comparison)", () => {
  const result = localClassify(
    "SAP Group Reporting",
    "SAP Group Reporting — official vendor documentation for financial consolidation (help.sap.com).",
  );
  assert.equal(result.category, "source");
  assert.equal(result.topic, "sap/consolidation/group-reporting");
  assert.match(result.pagePath, /^wiki\/sources\//);
});

test("ingestMarkdown classifies FIRST and feeds LightRAG the topic via frontmatter (G3.S8.T2)", async () => {
  let classifyCalls = 0;
  const classify: (input: { title: string; content: string }) => Promise<WikiClassification> = async () => {
    classifyCalls += 1;
    return {
      category: "event",
      pagePath: "wiki/events/sommerseminar-2026.md",
      topic: "internal/events",
    };
  };
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

  await service.ingestMarkdown({ title: "Sommerseminar 2026", content: "# Sommerseminar 2026\n\nC-Day" });

  const ingest = fakes.calls.find((c) => c.kind === "lightrag.ingestText");
  const lightragContent = ingest?.args[0] as string;
  assert.match(lightragContent, /^---\ntype: event\ntitle: Sommerseminar 2026\ntopic: internal\/events\n/);

  // the same classification is reused for the wiki page (no double classify call)
  assert.equal(classifyCalls, 1);
  const write = fakes.calls.find((c) => c.kind === "fs.writeFile");
  assert.equal(write?.args[0], "/data/wiki/internal/events/sommerseminar-2026.md");
  assert.match(write?.args[1] as string, /^---\ntype: event\ntitle: Sommerseminar 2026\ntopic: internal\/events\n/);
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

test("distinctiveProbe prefers the first paragraph and caps length", () => {
  const probe = distinctiveProbe("---\ntype: concept\n---\n\n# Title\n\nThis is the first paragraph that matters.\n\nSecond paragraph.");
  assert.equal(probe, "This is the first paragraph that matters.");
  const long = "w".repeat(600);
  assert.equal(distinctiveProbe(`# T\n\n${long}`)!.length, 400);
  assert.equal(distinctiveProbe("   \n\n  "), undefined);
});

test("findNearDuplicate returns a different file referenced by LightRAG", async () => {
  const lightrag = {
    async query(_q: string, _o?: unknown) {
      return {
        response: "something similar",
        references: [
          { reference_id: "r1", file_path: "sommerseminar-l-sen.pdf.md" },
        ],
      };
    },
  };
  const service = new KnowledgeIngestService({
    lightrag: lightrag as never,
    llmwiki: {} as never,
  });
  const near = await service.findNearDuplicate("# Title\n\nProbe body text.", "fresh.md");
  assert.equal(near, "sommerseminar-l-sen.pdf.md");
});

test("findNearDuplicate ignores the self file and returns undefined for no other hits", async () => {
  const lightrag = {
    async query() {
      return {
        response: "ok",
        references: [
          { reference_id: "r1", file_path: "self.md" },
        ],
      };
    },
  };
  const service = new KnowledgeIngestService({
    lightrag: lightrag as never,
    llmwiki: {} as never,
  });
  const near = await service.findNearDuplicate("# Title\n\nBody.", "self.md");
  assert.equal(near, undefined);
});

test("findNearDuplicate swallows LightRAG errors", async () => {
  const lightrag = {
    async query() {
      throw new Error("lightrag down");
    },
  };
  const service = new KnowledgeIngestService({
    lightrag: lightrag as never,
    llmwiki: {} as never,
  });
  const near = await service.findNearDuplicate("# Title\n\nBody.", "self.md");
  assert.equal(near, undefined);
});
