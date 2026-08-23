import { test } from "node:test";
import assert from "node:assert/strict";
import { ContentDedupStore } from "../../src/kb/dedup.js";
import { KnowledgeIngestService } from "../../src/kb/ingest.js";
import type { LlmWikiClient } from "../../src/kb/llmwiki.js";

/**
 * G4.S8.T20 ⑤ — dedup purge: after deleting a wiki page, re-uploading the SAME
 * file must NOT be short-circuited as a duplicate.
 *
 * Regression shape (the live "dedup zombie"): ContentDedupStore.ensureSeeded
 * registers pages under their FULL wiki path ("wiki/events/X.pdf.md") while the
 * ingest queue records under bare basenames — so deleteDocument must purge ALL
 * key variants (bare, bare+".md", full path), or a post-restart seed keeps the
 * deleted page's hash alive and every re-upload is marked duplicate.
 */

const PAGE_PATH = "wiki/events/Sommerseminar-Mallorca-2023.pdf.md";
const PAGE_CONTENT = "# Sommerseminar Mallorca 2023\n\nAgenda, hotel, and travel notes.";

function makeService(dedup: ContentDedupStore): KnowledgeIngestService {
  const llmwiki = {
    listProjects: async () => ({ projects: [{ id: "p1", path: "/tmp/llm-wiki" }], currentProject: null }),
    deleteFile: async () => ({}),
  } as unknown as LlmWikiClient;
  return new KnowledgeIngestService({
    llmwiki,
    rebuildIndex: async () => {},
    // Graph cascade stub: nothing to delete in the graph for this test.
    graph: {
      deleteDocumentsForWikiPage: async () => ({
        documentsRemoved: 0,
        chunksRemoved: 0,
        sectionsRemoved: 0,
        entitiesRemoved: 0,
        entitiesRetained: 0,
        mdRefs: [],
      }),
    },
    dedup,
  });
}

test("deleteDocument purges the seeded FULL-PATH dedup key so the same file can be re-uploaded", async () => {
  // Post-restart state: the store seeded itself from llm_wiki pages using full paths.
  const store = new ContentDedupStore({
    loadExisting: async () => [{ path: PAGE_PATH, content: PAGE_CONTENT }],
  });
  const service = makeService(store);

  const before = await store.check(PAGE_CONTENT);
  assert.equal(before.duplicate, true, "precondition: the seeded page is detected as duplicate");
  assert.equal(before.existingSource, PAGE_PATH);

  await service.deleteDocument(PAGE_PATH);

  const after = await store.check(PAGE_CONTENT);
  assert.deepEqual(after, { duplicate: false }, "re-uploading the same file is NOT treated as a duplicate");
  assert.equal(store.size(), 0);
});

test("deleteDocument purges every recorded key variant (queue bare-name keys + .md variant)", async () => {
  const store = new ContentDedupStore({ loadExisting: async () => [] });
  const service = makeService(store);

  // The ingest queue records under basename-derived keys (tasks.ts record path).
  await store.record(PAGE_CONTENT, "Sommerseminar-Mallorca-2023.pdf");
  await store.record(`${PAGE_CONTENT}\n\nvariant`, "Sommerseminar-Mallorca-2023.pdf.md");

  await service.deleteDocument(PAGE_PATH);

  assert.equal(await store.check(PAGE_CONTENT).then((r) => r.duplicate), false, "bare key purged");
  assert.equal(
    await store.check(`${PAGE_CONTENT}\n\nvariant`).then((r) => r.duplicate),
    false,
    "bare + .md key purged",
  );
});
