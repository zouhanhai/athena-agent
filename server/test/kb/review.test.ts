import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KbReviewService,
  decideReview,
  DEFAULT_REVIEW_CONFIG,
  scheduleKbReview,
  type ReviewDecision,
} from "../../src/kb/review.js";
import { WikiFrontmatterSyncer } from "../../src/kb/wiki-frontmatter.js";
import {
  DOCUMENT_LABEL,
  IS_DOCUMENT_TYPE,
  type Neo4jDriverLike,
} from "../../src/kb/store/schema.js";
import { join } from "node:path";
import type { LlmWikiClient } from "../../src/kb/llmwiki.js";

const NOW = "2026-08-11";

function fm(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    type: "concept",
    title: "Chain of Thought",
    created: "2024-01-01",
    updated: "2024-01-01",
    read_count: "0",
    confidence: "1",
    ...overrides,
  };
}

function decision(overrides: Record<string, string> = {}, opts: Record<string, unknown> = {}): ReviewDecision {
  return decideReview(fm(overrides), { now: NOW, ...opts } as never);
}

test("confidence decays with content age (fade → deprecate)", () => {
  const d = decision({ updated: "2025-08-11", confidence: "0.9", read_count: "9" });
  assert.equal(d.action, "deprecate");
  assert.ok(d.confidence < 0.9, "confidence dropped");
  assert.equal(d.confidence, Math.round((0.9 - 365 * DEFAULT_REVIEW_CONFIG.decayPerDay) * 1000) / 1000);
  assert.equal(d.lastReviewed, NOW);
  assert.match(d.reason, /faded/);
});

test("very stale + rarely read page is deprecated and flagged for archive", () => {
  const d = decision({ updated: "2020-01-01", confidence: "0.2", read_count: "0" });
  assert.equal(d.action, "deprecate");
  assert.equal(d.archive, true, "rotting page flagged for archive");
  assert.match(d.reason, /archive/);
});

test("a stale page that is still read frequently is NOT flagged for archive", () => {
  const d = decision({ updated: "2020-01-01", confidence: "0.8", read_count: "12" });
  assert.equal(d.action, "deprecate");
  assert.equal(d.archive, undefined, "used page is not archived");
});

test("re-topic: a valid suggested topic that differs applies retopic", () => {
  const d = decision({ topic: "internal/events" }, { retopic: "internal/events/sommerseminar" });
  assert.equal(d.action, "retopic");
  assert.equal(d.topic, "internal/events/sommerseminar");
  assert.equal(d.topicFrom, "internal/events");
});

test("re-topic: the same topic or an invalid topic is ignored", () => {
  const same = decision({ topic: "sap" }, { retopic: "sap" });
  assert.notEqual(same.action, "retopic");
  const invalid = decision({ topic: "sap" }, { retopic: "../escape" });
  assert.notEqual(invalid.action, "retopic");
});

test("re-classify: a valid type that differs applies reclassify", () => {
  const d = decision({ type: "concept" }, { reclassify: "event" });
  assert.equal(d.action, "reclassify");
  assert.equal(d.type, "event");
  assert.equal(d.typeFrom, "concept");
});

test("re-classify: an unknown type is ignored", () => {
  const d = decision({ type: "concept" }, { reclassify: "banana" });
  assert.notEqual(d.action, "reclassify");
});

test("reinforce: a fresh confirming source raises confidence", () => {
  const d = decision({ updated: NOW, confidence: "0.6" }, { reinforce: true });
  assert.equal(d.action, "reinforce");
  assert.equal(d.confidence, 0.6 + DEFAULT_REVIEW_CONFIG.reinforceBoost);
  assert.ok(d.confidenceDelta > 0);
});

test("a fresh, used page with no signal needs no action", () => {
  const d = decision({ updated: NOW, confidence: "0.9", read_count: "7" });
  assert.equal(d.action, "none");
  assert.equal(d.confidence, 0.9);
  assert.equal(d.confidenceDelta, 0);
});

