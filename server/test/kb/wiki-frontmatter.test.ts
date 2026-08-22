import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WikiFrontmatterSyncer,
  parseWikiLifecycle,
  patchFrontmatter,
  type WikiFrontmatterPatch,
} from "../../src/kb/wiki-frontmatter.js";
import {
  DOCUMENT_LABEL,
  IS_DOCUMENT_TYPE,
  WIKIPAGE_LABEL,
  type Neo4jDriverLike,
} from "../../src/kb/store/schema.js";

interface RecordedCall {
  query: string;
  params?: Record<string, unknown>;
}

function makeDriver(): { driver: Neo4jDriverLike; calls: RecordedCall[]; closed: boolean } {
  const calls: RecordedCall[] = [];
  const state = { closed: false };
  const driver: Neo4jDriverLike = {
    session() {
      return {
        run: async (query: string, params?: Record<string, unknown>) => {
          calls.push({ query, params });
          return { records: [] };
        },
        close: async () => {
          state.closed = true;
        },
      };
    },
  };
  return { driver, calls, closed: state.closed };
}

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

const SAMPLE_PAGE = [
  "---",
  "type: concept",
  "title: Chain of Thought",
  "created: 2026-01-01",
  "updated: 2026-01-01",
  "read_count: 2",
  "confidence: 1",
  "---",
  "",
  "# Chain of Thought",
  "",
  "body",
].join("\n");

test("patchFrontmatter upserts lifecycle fields and bumps updated, preserving the body", () => {
  const next = patchFrontmatter(SAMPLE_PAGE, {
    read_count: 3,
    confidence: 0.9,
    last_reviewed: "2026-08-11",
    topic_history: ["internal/events"],
  });

  assert.match(next, /^---\ntype: concept\ntitle: Chain of Thought\ncreated: 2026-01-01\nupdated: \d{4}-\d{2}-\d{2}\nread_count: 3\nconfidence: 0\.9\nlast_reviewed: 2026-08-11\ntopic_history: \["internal\/events"\]\n---\n/);
  assert.ok(next.endsWith("\n# Chain of Thought\n\nbody"), "body untouched");
  assert.match(next, /updated: \d{4}-\d{2}-\d{2}\n/, "updated bumped to today");
});

