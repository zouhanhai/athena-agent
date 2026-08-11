import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { WikiReCurator, type ReCurateFs } from "../../src/kb/recurate.js";
import type { WikiIndexEntry } from "../../src/kb/ingest.js";

function makeFs(initial: Record<string, string>) {
  const files = new Map<string, string>(Object.entries(initial));
  const dirs = new Set<string>();
  const ensure = (p: string): void => {
    let dir = dirname(p);
    while (dir && dir !== "/") {
      dirs.add(dir);
      dir = dirname(dir);
    }
  };
  for (const p of files.keys()) ensure(p);
  const calls: string[] = [];
  const base = (p: string): string => p.split("/").pop() ?? p;
  const parent = (p: string): string => p.slice(0, p.lastIndexOf("/"));

  const readdir = async (p: string): Promise<WikiIndexEntry[]> => {
    calls.push(`readdir:${p}`);
    const names = new Map<string, boolean>();
    for (const f of files.keys()) {
      if (parent(f) === p) names.set(base(f), false);
    }
    for (const d of dirs) {
      if (parent(d) === p) names.set(base(d), true);
    }
    return [...names.entries()].map(([name, isDir]) => ({ name, isDir }));
  };

  const fs: ReCurateFs = {
    readFile: async (p) => {
      calls.push(`read:${p}`);
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    writeFile: async (p, c) => {
      calls.push(`write:${p}`);
      files.set(p, c);
      ensure(p);
    },
    mkdir: async (p) => {
      calls.push(`mkdir:${p}`);
      ensure(p);
    },
    rm: async (p) => {
      calls.push(`rm:${p}`);
      files.delete(p);
    },
    rmdir: async (p) => {
      calls.push(`rmdir:${p}`);
      dirs.delete(p);
    },
    readdir,
  };
  return { fs, files, dirs, calls };
}

function makeLlmwiki(projectId = "athena-wiki") {
  const calls: string[] = [];
  return {
    calls,
    llmwiki: {
      async rescan(pid: string) {
        calls.push(`rescan:${pid}`);
        return { ok: true, tasks: [] };
      },
      async listProjects() {
        return {
          currentProject: null,
          projects: [{ id: projectId, name: projectId, path: "/data/wiki", current: false }],
        };
      },
    } as never,
  };
}

const TOPIC_PAGE = [
  "---",
  "type: event",
  "title: Sommerseminar",
  "topic: internal/events",
  "created: 2026-01-01",
  "updated: 2026-01-01",
  "read_count: 2",
  "confidence: 1",
  "---",
  "",
  "# Sommerseminar",
  "",
  "body",
].join("\n");

test("reTopic moves the page to the deeper topic dir and updates topic + topic_history + last_reviewed", async () => {
  const { fs, files, calls } = makeFs({
    "/data/wiki/internal/events/sommerseminar.md": TOPIC_PAGE,
  });
  const { llmwiki, calls: wikiCalls } = makeLlmwiki();
  const indexCalls: string[] = [];
  const curator = new WikiReCurator({
    wikiDir: "/data/wiki",
    projectId: "athena-wiki",
    fs,
    llmwiki,
    rebuildIndex: async (wikiDir) => {
      indexCalls.push(wikiDir);
    },
  });

  const result = await curator.reTopic({
    path: "wiki/internal/events/sommerseminar.md",
    topic: "internal/events/sommerseminar",
  });

  assert.equal(result.oldPath, "wiki/internal/events/sommerseminar.md");
  assert.equal(result.newPath, "wiki/internal/events/sommerseminar/sommerseminar.md");
  assert.equal(result.topic, "internal/events/sommerseminar");
  assert.deepEqual(result.topicHistory, ["internal/events"]);
  assert.match(result.lastReviewed, /^\d{4}-\d{2}-\d{2}$/);

  assert.ok(!files.has("/data/wiki/internal/events/sommerseminar.md"), "old file removed");
  const moved = files.get("/data/wiki/internal/events/sommerseminar/sommerseminar.md")!;
  assert.ok(moved, "new file written at the deeper topic dir");
  assert.match(moved, /^---\ntype: event\ntitle: Sommerseminar\n/);
  assert.match(moved, /topic: internal\/events\/sommerseminar\n/);
  assert.match(moved, /topic_history: \["internal\/events"\]\n/);
  assert.match(moved, /last_reviewed: \d{4}-\d{2}-\d{2}\n/);
  assert.ok(moved.endsWith("# Sommerseminar\n\nbody"), "body untouched");
  assert.ok(moved.includes("read_count: 2"), "read_count preserved");
  assert.ok(moved.includes("confidence: 1"), "confidence preserved");

  assert.deepEqual(indexCalls, ["/data/wiki"], "wiki index rebuilt after the move");
  assert.deepEqual(wikiCalls, ["rescan:athena-wiki"], "llm_wiki rescanned so the tree updates");
  assert.ok(calls.includes("rm:/data/wiki/internal/events/sommerseminar.md"), "old file rm'd");
});

test("reTopic appends the old topic to an existing topic_history", async () => {
  const page = TOPIC_PAGE.replace(
    "topic: internal/events",
    "topic: internal/events\ntopic_history: [\"sap/events\"]",
  );
  const { fs, files } = makeFs({ "/data/wiki/internal/events/sommerseminar.md": page });
  const curator = new WikiReCurator({
    wikiDir: "/data/wiki",
    fs,
  });

  await curator.reTopic({
    path: "wiki/internal/events/sommerseminar.md",
    topic: "internal/events/sommerseminar",
  });

  const moved = files.get("/data/wiki/internal/events/sommerseminar/sommerseminar.md")!;
  assert.match(
    moved,
    /topic_history: \["sap\/events", "internal\/events"\]\n/,
    "existing history kept + old topic appended at the end",
  );
});

test("reTopic of a category-dir page (no topic) sets the topic without a history entry", async () => {
  const page = [
    "---",
    "type: event",
    "title: Sommerseminar",
    "created: 2026-01-01",
    "updated: 2026-01-01",
    "read_count: 0",
    "confidence: 1",
    "---",
    "",
    "# Sommerseminar",
    "",
    "body",
  ].join("\n");
  const { fs, files } = makeFs({ "/data/wiki/events/sommerseminar.md": page });
  const curator = new WikiReCurator({ wikiDir: "/data/wiki", fs });

  const result = await curator.reTopic({
    path: "wiki/events/sommerseminar.md",
    topic: "internal/events/sommerseminar",
  });

  assert.equal(result.newPath, "wiki/internal/events/sommerseminar/sommerseminar.md");
  assert.deepEqual(result.topicHistory, [], "no old topic to record");
  const moved = files.get("/data/wiki/internal/events/sommerseminar/sommerseminar.md")!;
  assert.match(moved, /topic: internal\/events\/sommerseminar\n/);
  assert.ok(!/topic_history:/.test(moved), "no topic_history line when there was no old topic");
});

test("reTopic removes now-empty parent dirs after the move", async () => {
  const { fs, dirs, calls } = makeFs({
    "/data/wiki/events/sommerseminar.md": TOPIC_PAGE,
  });
  const curator = new WikiReCurator({ wikiDir: "/data/wiki", fs });

  await curator.reTopic({
    path: "wiki/events/sommerseminar.md",
    topic: "internal/events/sommerseminar",
  });

  assert.ok(!dirs.has("/data/wiki/events"), "emptied events/ dir removed");
  assert.ok(calls.includes("rmdir:/data/wiki/events"), "rmdir called on the emptied dir");
  assert.ok(dirs.has("/data/wiki"), "wiki root kept");
});

test("reTopic rebuilds the wiki index and rescans when wired", async () => {
  const { fs } = makeFs({ "/data/wiki/internal/events/sommerseminar.md": TOPIC_PAGE });
  const { llmwiki, calls: wikiCalls } = makeLlmwiki("athena-wiki");
  const indexCalls: string[] = [];
  const curator = new WikiReCurator({
    wikiDir: "/data/wiki",
    projectId: "athena-wiki",
    fs,
    llmwiki,
    rebuildIndex: async (dir) => {
      indexCalls.push(dir);
    },
  });

  await curator.reTopic({
    path: "wiki/internal/events/sommerseminar.md",
    topic: "internal/events/sommerseminar",
  });

  assert.deepEqual(indexCalls, ["/data/wiki"]);
  assert.deepEqual(wikiCalls, ["rescan:athena-wiki"]);
});

test("reTopic performs NO Neo4j interaction (wiki-only: file move + frontmatter + index + rescan)", async () => {
  const { fs, calls } = makeFs({ "/data/wiki/internal/events/sommerseminar.md": TOPIC_PAGE });
  const { llmwiki, calls: wikiCalls } = makeLlmwiki();
  const curator = new WikiReCurator({
    wikiDir: "/data/wiki",
    fs,
    llmwiki,
  });

  await curator.reTopic({
    path: "wiki/internal/events/sommerseminar.md",
    topic: "internal/events/sommerseminar",
  });

  const all = [...calls, ...wikiCalls];
  assert.ok(
    !all.some((c) => /IS_DOCUMENT|Document|neo4j|Neo4j|chunk|embed/i.test(c)),
    "no Neo4j/document/chunk/embed call: " + all.join(", "),
  );
});

test("reTopic rejects an invalid (unsafe) new topic", async () => {
  const { fs } = makeFs({ "/data/wiki/internal/events/sommerseminar.md": TOPIC_PAGE });
  const curator = new WikiReCurator({ wikiDir: "/data/wiki", fs });

  await assert.rejects(
    () => curator.reTopic({ path: "wiki/internal/events/sommerseminar.md", topic: "../evil" }),
    /invalid topic/,
  );
});

test("reTopic rejects a traversal wiki page path", async () => {
  const { fs } = makeFs({});
  const curator = new WikiReCurator({ wikiDir: "/data/wiki", fs });

  await assert.rejects(
    () => curator.reTopic({ path: "wiki/../../etc/passwd", topic: "sap/ai" }),
    /invalid wiki path/,
  );
});

test("reTopic rejects a non-md path", async () => {
  const { fs } = makeFs({});
  const curator = new WikiReCurator({ wikiDir: "/data/wiki", fs });

  await assert.rejects(
    () => curator.reTopic({ path: "wiki/internal/events/sommerseminar.txt", topic: "sap/ai" }),
    /\.md/,
  );
});

test("reTopic to the current topic is a no-op error (already there)", async () => {
  const { fs, calls } = makeFs({ "/data/wiki/internal/events/sommerseminar.md": TOPIC_PAGE });
  const curator = new WikiReCurator({ wikiDir: "/data/wiki", fs });

  await assert.rejects(
    () => curator.reTopic({ path: "wiki/internal/events/sommerseminar.md", topic: "internal/events" }),
    /already at topic|same topic/,
  );
  assert.ok(
    !calls.some((c) => c.startsWith("write:") || c.startsWith("rm:") || c.startsWith("rmdir:")),
    "no mutation for a no-op re-topic: " + calls.join(", "),
  );
});