test("confidence never drops below zero", () => {
  const d = decision({ updated: "1999-01-01", confidence: "0.05" });
  assert.ok(d.confidence >= 0);
});

// ---- KbReviewService (scan + write-through via the canonical syncer) ----

function makeFakeFs(initial: Record<string, string>): {
  files: Map<string, string>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
} {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFile: async (path) => files.get(path) ?? "",
    writeFile: async (path, content) => {
      files.set(path, content);
    },
  };
}

function makeDriver(): { driver: Neo4jDriverLike; calls: { query: string; params?: Record<string, unknown> }[] } {
  const calls: { query: string; params?: Record<string, unknown> }[] = [];
  const driver: Neo4jDriverLike = {
    session() {
      return {
        run: async (query: string, params?: Record<string, unknown>) => {
          calls.push({ query, params });
          return { records: [] };
        },
        close: async () => {},
      };
    },
  };
  return { driver, calls };
}

function page(
  path: string,
  lifecycle: Record<string, string>,
): { path: string; content: string } {
  const lines = ["---", ...Object.entries(lifecycle).map(([k, v]) => `${k}: ${v}`), "---", "", "# Page", "", "body"];
  return { path, content: lines.join("\n") };
}

function makeService(inputs: {
  pages: ReturnType<typeof page>[];
  files?: Record<string, string>;
}) {
  const seeded: Record<string, string> = { ...(inputs.files ?? {}) };
  for (const p of inputs.pages) {
    const rel = p.path.startsWith("wiki/") ? p.path.slice("wiki/".length) : p.path;
    seeded[join("/data/wiki", rel)] = p.content;
  }
  const fs = makeFakeFs(seeded);
  const { driver, calls } = makeDriver();
  const syncer = new WikiFrontmatterSyncer({
    wikiDir: "/data/wiki",
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    driver,
  });
  const llmwiki = {
    listProjects: async () => ({
      projects: [{ id: "proj1", name: "P1", path: "/p", current: false }],
      currentProject: null,
    }),
    listWikiPages: async () => inputs.pages.map((p) => ({ path: p.path })),
    readFile: async (_id: string, path: string) => {
      const rel = path.startsWith("wiki/") ? path.slice("wiki/".length) : path;
      const file = inputs.pages.find((p) => p.path === path);
      return { path, content: file?.content ?? fs.files.get(join("/data/wiki", rel)) ?? "" };
    },
  } as unknown as LlmWikiClient;
  const service = new KbReviewService({
    llmwiki,
    syncer,
    projectId: "proj1",
    now: NOW,
    wikiDir: "/data/wiki",
    readFile: fs.readFile,
  });
  return { service, fs, calls };
}

test("reviewAll re-topics pages via the canonical syncer (wiki + Document mirror)", async () => {
  const rot = page("wiki/events/old.md", {
    type: "event",
    topic: "internal/events",
    updated: "2024-01-01",
    read_count: "0",
    confidence: "0.9",
  });
  const fresh = page("wiki/concepts/cot.md", {
    type: "concept",
    topic: "sap",
    updated: NOW,
    read_count: "4",
    confidence: "0.9",
  });
  const { service, fs, calls } = makeService({ pages: [rot, fresh] });

  const report = await service.reviewAll({
    retopics: { "wiki/events/old.md": "internal/events/sommerseminar" },
  });

  const written = fs.files.get("/data/wiki/events/old.md")!;
  assert.match(written, /topic: internal\/events\/sommerseminar/);
  assert.match(written, /topic_history: \["internal\/events"\]/);
  assert.match(written, new RegExp(`last_reviewed: ${NOW}`));
  const mirror = calls.find((c) => c.query.includes(IS_DOCUMENT_TYPE));
  assert.ok(mirror, "Document mirror issued for the retopiced page");
  assert.ok(report.results.some((r) => r.path === "wiki/events/old.md" && r.action === "retopic"));
});

