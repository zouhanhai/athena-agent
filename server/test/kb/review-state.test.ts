import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WikiReviewStateService,
  validateAnchors,
  type WikiReviewIssue,
} from "../../src/kb/review-state.js";
import {
  WikiFrontmatterSyncer,
  parseWikiLifecycle,
  patchFrontmatter,
} from "../../src/kb/wiki-frontmatter.js";
import type { Neo4jDriverLike } from "../../src/kb/store/schema.js";

// --- G4.S8.T17: review/review_count frontmatter fields through the canonical syncer ---

test("patchFrontmatter writes review + review_count and the lifecycle parser reads them back", () => {
  const patched = patchFrontmatter(
    "---\ntype: document\ntitle: Lüsen\n---\n\nBody.",
    { review: "required", review_count: 2 },
  );
  assert.match(patched, /review: required/);
  assert.match(patched, /review_count: 2/);
  const lifecycle = parseWikiLifecycle({
    review: "required",
    review_count: "2",
  });
  assert.equal(lifecycle.review, "required");
  assert.equal(lifecycle.review_count, 2);
});

test("WikiFrontmatterSyncer.update mirrors review state onto the Neo4j Document node", async () => {
  const calls: Array<{ query: string; params?: Record<string, unknown> }> = [];
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
  const files = new Map<string, string>([
    ["/data/wiki/t/lusen.md", "---\ntype: document\nreview: required\nreview_count: 1\n---\n\nBody."],
  ]);
  const syncer = new WikiFrontmatterSyncer({
    wikiDir: "/data/wiki",
    readFile: async (p) => files.get(p) ?? "",
    writeFile: async (p, c) => void files.set(p, c),
    driver,
  });
  await syncer.update("wiki/t/lusen.md", { review: "clear", review_count: 0 });
  assert.match(files.get("/data/wiki/t/lusen.md")!, /review: clear/);
  assert.match(files.get("/data/wiki/t/lusen.md")!, /review_count: 0/);
  const mirror = calls.at(-1);
  assert.ok(mirror);
  assert.match(mirror.query, /d\.review = \$review/);
  assert.match(mirror.query, /d\.review_count = \$reviewCount/);
  assert.equal(mirror.params?.review, "clear");
  assert.equal(mirror.params?.reviewCount, 0);
});

// --- anchor validation (server-side re-check on every fetch) ---

test("validateAnchors flags quotes that no longer match the page body as unanchored", () => {
  const body = "# T\n\nThe Zustieg am Passo is unclear.\n\n## Hütte\n\nNice view.";
  const issues: WikiReviewIssue[] = [
    { id: "qi-1", message: "placeholder", anchor: { quote: "The Zustieg am Passo is unclear." }, resolved: false },
    { id: "qi-2", message: "edited away", anchor: { quote: "This text was REMOVED by an edit" }, resolved: false },
    { id: "qi-3", message: "no anchor at all", resolved: true },
  ];
  const validated = validateAnchors(issues, body);
  assert.deepEqual(
    validated.map((i) => i.anchored),
    [true, false, false],
  );
});

// --- the review-state service ---

interface ServiceHarness {
  service: WikiReviewStateService;
  files: Map<string, string>;
  qualityPath: string;
  pagePath: string;
}

