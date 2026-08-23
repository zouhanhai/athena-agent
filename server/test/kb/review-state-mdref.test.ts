import { test } from "node:test";
import assert from "node:assert/strict";
import { WikiReviewStateService } from "../../src/kb/review-state.js";
import { WikiFrontmatterSyncer } from "../../src/kb/wiki-frontmatter.js";

/**
 * G4.S8.T18 ③② — review-state resolution unification: quality.json is looked
 * up NEXT TO the Neo4j Document.md_ref FIRST; basename matching stays as the
 * fallback for pages whose refine dir diverges from the wiki stem.
 */

const PAGE = ["---", "type: document", "title: Mallorca", "---", "", "Body."].join("\n");

function makeService(
  files: Map<string, string>,
  mdRef: string | null,
  lastEditRef: string | null = null,
): WikiReviewStateService {
  const syncer = new WikiFrontmatterSyncer({
    wikiDir: "/data/wiki",
    readFile: async (p) => files.get(p) ?? "",
    writeFile: async (p, c) => void files.set(p, c),
  });
  return new WikiReviewStateService({
    readPage: async () => files.get("/data/wiki/t/mallorca.md")!,
    refinementRoots: ["/data/refinement"],
    readFile: async (p) => {
      const hit = files.get(p);
      if (hit === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return hit;
    },
    syncer,
    // The graph seam: returns the EXACT refine markdown recorded on Document.md_ref.
    resolveMdRef: async () => mdRef,
    // G4.S8.T21: the wiki-edit overwrite persists Document.last_edit_ref; the
    // freshest refinement (the edit's own output dir) must win over the stale
    // original md_ref dir so the review UI serves POST-edit issues.
    resolveLastEditRef: async () => lastEditRef,
  });
}

test("GET resolves issues via Document.md_ref when the refine dir name diverges from the wiki stem", async () => {
  const files = new Map<string, string>([
    ["/data/wiki/t/mallorca.md", PAGE],
    [
      "/data/refinement/sommerseminar-mallorca-2023/quality.json",
      JSON.stringify({
        action: "review_required",
        issues: [{ id: "qi-1", message: "Placeholder left", anchor: { quote: "Der Zustieg am ????? war offen." }, resolved: false }],
      }),
    ],
  ]);
  const service = makeService(
    files,
    "/data/refinement/sommerseminar-mallorca-2023/markdown.md",
  );
  const view = await service.get("wiki/t/mallorca.md");
  assert.equal(view.review_count, 1);
  assert.equal(view.issues[0]!.message, "Placeholder left");
});

test("basename matching remains the fallback when the graph has no md_ref / the dir is gone", async () => {
  const files = new Map<string, string>([
    ["/data/wiki/t/mallorca.md", PAGE],
    [
      "/data/refinement/mallorca/quality.json",
      JSON.stringify({
        action: "review_required",
        issues: [{ id: "qi-9", message: "Legacy match", resolved: false }],
      }),
    ],
  ]);
  // null md_ref → basename fallback must still find /data/refinement/mallorca/.
  const service = makeService(files, null);
  const view = await service.get("wiki/t/mallorca.md");
  assert.equal(view.review_count, 1);
  assert.equal(view.issues[0]!.id, "qi-9");

  // md_ref pointing at a deleted dir → falls back too.
  const stale = makeService(
    new Map<string, string>([
      ["/data/wiki/t/mallorca.md", PAGE],
      [
        "/data/refinement/mallorca/quality.json",
        JSON.stringify({ action: "review_required", issues: [{ id: "qi-9", message: "Legacy match", resolved: false }] }),
      ],
    ]),
    "/data/refinement/sommerseminar-mallorca-2023/markdown.md",
  );
  const staleView = await stale.get("wiki/t/mallorca.md");
  assert.equal(staleView.issues[0]!.id, "qi-9");
});

test("GET resolves the wiki-edit refinement's quality.json via Document.last_edit_ref (post-edit issues)", async () => {
  // Upload produced 2 issues (original refine dir, still referenced by md_ref);
  // the wiki-edit overwrite re-derived quality with 3 issues (2 known + 1 new)
  // under the wiki-edit dir. GET must serve the POST-edit list.
  const files = new Map<string, string>([
    ["/data/wiki/t/mallorca.md", PAGE],
    [
      "/data/refinement/sommerseminar-mallorca-2023/quality.json",
      JSON.stringify({
        action: "review_required",
        issues: [
          { id: "qi-1", message: "Upload issue one", resolved: false },
          { id: "qi-2", message: "Upload issue two", resolved: false },
        ],
      }),
    ],
    [
      "/data/refinement/wiki-edit-sommerseminar-mallorca-2023/quality.json",
      JSON.stringify({
        action: "review_required",
        issues: [
          { id: "qi-1", message: "Upload issue one", resolved: false },
          { id: "qi-2", message: "Upload issue two", resolved: false },
          { id: "qi-3", message: "NEW post-edit issue", resolved: false },
        ],
      }),
    ],
  ]);
  const service = makeService(
    files,
    "/data/refinement/sommerseminar-mallorca-2023/markdown.md",
    "/data/refinement/wiki-edit-sommerseminar-mallorca-2023/markdown.md",
  );
  const view = await service.get("wiki/t/mallorca.md");
  assert.equal(view.issues.length, 3, "the POST-edit issue list is served");
  assert.ok(
    view.issues.some((i) => i.id === "qi-3" && i.message === "NEW post-edit issue"),
    "the issue added by the edit is surfaced",
  );
});

test("without last_edit_ref the original md_ref dir still resolves (T18 protection intact)", async () => {
  const files = new Map<string, string>([
    ["/data/wiki/t/mallorca.md", PAGE],
    [
      "/data/refinement/sommerseminar-mallorca-2023/quality.json",
      JSON.stringify({
        action: "review_required",
        issues: [{ id: "qi-1", message: "Upload issue one", resolved: false }],
      }),
    ],
  ]);
  const service = makeService(
    files,
    "/data/refinement/sommerseminar-mallorca-2023/markdown.md",
    null,
  );
  const view = await service.get("wiki/t/mallorca.md");
  assert.equal(view.issues.length, 1);
  assert.equal(view.issues[0]!.id, "qi-1");
});