test("patchFrontmatter creates a frontmatter block when the page has none", () => {
  const next = patchFrontmatter("# Plain\n\nno meta", { read_count: 1 });
  assert.match(next, /^---\nread_count: 1\nupdated: \d{4}-\d{2}-\d{2}\n---\n\n# Plain\n\nno meta$/);
});

test("parseWikiLifecycle reads the lifecycle fields from a frontmatter map", () => {
  const state = parseWikiLifecycle({
    read_count: "5",
    confidence: "0.42",
    last_reviewed: "2026-08-11",
    topic_history: '["sommerseminar", "internal/events"]',
  });
  assert.deepEqual(state, {
    read_count: 5,
    confidence: 0.42,
    last_reviewed: "2026-08-11",
    topic_history: ["sommerseminar", "internal/events"],
    review_count: 0,
  });
});

test("parseWikiLifecycle falls back to safe defaults on missing/invalid values", () => {
  const state = parseWikiLifecycle({});
  assert.deepEqual(state, { read_count: 0, confidence: 1, topic_history: [], review_count: 0 });
  const invalid = parseWikiLifecycle({ read_count: "abc", confidence: "oops" });
  assert.equal(invalid.read_count, 0);
  assert.equal(invalid.confidence, 1);
});

test("update writes the patched frontmatter to the wiki md on disk", async () => {
  const fs = makeFakeFs({ "/data/wiki/concepts/chain-of-thought.md": SAMPLE_PAGE });
  const syncer = new WikiFrontmatterSyncer({
    wikiDir: "/data/wiki",
    readFile: fs.readFile,
    writeFile: fs.writeFile,
  });

  const state = await syncer.update("wiki/concepts/chain-of-thought.md", {
    read_count: 4,
    confidence: 0.85,
    last_reviewed: "2026-08-11",
  });

  const written = fs.files.get("/data/wiki/concepts/chain-of-thought.md")!;
  assert.match(written, /read_count: 4\nconfidence: 0\.85\nlast_reviewed: 2026-08-11\n/);
  assert.match(written, /updated: \d{4}-\d{2}-\d{2}\n/);
  assert.ok(written.endsWith("# Chain of Thought\n\nbody"), "body preserved");
  assert.equal(state.read_count, 4);
  assert.equal(state.confidence, 0.85);
  assert.equal(state.last_reviewed, "2026-08-11");
});

test("update writes through the lifecycle fields to the linked Document node (IS_DOCUMENT)", async () => {
  const fs = makeFakeFs({ "/data/wiki/concepts/chain-of-thought.md": SAMPLE_PAGE });
  const { driver, calls } = makeDriver();
  const syncer = new WikiFrontmatterSyncer({
    wikiDir: "/data/wiki",
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    driver,
  });

  await syncer.update("wiki/concepts/chain-of-thought.md", {
    read_count: 5,
    confidence: 0.8,
    last_reviewed: "2026-08-11",
    topic_history: ["internal/events"],
  });

  const mirror = calls.find((c) => c.query.includes(IS_DOCUMENT_TYPE));
  assert.ok(mirror, "Document mirror query issued");
  assert.match(mirror!.query, /MATCH \(wp:WikiPage \{id: \$wikiPath\}\)<-\[:IS_DOCUMENT\]-\(d:Document\)/);
  assert.deepEqual(mirror!.params, {
    wikiPath: "wiki/concepts/chain-of-thought.md",
    readCount: 5,
    lastReviewed: "2026-08-11",
    confidence: 0.8,
    topicHistory: ["internal/events"],
    review: null,
    reviewCount: 0,
  });
});

test("update skips the Document mirror when no driver is wired", async () => {
  const fs = makeFakeFs({ "/data/wiki/concepts/chain-of-thought.md": SAMPLE_PAGE });
  const syncer = new WikiFrontmatterSyncer({
    wikiDir: "/data/wiki",
    readFile: fs.readFile,
    writeFile: fs.writeFile,
  });

  await syncer.update("wiki/concepts/chain-of-thought.md", { read_count: 3 });
  assert.match(fs.files.get("/data/wiki/concepts/chain-of-thought.md")!, /read_count: 3\n/);
});

test("update tolerates a failing Document mirror (best-effort, wiki write still lands)", async () => {
  const fs = makeFakeFs({ "/data/wiki/concepts/chain-of-thought.md": SAMPLE_PAGE });
  const driver: Neo4jDriverLike = {
    session() {
      return {
        run: async () => {
          throw new Error("neo4j down");
        },
        close: async () => {},
      };
    },
  };
  const syncer = new WikiFrontmatterSyncer({
    wikiDir: "/data/wiki",
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    driver,
  });

  const state = await syncer.update("wiki/concepts/chain-of-thought.md", { read_count: 9 });
  assert.equal(state.read_count, 9);
  assert.match(fs.files.get("/data/wiki/concepts/chain-of-thought.md")!, /read_count: 9\n/);
});

test("readLifecycle reads the current lifecycle state of a wiki page", async () => {
  const fs = makeFakeFs({ "/data/wiki/concepts/chain-of-thought.md": SAMPLE_PAGE });
  const syncer = new WikiFrontmatterSyncer({
    wikiDir: "/data/wiki",
    readFile: fs.readFile,
    writeFile: fs.writeFile,
  });

  const state = await syncer.readLifecycle("wiki/concepts/chain-of-thought.md");
  assert.deepEqual(state, { read_count: 2, confidence: 1, topic_history: [], review_count: 0 });
});

test("incrementReadCount bumps read_count on the wiki md and the Document node (shared canonical path)", async () => {
  const fs = makeFakeFs({ "/data/wiki/concepts/chain-of-thought.md": SAMPLE_PAGE });
  const { driver, calls } = makeDriver();
  const syncer = new WikiFrontmatterSyncer({
    wikiDir: "/data/wiki",
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    driver,
  });

  await syncer.incrementReadCount("wiki/concepts/chain-of-thought.md");

  const written = fs.files.get("/data/wiki/concepts/chain-of-thought.md")!;
  assert.match(written, /read_count: 3\n/, "2 → 3 on the wiki frontmatter");
  const mirror = calls.find((c) => c.query.includes(IS_DOCUMENT_TYPE));
  assert.ok(mirror, "Document mirror query issued");
  assert.equal(mirror!.params!.readCount, 3, "Document node read_count mirrors the wiki value");
});

test("update resolves the wiki dir from a resolver when no fixed wikiDir is set", async () => {
  const fs = makeFakeFs({ "/data/wiki/concepts/chain-of-thought.md": SAMPLE_PAGE });
  const syncer = new WikiFrontmatterSyncer({
    resolveWikiDir: async () => "/data/wiki",
    readFile: fs.readFile,
    writeFile: fs.writeFile,
  });

  await syncer.update("wiki/concepts/chain-of-thought.md", { read_count: 2 });
  assert.match(fs.files.get("/data/wiki/concepts/chain-of-thought.md")!, /read_count: 2\n/);
});

test("update rejects traversal paths outside the wiki dir", async () => {
  const fs = makeFakeFs({});
  const syncer = new WikiFrontmatterSyncer({
    wikiDir: "/data/wiki",
    readFile: fs.readFile,
    writeFile: fs.writeFile,
  });

  await assert.rejects(
    () => syncer.update("wiki/../etc/passwd", { read_count: 1 }),
    /invalid wiki path/,
  );
});