function makeHarness(initialQuality?: unknown): ServiceHarness {
  const files = new Map<string, string>();
  const pagePath = "/data/wiki/t/lusen.md";
  const qualityPath = "/data/refinement/lusen/quality.json";
  files.set(
    pagePath,
    [
      "---",
      "type: document",
      "title: Lüsen",
      "review: required",
      "review_count: 2",
      "---",
      "",
      "Der   Zustieg am ?????   ist unklar.",
      "",
      "Zweite Ankerstelle hier.",
    ].join("\n"),
  );
  if (initialQuality !== null) {
    files.set(
      qualityPath,
      JSON.stringify(
        initialQuality ?? {
          action: "review_required",
          issues: [
            { id: "qi-1", message: "Placeholder left", anchor: { quote: "Der Zustieg am ????? ist unklar.", heading_path: "Lüsen" }, resolved: false },
            { id: "qi-2", message: "Caption missing", anchor: { quote: "Zweite Ankerstelle hier." }, resolved: false },
          ],
        },
      ),
    );
  }
  const syncer = new WikiFrontmatterSyncer({
    wikiDir: "/data/wiki",
    readFile: async (p) => files.get(p) ?? "",
    writeFile: async (p, c) => void files.set(p, c),
  });
  const service = new WikiReviewStateService({
    readPage: async () => files.get(pagePath)!,
    refinementRoots: ["/data/refinement"],
    readFile: async (p) => {
      const hit = files.get(p);
      if (hit === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return hit;
    },
    writeFile: async (p, c) => void files.set(p, c),
    syncer,
  });
  return { service, files, qualityPath, pagePath };
}

test("get returns the frontmatter review fields + issues with anchors validated against the current content", async () => {
  const { service } = makeHarness();
  const state = await service.get("wiki/t/lusen.md");
  assert.ok(state);
  assert.equal(state.review, "required");
  assert.equal(state.review_count, 2);
  // whitespace-normalized matching still finds both anchors
  assert.deepEqual(state.issues.map((i) => i.anchored), [true, true]);
  assert.equal(state.issues[0]!.anchor?.heading_path, "Lüsen");
});

test("get degrades stale anchors to unanchored instead of dropping the issue", async () => {
  const harness = makeHarness();
  harness.files.set(
    harness.pagePath,
    harness.files.get(harness.pagePath)!.replace("Zweite Ankerstelle hier.", "Dieser Satz wurde komplett umformuliert."),
  );
  const state = await harness.service.get("wiki/t/lusen.md");
  assert.ok(state);
  const second = state.issues.find((i) => i.id === "qi-2");
  assert.ok(second);
  assert.equal(second!.anchored, false);
  // the issue is NOT dropped
  assert.equal(state.issues.length, 2);
});

test("get returns a null review when the page has no review frontmatter and no quality.json", async () => {
  const harness = makeHarness(null);
  harness.files.set(harness.pagePath, "---\ntype: document\n---\n\nClean body.");
  const state = await harness.service.get("wiki/t/lusen.md");
  assert.ok(state);
  assert.equal(state.review, undefined);
  assert.deepEqual(state.issues, []);
});

test("resolve flips the issue, decrements review_count, and clears review when all are resolved", async () => {
  const { service, files, qualityPath } = makeHarness();
  const result = await service.apply("wiki/t/lusen.md", "qi-1", "resolve");
  assert.equal(result.review_count, 1);
  assert.equal(result.review, "required");
  // quality.json updated in place
  const persisted = JSON.parse(files.get(qualityPath)!) as { issues: WikiReviewIssue[] };
  assert.equal(persisted.issues[0]!.resolved, true);
  // frontmatter updated through the syncer
  const page = files.get("/data/wiki/t/lusen.md")!;
  assert.match(page, /review_count: 1/);
  assert.match(page, /review: required/);

  const cleared = await service.apply("wiki/t/lusen.md", "qi-2", "resolve");
  assert.equal(cleared.review_count, 0);
  assert.equal(cleared.review, "clear");
  assert.match(files.get("/data/wiki/t/lusen.md")!, /review: clear/);
});

test("reopen puts an issue back to unresolved and restores review_required", async () => {
  const { service } = makeHarness({
    action: "review_required",
    issues: [
      { id: "qi-1", message: "a", resolved: true },
      { id: "qi-2", message: "b", resolved: true },
    ],
  });
  const result = await service.apply("wiki/t/lusen.md", "qi-2", "reopen", "still wrong after edit");
  assert.equal(result.review_count, 1);
  assert.equal(result.review, "required");
  const reopened = result.issues.find((i) => i.id === "qi-2");
  assert.equal(reopened!.resolved, false);
  assert.equal(reopened!.note, "still wrong after edit");
});

test("apply rejects unknown issue ids with a NotFound-style error", async () => {
  const { service } = makeHarness();
  await assert.rejects(() => service.apply("wiki/t/lusen.md", "nope", "resolve"), /unknown issue/i);
});

test("apply on a page without quality.json surfaces a clear error", async () => {
  const { service } = makeHarness(null);
  await assert.rejects(() => service.apply("wiki/t/lusen.md", "qi-1", "resolve"), /quality/i);
});
