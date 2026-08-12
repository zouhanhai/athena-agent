import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  FeedbackService,
  adjustConfidence,
  DEFAULT_FEEDBACK_CONFIG,
  type ConfidenceUpdate,
} from "../../src/kb/feedback.js";
import { MemoryQaPairStore, type QaPair } from "../../src/kb/qa-pairs.js";
import { MemoryQaEmbeddingIndex } from "../../src/kb/qa-index.js";
import { WikiFrontmatterSyncer } from "../../src/kb/wiki-frontmatter.js";
import { IS_DOCUMENT_TYPE, type Neo4jDriverLike } from "../../src/kb/store/schema.js";

const PAGE = [
  "---",
  "type: concept",
  "title: Chain of Thought",
  "created: 2026-01-01",
  "updated: 2026-08-01",
  "read_count: 2",
  "confidence: 0.6",
  "---",
  "",
  "# Chain of Thought",
  "",
  "body",
].join("\n");

/** Fake fs that throws on a missing path (like the real node fs) so best-effort
 *  confidence updates are observable. */
function makeFakeFs(initial: Record<string, string>): {
  files: Map<string, string>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
} {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFile: async (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: no such file ${path}`);
      return content;
    },
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

function makeService(overrides: {
  files?: Record<string, string>;
  index?: MemoryQaEmbeddingIndex;
  embedder?: { embed(texts: string[]): Promise<number[][]> };
  config?: Parameters<FeedbackService["constructor"]>[0]["config"];
}) {
  const fs = makeFakeFs(overrides.files ?? {});
  const { driver, calls } = makeDriver();
  const syncer = new WikiFrontmatterSyncer({
    wikiDir: "/data/wiki",
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    driver,
  });
  const store = new MemoryQaPairStore();
  const service = new FeedbackService({
    store,
    syncer,
    ...(overrides.index ? { index: overrides.index } : {}),
    ...(overrides.config ? { config: overrides.config } : {}),
  });
  return { service, store, syncer, fs, calls, driver };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    question: "What is C-Day?",
    answer: "C-Day is the CALEO Day.",
    sources: [{ path: "wiki/events/c-day.md" }],
    feedback: "up",
    ...overrides,
  };
}

// ---- pure confidence rule ----

test("adjustConfidence: upvote reinforces (+boost), downvote fades (-penalty)", () => {
  const cfg = DEFAULT_FEEDBACK_CONFIG;
  assert.equal(adjustConfidence(0.5, "up", cfg), 0.5 + cfg.reinforceBoost);
  assert.equal(adjustConfidence(0.5, "down", cfg), 0.5 - cfg.fadePenalty);
});

test("adjustConfidence clamps to [minConfidence, maxConfidence]", () => {
  const cfg = { ...DEFAULT_FEEDBACK_CONFIG, reinforceBoost: 5, fadePenalty: 5 };
  assert.equal(adjustConfidence(0.9, "up", cfg), 1);
  assert.equal(adjustConfidence(0.1, "down", cfg), 0);
});

// ---- record: store + confidence through the canonical syncer ----

test("record stores the Q&A pair with sources + feedback", async () => {
  const { service, store } = makeService({});
  const result = await service.record(input());

  const stored = await store.findByQuestion("What is C-Day?");
  assert.ok(stored);
  assert.equal(stored!.answer, "C-Day is the CALEO Day.");
  assert.deepEqual(stored!.sources, [{ path: "wiki/events/c-day.md" }]);
  assert.equal(stored!.feedback, "up");
  assert.equal(result.pair.id, stored!.id);
  assert.equal(result.deduped, false);
});

test("record upvote raises the source page confidence via the syncer (wiki + Document mirror)", async () => {
  const { service, fs, calls } = makeService({
    files: { "/data/wiki/events/c-day.md": PAGE },
  });

  const result = await service.record(input());

  const written = fs.files.get("/data/wiki/events/c-day.md")!;
  assert.match(written, /confidence: 0\.75\n/);
  assert.deepEqual(result.confidenceUpdates, [
    { path: "wiki/events/c-day.md", feedback: "up", from: 0.6, to: 0.75 },
  ]);
  const mirror = calls.find((c) => c.query.includes(IS_DOCUMENT_TYPE));
  assert.ok(mirror, "Document mirror issued");
  assert.equal(mirror!.params!.confidence, 0.75);
});

test("record downvote lowers the source page confidence (fade)", async () => {
  const { service, fs } = makeService({
    files: { "/data/wiki/events/c-day.md": PAGE },
  });

  const result = await service.record(input({ feedback: "down" }));

  const written = fs.files.get("/data/wiki/events/c-day.md")!;
  assert.match(written, /confidence: 0\.45\n/);
  assert.deepEqual(result.confidenceUpdates, [
    { path: "wiki/events/c-day.md", feedback: "down", from: 0.6, to: 0.45 },
  ]);
});

test("record skips sources without a wiki path and non-wiki paths", async () => {
  const { service, fs } = makeService({
    files: { "/data/wiki/events/c-day.md": PAGE },
  });

  const result = await service.record(
    input({
      sources: [
        { path: "wiki/events/c-day.md" },
        { title: "no path source" },
        { path: "/etc/passwd" },
        { path: "docs/outside-wiki.md" },
      ],
    }),
  );

  assert.equal(result.confidenceUpdates.length, 1);
  assert.equal(result.confidenceUpdates[0]!.path, "wiki/events/c-day.md");
  assert.match(fs.files.get("/data/wiki/events/c-day.md")!, /confidence: 0\.75\n/);
});

test("record tolerates a source page that no longer exists (best-effort)", async () => {
  const { service, fs } = makeService({ files: {} });

  const result = await service.record(input());

  assert.deepEqual(result.confidenceUpdates, []);
  assert.equal(fs.files.size, 0, "no page written for a missing source");
});

test("repeating the same direction does not double-adjust confidence", async () => {
  const { service, fs } = makeService({
    files: { "/data/wiki/events/c-day.md": PAGE },
  });

  await service.record(input({ feedback: "up" }));
  const second = await service.record(input({ feedback: "up" }));

  assert.deepEqual(second.confidenceUpdates, [], "same direction is idempotent");
  assert.match(fs.files.get("/data/wiki/events/c-day.md")!, /confidence: 0\.75\n/);
});

test("switching direction applies the new signal net of the previous one", async () => {
  const { service, fs } = makeService({
    files: { "/data/wiki/events/c-day.md": PAGE },
  });

  await service.record(input({ feedback: "up" })); // 0.6 → 0.75
  const result = await service.record(input({ feedback: "down" })); // 0.75 → 0.6

  assert.deepEqual(result.confidenceUpdates, [
    { path: "wiki/events/c-day.md", feedback: "down", from: 0.75, to: 0.6 },
  ]);
});

// ---- record: vector dedup on store ----

/** Deterministic 256-dim bag-of-words embedder (mirrors qa-pairs.test). */
function tokenEmbedder(texts: string[]): Promise<number[][]> {
  return Promise.resolve(
    texts.map((text) => {
      const vec = new Array<number>(256).fill(0);
      for (const token of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
        let h = 0;
        for (const ch of token) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        vec[h % 256]! += 1;
      }
      return vec;
    }),
  );
}

function dedupService(overrides: Record<string, unknown> = {}) {
  const base = makeService({ index: new MemoryQaEmbeddingIndex({ embedder: { embed: tokenEmbedder } }), ...overrides });
  return base;
}

test("a semantically similar question updates the existing pair instead of inserting", async () => {
  const { service, store } = dedupService();
  const first = await service.record(input({ question: "What is C-Day?", answer: "the CALEO Day" }));

  const result = await service.record(
    input({
      question: "what is C-day", // near-identical question, different casing/punct
      answer: "also celebrated annually",
      feedback: "down",
    }),
  );

  assert.equal(result.deduped, true);
  assert.equal(result.pair.id, first.pair.id, "same pair updated, no duplicate row");
  assert.equal((await store.list()).length, 1);
  const stored = await store.findByQuestion("What is C-Day?");
  assert.ok(stored!.answer.includes("also celebrated annually"), "answer appended");
  assert.equal(stored!.feedback, "down", "feedback aggregated");
});

test("a new (dissimilar) question inserts a fresh pair", async () => {
  const { service, store } = dedupService();
  await service.record(input({ question: "What is C-Day?" }));

  const result = await service.record(
    input({ question: "How do I file an invoice?", feedback: "up" }),
  );

  assert.equal(result.deduped, false);
  assert.equal((await store.list()).length, 2);
});

test("dedup still updates confidence per direction on the merged pair", async () => {
  const { service, fs } = dedupService({
    files: { "/data/wiki/events/c-day.md": PAGE },
  });
  await service.record(input({ question: "What is C-Day?", feedback: "up" })); // 0.6 → 0.75

  const result = await service.record(
    input({ question: "what is c-day", feedback: "up" }), // same direction → idempotent
  );

  assert.equal(result.deduped, true);
  assert.deepEqual(result.confidenceUpdates, []);
  assert.match(fs.files.get("/data/wiki/events/c-day.md")!, /confidence: 0\.75\n/);
});

test("without an index, record falls back to plain insert (no dedup)", async () => {
  const { service, store } = makeService({});
  await service.record(input({ question: "What is C-Day?" }));

  const result = await service.record(input({ question: "what is c-day" }));

  assert.equal(result.deduped, false);
  assert.equal((await store.list()).length, 2, "two rows when dedup is disabled");
});

test("feedback config is respected by record", async () => {
  const { service, fs } = makeService({
    files: { "/data/wiki/events/c-day.md": PAGE },
    config: { reinforceBoost: 0.1, fadePenalty: 0.2 },
  });

  const up = await service.record(input({ feedback: "up" }));
  assert.equal(up.confidenceUpdates[0]!.to, 0.7);

  const down = await service.record(input({ feedback: "down" }));
  assert.equal(down.confidenceUpdates[0]!.to, 0.5);
});