test("reviewAll deprecates + archives rotting pages and lowers confidence on disk", async () => {
  const rotting = page("wiki/old.md", {
    type: "report",
    updated: "2019-01-01",
    read_count: "0",
    confidence: "0.2",
  });
  const { service, fs } = makeService({ pages: [rotting] });

  const report = await service.reviewAll();

  assert.equal(report.changed, 1);
  assert.deepEqual(report.archive, ["wiki/old.md"]);
  const written = fs.files.get("/data/wiki/old.md")!;
  const confidence = Number.parseFloat(written.match(/confidence: ([\d.]+)/)?.[1] ?? "1");
  assert.ok(confidence < 0.2, "confidence lowered on disk");
  assert.match(written, new RegExp(`last_reviewed: ${NOW}`));
});

test("reviewAll reinforces a page and writes the boosted confidence", async () => {
  const page1 = page("wiki/concepts/cot.md", {
    type: "concept",
    updated: NOW,
    read_count: "2",
    confidence: "0.6",
  });
  const { service, fs } = makeService({ pages: [page1] });

  const report = await service.reviewAll({ reinforce: ["wiki/concepts/cot.md"] });

  const result = report.results.find((r) => r.path === "wiki/concepts/cot.md");
  assert.equal(result?.action, "reinforce");
  const written = fs.files.get("/data/wiki/concepts/cot.md")!;
  assert.match(written, new RegExp(`confidence: ${0.6 + DEFAULT_REVIEW_CONFIG.reinforceBoost}`));
});

test("reviewAll dryRun scans and reports without writing", async () => {
  const rotting = page("wiki/old.md", {
    type: "report",
    updated: "2019-01-01",
    read_count: "0",
    confidence: "0.2",
  });
  const { service, fs } = makeService({ pages: [rotting] });
  const before = fs.files.get("/data/wiki/old.md");

  const report = await service.reviewAll({ dryRun: true });

  assert.equal(report.scanned, 1);
  assert.deepEqual(report.archive, ["wiki/old.md"]);
  assert.equal(fs.files.get("/data/wiki/old.md"), before, "dry run wrote nothing");
});

test("reviewAll uses a classify hook for per-page re-topic / re-classify suggestions", async () => {
  const cot = page("wiki/concepts/cot.md", {
    type: "concept",
    topic: "sap",
    updated: NOW,
    read_count: "4",
    confidence: "0.9",
  });
  const { service, fs } = makeService({ pages: [cot] });

  const report = await service.reviewAll({
    classify: async (p) => (p.path.endsWith("cot.md") ? { topic: "sap/ai", type: "concept" } : undefined),
  });

  const result = report.results.find((r) => r.path === "wiki/concepts/cot.md");
  assert.equal(result?.action, "retopic");
  assert.equal(result?.topic, "sap/ai");
  assert.match(fs.files.get("/data/wiki/concepts/cot.md")!, /topic_history: \["sap"\]/);
});

test("scheduleKbReview triggers reviewAll on an interval and can be stopped", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const rotting = page("wiki/old.md", {
    type: "report",
    updated: "2019-01-01",
    read_count: "0",
    confidence: "0.2",
  });
  const { service, fs } = makeService({ pages: [rotting] });
  let runs = 0;
  const wrapped = {
    reviewAll: async (opts?: Record<string, unknown>) => {
      runs += 1;
      return service.reviewAll(opts as never);
    },
  } as unknown as KbReviewService;

  const scheduled = scheduleKbReview(wrapped, 1000);
  try {
    t.mock.timers.tick(1000);
    assert.equal(runs, 1, "first interval fires a review");
    t.mock.timers.tick(2000);
    assert.equal(runs, 3, "repeats every interval");
  } finally {
    scheduled.stop();
    t.mock.timers.tick(3000);
    assert.equal(runs, 3, "stopping halts further runs");
  }
});
