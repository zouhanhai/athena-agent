import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KnowledgeIngestService,
  buildWikiIndex,
  classificationFromRefinement,
  localClassify,
  localTopic,
  rebuildWikiIndex,
  stripFrontmatterBody,
  withFrontmatter,
} from "../../src/kb/ingest.js";
import type { WikiClassification } from "../../src/kb/llmwiki.js";

function makeFakes(opts: { classify?: (input: { title: string; content: string }) => Promise<WikiClassification>; files?: Iterable<[string, string]> } = {}) {
  const calls: { kind: string; args: unknown[] }[] = [];
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
  const files = new Map<string, string>(opts.files ?? []);
  const fs = {
    async writeFile(path: string, content: string) {
      written.push(path);
      files.set(path, content);
      calls.push({ kind: "fs.writeFile", args: [path, content] });
    },
    async readFile(path: string) {
      calls.push({ kind: "fs.readFile", args: [path] });
      const value = files.get(path);
      if (value === undefined) {
        const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return value;
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
    files,
    rebuildIndex,
    llmwiki: llmwiki as never,
    fs,
    ...(opts.classify ? { classify: opts.classify } : {}),
  };
}

test("ingestMarkdown writes the wiki page into a type dir + rebuilds index", async () => {
  const fakes = makeFakes();
  const service = new KnowledgeIngestService({
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
  assert.equal(result.systems.llmwiki.ok, true);

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

test("deleteDocument removes the page from llm_wiki and rebuilds the index", async () => {
  const calls: { kind: string; args: unknown[] }[] = [];
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
    llmwiki: llmwiki as never,
    wikiDir: "/data/wiki",
    projectId: "athena-wiki",
    rebuildIndex,
  });

  const result = await service.deleteDocument("wiki/concepts/foo.md");
  assert.equal(result.ok, true);
  assert.ok(calls.some((c) => c.kind === "llmwiki.deleteFile" && c.args[1] === "wiki/concepts/foo.md"));
  assert.ok(calls.some((c) => c.kind === "rebuildIndex" && c.args[0] === "/data/wiki"));
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
    llmwiki: llmwiki as never,
    projectId: "athena-wiki",
    rebuildIndex: async () => {},
  });

  const result = await service.deleteDocument("wiki/concepts/foo.md");
  assert.equal(result.ok, false);
  assert.match(result.llmwiki?.error ?? "", /cannot delete/);
});

// --- G4.S8.T14: wiki page delete → full knowledge-graph cascade ---

/**
 * Fixture (acceptance criteria): doc A mentions E1 + the shared E2; doc B
 * mentions the shared E2 + its own E3. Deleting A must remove A's subtree +
 * orphaned E1 while RETAINING E2 (still mentioned by B) and all of B.
 */
function makeSharedEntityGraph() {
  const deletedNodes: string[] = [];
  const graph = {
    async deleteDocumentsForWikiPage(input: { wikiPath: string; stem: string }) {
      if (input.stem !== "doc-a") {
        return { documentsRemoved: 0, chunksRemoved: 0, sectionsRemoved: 0, entitiesRemoved: 0, entitiesRetained: 0, mdRefs: [] };
      }
      // Doc A's subtree dies; E1 is orphaned; E2 survives (B still mentions it).
      deletedNodes.push("Document:doc-a", "Chunk:doc-a:c1", "Section:doc-a:s1", "Entity:E1");
      return {
        documentsRemoved: 1,
        chunksRemoved: 1,
        sectionsRemoved: 1,
        entitiesRemoved: 1,
        entitiesRetained: 2,
        mdRefs: [join("/refinement", "doc-a", "markdown.md")],
      };
    },
  };
  return { graph, deletedNodes };
}

test("deleteDocument cascades to the graph: subtree removed, orphan entity dropped, shared entity retained", async () => {
  const llmwiki = {
    async listProjects() {
      return {
        currentProject: null,
        projects: [{ id: "athena-wiki", name: "athena-wiki", path: "/data/wiki", current: false }],
      };
    },
    async deleteFile() {},
  };
  const { graph, deletedNodes } = makeSharedEntityGraph();
  const service = new KnowledgeIngestService({
    llmwiki: llmwiki as never,
    projectId: "athena-wiki",
    rebuildIndex: async () => {},
    graph,
  });

  const result = await service.deleteDocument("wiki/concepts/doc-a.md");

  assert.equal(result.ok, true, "llmwiki deletion still defines ok");
  assert.ok(deletedNodes.includes("Entity:E1"), "the A-only entity is orphan-deleted");
  assert.equal(result.graph?.documentsRemoved, 1);
  assert.equal(result.graph?.chunksRemoved, 1);
  assert.equal(result.graph?.sectionsRemoved, 1);
  assert.equal(result.graph?.entitiesRemoved, 1, "E1 removed");
  assert.equal(result.graph?.entitiesRetained, 2, "E2 (shared with B) + E3 retained");
  assert.ok(!result.graph?.error);
});

test("deleteDocument removes the Document.md_ref refinement directory inside the output root", async () => {
  const root = join(tmpdir(), `athena-t14-${Date.now()}`);
  const dirA = join(root, "doc-a");
  const dirB = join(root, "doc-b");
  await mkdir(dirA, { recursive: true });
  await mkdir(dirB, { recursive: true });
  await writeFile(join(dirA, "markdown.md"), "A");
  await writeFile(join(dirB, "markdown.md"), "B");
  try {
    const llmwiki = {
      async listProjects() {
        return {
          currentProject: null,
          projects: [{ id: "athena-wiki", name: "athena-wiki", path: "/data/wiki", current: false }],
        };
      },
      async deleteFile() {},
    };
    const graph = {
      async deleteDocumentsForWikiPage(input: { wikiPath: string; stem: string }) {
        return input.stem === "doc-a"
          ? { documentsRemoved: 1, chunksRemoved: 0, sectionsRemoved: 0, entitiesRemoved: 0, entitiesRetained: 3, mdRefs: [join(dirA, "markdown.md")] }
          : { documentsRemoved: 0, chunksRemoved: 0, sectionsRemoved: 0, entitiesRemoved: 0, entitiesRetained: 3, mdRefs: [] };
      },
    };
    const service = new KnowledgeIngestService({
      llmwiki: llmwiki as never,
      projectId: "athena-wiki",
      rebuildIndex: async () => {},
      graph,
      refinementOutputDir: root,
    });

    const result = await service.deleteDocument("wiki/concepts/doc-a.md");

    assert.deepEqual(result.graph?.refinementDirsRemoved, [dirA], "A's refinement dir removed");
    assert.equal(existsSync(dirA), false, "doc A's refinement dir is gone");
    assert.equal(existsSync(dirB), true, "doc B's refinement dir remains");
    assert.equal(existsSync(join(dirB, "markdown.md")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deleteDocument refuses to remove refinement dirs outside the configured output root", async () => {
  const removed: string[] = [];
  const llmwiki = {
    async listProjects() {
      return {
        currentProject: null,
        projects: [{ id: "athena-wiki", name: "athena-wiki", path: "/data/wiki", current: false }],
      };
    },
    async deleteFile() {},
  };
  const graph = {
    async deleteDocumentsForWikiPage() {
      // a poisoned md_ref trying to escape the root via traversal
      return {
        documentsRemoved: 1,
        chunksRemoved: 0,
        sectionsRemoved: 0,
        entitiesRemoved: 0,
        entitiesRetained: 0,
        mdRefs: ["/refinement/../../etc/markdown.md"],
      };
    },
  };
  const service = new KnowledgeIngestService({
    llmwiki: llmwiki as never,
    projectId: "athena-wiki",
    rebuildIndex: async () => {},
    graph,
    refinementOutputDir: "/refinement",
    rmDir: async (path) => {
      removed.push(path);
    },
  });

  const result = await service.deleteDocument("wiki/concepts/doc-a.md");

  assert.deepEqual(removed, [], "no directory outside the root is removed");
  assert.deepEqual(result.graph?.refinementDirsRemoved, []);
});

test("deleteDocument reports graph errors in graph.error without blocking the llmwiki deletion", async () => {
  const calls: string[] = [];
  const llmwiki = {
    async listProjects() {
      return {
        currentProject: null,
        projects: [{ id: "athena-wiki", name: "athena-wiki", path: "/data/wiki", current: false }],
      };
    },
    async deleteFile(_projectId: string, path: string) {
      calls.push(`deleteFile:${path}`);
    },
  };
  const graph = {
    async deleteDocumentsForWikiPage() {
      throw new Error("neo4j down");
    },
  };
  const service = new KnowledgeIngestService({
    llmwiki: llmwiki as never,
    projectId: "athena-wiki",
    rebuildIndex: async () => {},
    graph,
  });

  const result = await service.deleteDocument("wiki/concepts/foo.md");

  assert.deepEqual(calls, ["deleteFile:wiki/concepts/foo.md"], "llmwiki deletion completed first");
  assert.equal(result.ok, true, "ok reflects the llmwiki deletion, not the graph step");
  assert.match(result.graph?.error ?? "", /neo4j down/);
});

test("deleteDocument on a page with no graph record deletes cleanly (no-op graph step)", async () => {
  let cascadeCalls = 0;
  const llmwiki = {
    async listProjects() {
      return {
        currentProject: null,
        projects: [{ id: "athena-wiki", name: "athena-wiki", path: "/data/wiki", current: false }],
      };
    },
    async deleteFile() {},
  };
  const graph = {
    async deleteDocumentsForWikiPage() {
      cascadeCalls += 1;
      return { documentsRemoved: 0, chunksRemoved: 0, sectionsRemoved: 0, entitiesRemoved: 0, entitiesRetained: 0, mdRefs: [] };
    },
  };
  const service = new KnowledgeIngestService({
    llmwiki: llmwiki as never,
    projectId: "athena-wiki",
    rebuildIndex: async () => {},
    graph,
  });

  const result = await service.deleteDocument("wiki/concepts/plain.md");

  assert.equal(result.ok, true);
  assert.equal(cascadeCalls, 1, "cascade consulted once");
  assert.equal(result.graph?.documentsRemoved, 0, "clean no-op");
  assert.deepEqual(result.graph?.refinementDirsRemoved, []);
});

test("deleteDocument without a graph service keeps today's contract (no graph field)", async () => {
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
    llmwiki: llmwiki as never,
    projectId: "athena-wiki",
    rebuildIndex: async () => {},
  });

  const result = await service.deleteDocument("wiki/concepts/foo.md");

  assert.equal(result.ok, true);
  assert.equal(result.graph, undefined, "graph step absent when no store is wired");
});

test("ingestMarkdown resolves wiki dir from project path when not configured", async () => {
  const fakes = makeFakes();
  const service = new KnowledgeIngestService({
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
    llmwiki: llmwiki as never,
    projectId: "athena-wiki",
    rebuildIndex: fakes.rebuildIndex,
    ...fakes.fs,
  });
  const result = await service.ingestMarkdown({ title: "Doc", content: "x" });
  assert.equal(result.systems.llmwiki.ok, false);
  assert.match(result.systems.llmwiki.error ?? "", /rescan failed/);
});

test("withFrontmatter emits the llm_wiki schema frontmatter with lifecycle defaults", () => {
  const out = withFrontmatter("concept", "Chain of Thought", "# Chain of Thought\n\nbody");
  assert.match(out, /^---\ntype: concept\ntitle: Chain of Thought\ncreated: \d{4}-\d{2}-\d{2}\nupdated: \d{4}-\d{2}-\d{2}\nread_count: 0\nconfidence: 1\n---\n\n# Chain of Thought\n\nbody$/);
});

test("withFrontmatter includes the topic field when provided", () => {
  const out = withFrontmatter("concept", "Sommerseminar", "# S\n\nbody", "sommerseminar");
  assert.match(out, /^---\ntype: concept\ntitle: Sommerseminar\ntopic: sommerseminar\ncreated: \d{4}-\d{2}-\d{2}\n/);
});

test("withFrontmatter includes the summary field when provided (single-line)", () => {
  const out = withFrontmatter(
    "concept",
    "Sommerseminar",
    "# S\n\nbody",
    "sommerseminar",
    "CALEO's annual event with\n workshops and talks.",
  );
  assert.match(out, /^---\ntype: concept\ntitle: Sommerseminar\ntopic: sommerseminar\nsummary: CALEO's annual event with workshops and talks\.\ncreated: /);
});

test("withFrontmatter omits the summary field when not provided", () => {
  const out = withFrontmatter("concept", "Chain of Thought", "# Chain of Thought\n\nbody");
  assert.ok(!/^summary:/m.test(out), "no summary line without a summary");
});

test("withFrontmatter emits last_reviewed and topic_history when provided (G4.S3.T1)", () => {
  const out = withFrontmatter(
    "concept",
    "Sommerseminar",
    "# S\n\nbody",
    "internal/events",
    undefined,
    { last_reviewed: "2026-08-11", topic_history: ["sommerseminar", "internal/events"] },
  );
  assert.match(
    out,
    /^---\ntype: concept\ntitle: Sommerseminar\ntopic: internal\/events\ncreated: \d{4}-\d{2}-\d{2}\nupdated: \d{4}-\d{2}-\d{2}\nread_count: 0\nconfidence: 1\nlast_reviewed: 2026-08-11\ntopic_history: \["sommerseminar", "internal\/events"\]\n---\n\n# S\n\nbody$/,
  );
});

test("withFrontmatter honors explicit read_count and confidence lifecycle values", () => {
  const out = withFrontmatter(
    "concept",
    "S",
    "# S\n\nbody",
    undefined,
    undefined,
    { read_count: 7, confidence: 0.8 },
  );
  assert.match(out, /read_count: 7\nconfidence: 0\.8\n---/);
});

test("withFrontmatter omits last_reviewed and topic_history when not provided", () => {
  const out = withFrontmatter("concept", "Chain of Thought", "# Chain of Thought\n\nbody");
  assert.ok(!/^last_reviewed:/m.test(out), "no last_reviewed line before a first review");
  assert.ok(!/^topic_history:/m.test(out), "no topic_history line before any re-topic");
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

test("classificationFromRefinement folds the Athena type/topic into llm_wiki classification (G4.S1.T4)", () => {
  const result = classificationFromRefinement(
    { type: "event", topic: "internal/events" },
    "Sommerseminar 2026",
    "# Sommerseminar\n\nC-Day",
  );
  assert.equal(result.category, "event", "Athena type maps to a valid wiki category");
  assert.equal(result.topic, "internal/events", "Athena topic is validated + reused");
  assert.match(result.pagePath, /^wiki\/events\/sommerseminar-/);
});

test("classificationFromRefinement falls back to the local heuristic on invalid type/topic", () => {
  const result = classificationFromRefinement(
    { type: "not-a-category", topic: "Not A Topic!!" },
    "Sommerseminar 2026",
    "# Sommerseminar\n\nC-Day für die CALEOs",
  );
  assert.equal(result.category, "event", "invalid type falls back to localClassify");
  assert.equal(result.topic, "internal/events", "invalid topic falls back to localClassify");
});

test("classificationFromRefinement returns the local fallback when refinement emitted no frontmatter", () => {
  const fallback = localClassify("Sommerseminar 2026", "# Sommerseminar\n\nC-Day für die CALEOs");
  const result = classificationFromRefinement(undefined, "Sommerseminar 2026", "# Sommerseminar\n\nC-Day für die CALEOs");
  assert.deepEqual(result, fallback);
});

test("ingest writes under wiki/<topic>/ when the classifier returns a topic", async () => {
  const classify: (input: { title: string; content: string }) => Promise<WikiClassification> = async () => ({
    category: "concept",
    pagePath: "wiki/concepts/sommerseminar-lusen-sudtirol-2026.md",
    topic: "sommerseminar",
  });
  const fakes = makeFakes({ classify });
  const service = new KnowledgeIngestService({
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

test("ingestMarkdown classifies FIRST and reuses the classification for the wiki page (G3.S8.T2)", async () => {
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
    llmwiki: fakes.llmwiki,
    wikiDir: "/data/wiki",
    projectId: "athena-wiki",
    classify,
    rebuildIndex: fakes.rebuildIndex,
    ...fakes.fs,
  });

  await service.ingestMarkdown({ title: "Sommerseminar 2026", content: "# Sommerseminar 2026\n\nC-Day" });

  // the classification is used once for the wiki page
  assert.equal(classifyCalls, 1);
  const write = fakes.calls.find((c) => c.kind === "fs.writeFile");
  assert.equal(write?.args[0], "/data/wiki/internal/events/sommerseminar-2026.md");
  assert.match(write?.args[1] as string, /^---\ntype: event\ntitle: Sommerseminar 2026\ntopic: internal\/events\n/);
});

test("ingestLlmWiki copies docling-extracted images beside the wiki page (G3.S5.T5)", async () => {
  const copied: [string, string][] = [];
  const fakes = makeFakes();
  const service = new KnowledgeIngestService({
    llmwiki: fakes.llmwiki,
    wikiDir: "/data/wiki",
    projectId: "athena-wiki",
    rebuildIndex: fakes.rebuildIndex,
    ...fakes.fs,
    readdir: async (path) => {
      if (path === "/shared/input/images/report.pdf") {
        return [{ name: "image_000000_abc.png", isDir: false }];
      }
      return [];
    },
    copyFile: async (src, dest) => {
      copied.push([src, dest]);
    },
  });

  const result = await service.ingestLlmWiki(
    "report.md",
    "# Report\n\n![A revenue chart](images/report.pdf/image_000000_abc.png)",
    undefined,
    { category: "concept", pagePath: "wiki/concepts/report.md", topic: "sommerseminar" },
    { sourceDir: "/shared/input/images/report.pdf", relativeDir: "images/report.pdf" },
  );

  assert.equal(result.ok, true);
  const write = fakes.calls.find((c) => c.kind === "fs.writeFile");
  assert.equal(write?.args[0], "/data/wiki/sommerseminar/report.md");
  // images copied beside the page, preserving the relative layout the refs use
  assert.deepEqual(copied, [
    [
      "/shared/input/images/report.pdf/image_000000_abc.png",
      "/data/wiki/sommerseminar/images/report.pdf/image_000000_abc.png",
    ],
  ]);
  // the wiki page keeps the relative image refs unchanged (no rewriting)
  assert.match(write?.args[1] as string, /!\[A revenue chart\]\(images\/report\.pdf\/image_000000_abc\.png\)/);
});

test("ingestLlmWiki skips image copying when the doc has no images (missing source dir)", async () => {
  let copied = 0;
  const fakes = makeFakes();
  const service = new KnowledgeIngestService({
    llmwiki: fakes.llmwiki,
    wikiDir: "/data/wiki",
    projectId: "athena-wiki",
    rebuildIndex: fakes.rebuildIndex,
    ...fakes.fs,
    readdir: async () => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    },
    copyFile: async () => {
      copied += 1;
    },
  });

  const result = await service.ingestLlmWiki(
    "plain.md",
    "# Plain\n\nNo images.",
    undefined,
    { category: "concept", pagePath: "wiki/concepts/plain.md", topic: "sommerseminar" },
    { sourceDir: "/shared/input/images/plain.pdf", relativeDir: "images/plain.pdf" },
  );

  assert.equal(result.ok, true);
  assert.equal(copied, 0);
});

test("ingestLlmWiki writes the Athena document summary to the wiki page frontmatter", async () => {
  const fakes = makeFakes();
  const service = new KnowledgeIngestService({
    llmwiki: fakes.llmwiki,
    wikiDir: "/data/wiki",
    projectId: "athena-wiki",
    rebuildIndex: fakes.rebuildIndex,
    ...fakes.fs,
  });

  const result = await service.ingestLlmWiki(
    "sommerseminar.md",
    "# Sommerseminar\n\nbody",
    undefined,
    { category: "event", pagePath: "wiki/events/sommerseminar.md", topic: "internal/events" },
    undefined,
    "CALEO's annual Sommerseminar covers workshops and talks.",
  );

  assert.equal(result.ok, true);
  const write = fakes.calls.find((c) => c.kind === "fs.writeFile");
  assert.equal(write?.args[0], "/data/wiki/internal/events/sommerseminar.md");
  assert.match(
    write?.args[1] as string,
    /^---\ntype: event\ntitle: Sommerseminar\ntopic: internal\/events\nsummary: CALEO's annual Sommerseminar covers workshops and talks\.\ncreated:/,
  );
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

test("saveWikiPage overwrites the page, rebuilds the index, rescans and snapshots BEFORE/AFTER (G4.S3.T10)", async () => {
  const before = `---\ntype: concept\ntitle: Runbook\ntopic: ops\ncreated: 2026-08-01\nupdated: 2026-08-01\n---\n\n# Runbook\n\n![Diagram](images/runbook.pdf/diagram_001.png)\n\nThe image shows a bright sky.\n\nSteps here.`;
  const after = `---\ntype: concept\ntitle: Runbook\ntopic: ops\ncreated: 2026-08-01\nupdated: 2026-08-12\n---\n\n# Runbook\n\n![Diagram](images/runbook.pdf/diagram_001.png)\n\nThe image shows a dark sky.\n\nSteps here.`;
  const fakes = makeFakes({ files: [["/data/wiki/ops/runbook.md", before]] });
  const service = new KnowledgeIngestService({
    llmwiki: fakes.llmwiki,
    wikiDir: "/data/wiki",
    projectId: "athena-wiki",
    rebuildIndex: fakes.rebuildIndex,
    ...fakes.fs,
  });

  const snapshot = await service.saveWikiPage("wiki/ops/runbook.md", after);

  // The corrected FULL page (File A — frontmatter + image refs) is on disk.
  assert.equal(fakes.files.get("/data/wiki/ops/runbook.md"), after);
  assert.equal(snapshot.before, before);
  assert.equal(snapshot.after, after);
  // index rebuilt + llm_wiki rescanned.
  assert.ok(fakes.calls.some((c) => c.kind === "rebuildIndex" && c.args[0] === "/data/wiki"));
  assert.ok(fakes.calls.some((c) => c.kind === "llmwiki.rescan" && c.args[0] === "athena-wiki"));
  // preserved classification from the corrected page frontmatter.
  assert.equal(snapshot.type, "concept");
  assert.equal(snapshot.topic, "ops");
});

test("saveWikiPage rag forms strip image-ref lines and keep VLM alt-text (G4.S3.T10 image handling)", async () => {
  const before = `---\ntype: concept\n---\n\n# Runbook\n\n![Diagram](images/runbook.pdf/diagram_001.png)\n\nThe image shows a bright sky.\n\nSteps here.`;
  const after = `---\ntype: concept\n---\n\n# Runbook\n\n![Diagram](images/runbook.pdf/diagram_001.png)\n\nThe image shows a dark sky.\n\nSteps here.`;
  const fakes = makeFakes({ files: [["/data/wiki/ops/runbook.md", before]] });
  const service = new KnowledgeIngestService({
    llmwiki: fakes.llmwiki,
    wikiDir: "/data/wiki",
    projectId: "athena-wiki",
    rebuildIndex: fakes.rebuildIndex,
    ...fakes.fs,
  });

  const snapshot = await service.saveWikiPage("wiki/ops/runbook.md", after);

  // Image REFS are gone from the RAG-bound text; the VLM description remains.
  assert.ok(!snapshot.ragBefore.includes("![Diagram]"), "ragBefore keeps no image ref");
  assert.ok(!snapshot.ragAfter.includes("![Diagram]"), "ragAfter keeps no image ref");
  assert.ok(snapshot.ragBefore.includes("The image shows a bright sky."));
  assert.ok(snapshot.ragAfter.includes("The image shows a dark sky."));
  // The user's correction (the VLM mis-description) is the only text change.
  assert.equal(snapshot.ragBefore, "# Runbook\n\nThe image shows a bright sky.\n\nSteps here.");
  assert.equal(snapshot.ragAfter, "# Runbook\n\nThe image shows a dark sky.\n\nSteps here.");
  // Frontmatter never leaks into the RAG-bound body.
  assert.ok(!snapshot.ragAfter.includes("type: concept"));
});

test("stripFrontmatterBody returns the body and leaves frontmatter-less content untouched", () => {
  assert.equal(
    stripFrontmatterBody("---\ntype: a\n---\n\nbody"),
    "body",
  );
  assert.equal(stripFrontmatterBody("plain"), "plain");
  assert.equal(stripFrontmatterBody("---\ntype: a\nno closing block\n"), "---\ntype: a\nno closing block\n");
});

test("saveWikiPage rejects a path escaping the wiki dir", async () => {
  const fakes = makeFakes();
  const service = new KnowledgeIngestService({
    llmwiki: fakes.llmwiki,
    wikiDir: "/data/wiki",
    projectId: "athena-wiki",
    rebuildIndex: fakes.rebuildIndex,
    ...fakes.fs,
  });
  await assert.rejects(service.saveWikiPage("wiki/../evil.md", "body"), /invalid wiki path/);
});

test("saveWikiPage surfaces a missing page as an error (ENOENT)", async () => {
  const fakes = makeFakes();
  const service = new KnowledgeIngestService({
    llmwiki: fakes.llmwiki,
    wikiDir: "/data/wiki",
    projectId: "athena-wiki",
    rebuildIndex: fakes.rebuildIndex,
    ...fakes.fs,
  });
  await assert.rejects(service.saveWikiPage("wiki/missing.md", "body"), /ENOENT/);
});
