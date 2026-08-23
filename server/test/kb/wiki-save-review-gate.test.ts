import { test } from "node:test";
import assert from "node:assert/strict";
import { IngestTaskQueue } from "../../src/kb/tasks.js";
import { WikiFrontmatterSyncer } from "../../src/kb/wiki-frontmatter.js";
import type { RefineOutputRef } from "../../src/agents/refine-output.js";
import type { Neo4jDriverLike } from "../../src/kb/store/schema.js";

/**
 * G4.S8.T21 ① — review-gate sync after a wiki edit. runWikiSave must restamp
 * the page's frontmatter review gate keyed on the WIKI-EDIT refinement quality,
 * mirroring the upload path, through the canonical WikiFrontmatterSyncer so
 * the Neo4j Document mirror stays consistent (T1 contract):
 *   - edit quality action=review_required → review: required + unresolved count;
 *   - edit quality action=auto_accept while the gate was previously required →
 *     review: clear + review_count: 0 (no stale banner);
 *   - auto_accept with no previous required gate → frontmatter untouched.
 */

const PAGE_PATH = "wiki/events/luesen.md";
const PAGE_LOCAL = "/data/wiki/events/luesen.md";

function pageWithGate(review: string | undefined, count: number | undefined): string {
  const lines = ["---", "type: document", "title: Lüsen"];
  if (review) lines.push(`review: ${review}`);
  if (count !== undefined) lines.push(`review_count: ${count}`);
  lines.push("---", "", "# Lüsen", "", "Week overview.");
  return lines.join("\n");
}

interface MirrorCall {
  query: string;
  params: Record<string, unknown>;
}

function makeHarness(page: string) {
  const files = new Map<string, string>([[PAGE_LOCAL, page]]);
  const mirrors: MirrorCall[] = [];
  const driver: Neo4jDriverLike = {
    session() {
      return {
        run: async (query: string, params?: Record<string, unknown>) => {
          if (query.includes("SET d.read_count")) mirrors.push({ query, params: params ?? {} });
          return { records: [] };
        },
        close: async () => {},
      };
    },
  };
  const syncer = new WikiFrontmatterSyncer({
    wikiDir: "/data/wiki",
    readFile: async (p) => {
      const hit = files.get(p);
      if (hit === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return hit;
    },
    writeFile: async (p, c) => void files.set(p, c),
    driver,
  });
  const makeQueue = (quality: RefineOutputRef["quality"]) =>
    new IngestTaskQueue({
      parser: { async parse() {
        throw new Error("wiki save must not parse");
      } } as never,
      ingest: {} as never,
      frontmatter: syncer,
      wikiRefiner: async () => ({
        ref: {
          md_ref: "/storage/wiki-edit-luesen/markdown.md",
          chunks_ref: "/storage/wiki-edit-luesen/chunks.json",
          preview: "preview",
          char_count: 1,
          line_count: 1,
          header_count: 1,
          chunk_count: 1,
          frontmatter: { type: "document", topic: "events" },
          entities: [],
          relations: [],
          keywords: [],
          quality,
          summary: "",
          sections: [],
          mode: "single",
          section_paths: [],
        },
        markdown: "# Lüsen\n\nWeek overview.",
        newEntities: [],
        newRelations: [],
        rechunked: false,
      }),
    });
  const untilDone = async (queue: IngestTaskQueue, taskId: string): Promise<void> => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const task = queue.getTask(taskId)!;
      if (task.status === "done" || task.status === "failed") return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("wiki save task did not finish in time");
  };
  return { files, mirrors, makeQueue, untilDone };
}

test("an edit whose refinement is review_required restamps the gate required + issue count (md + Neo4j mirror)", async () => {
  const h = makeHarness(pageWithGate("clear", 0));
  // Edit re-introduces review items: 2 anchored + 1 plain = 3 unresolved.
  const queue = h.makeQueue({
    complete: false,
    confidence: 0.4,
    issues: ["New fact needs confirmation"],
    action: "review_required",
    issue_anchors: [
      { message: "Check lift opening hours", quote: "Week overview." },
      { message: "Verify guest count", quote: "Lüsen" },
    ],
  });
  const { taskId } = queue.submitWikiSave({
    path: PAGE_PATH,
    beforeRag: "# Lüsen\n\nWeek overview.",
    afterRag: "# Lüsen\n\nWeek overview, corrected.",
    diff: "---\n+++",
    structural: false,
    type: "document",
    topic: "events",
  });
  await h.untilDone(queue, taskId);

  const updated = h.files.get(PAGE_LOCAL)!;
  assert.match(updated, /review: required/, "the gate flips back to required");
  assert.match(updated, /review_count: 3/, "the unresolved issue count is stamped");
  assert.equal(h.mirrors.length, 1, "exactly one canonical syncer update");
  assert.equal(h.mirrors[0]!.params.review, "required");
  assert.equal(h.mirrors[0]!.params.reviewCount, 3);
});

test("an auto_accept edit after everything was resolved clears a stale required gate (md + Neo4j mirror)", async () => {
  // Production incident shape: gate stuck at required/4 while every issue was resolved.
  const h = makeHarness(pageWithGate("required", 4));
  const queue = h.makeQueue({
    complete: true,
    confidence: 0.95,
    issues: [],
    action: "auto_accept",
  });
  const { taskId } = queue.submitWikiSave({
    path: PAGE_PATH,
    beforeRag: "# Lüsen\n\nWeek overview.",
    afterRag: "# Lüsen\n\nWeek overview, fixed.",
    diff: "---\n+++",
    structural: false,
    type: "document",
    topic: "events",
  });
  await h.untilDone(queue, taskId);

  const updated = h.files.get(PAGE_LOCAL)!;
  assert.match(updated, /review: clear/, "the stale required banner is cleared");
  assert.match(updated, /review_count: 0/, "the count resets to zero");
  assert.equal(h.mirrors.length, 1);
  assert.equal(h.mirrors[0]!.params.review, "clear");
  assert.equal(h.mirrors[0]!.params.reviewCount, 0);
});

test("an auto_accept edit without a previous required gate leaves the frontmatter untouched", async () => {
  const before = pageWithGate(undefined, undefined);
  const h = makeHarness(before);
  const queue = h.makeQueue({
    complete: true,
    confidence: 0.9,
    issues: [],
    action: "auto_accept",
  });
  const { taskId } = queue.submitWikiSave({
    path: PAGE_PATH,
    beforeRag: "# Lüsen\n\nWeek overview.",
    afterRag: "# Lüsen\n\nWeek overview, fixed.",
    diff: "---\n+++",
    structural: false,
  });
  await h.untilDone(queue, taskId);

  assert.equal(h.files.get(PAGE_LOCAL), before, "no gate fields are invented");
  assert.equal(h.mirrors.length, 0, "no graph mirror write without a gate change");
});
