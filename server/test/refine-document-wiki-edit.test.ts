import { test } from "node:test";
import assert from "node:assert/strict";
import type { RefineLlmCaller } from "../src/agents/refine-document.js";
import {
  WIKI_EDIT_REFINE_SYSTEM_PROMPT,
  buildWikiEditRefinePrompt,
  extractWikiEditRefinement,
  fallbackWikiEditRefinement,
  normalizeWikiEditRefinement,
  runWikiEditRefine,
  type WikiEditRefinement,
  type WikiEditRefineInput,
} from "../src/agents/refine-document.js";

const sampleWikiEdit: WikiEditRefinement = {
  markdown: "# Runbook\n\nThe image shows a dark sky.\n\nSteps here.",
  summary: "The corrected runbook.",
  sections: [{ title: "Runbook", summary: "The corrected runbook." }],
  frontmatter: { type: "concept", topic: "ops" },
  chunks: [
    { id: "c1", text: "# Runbook\n\nThe image shows a dark sky.", heading_path: "Runbook" },
    { id: "c2", text: "Steps here.", heading_path: "Runbook" },
  ],
  entities: [
    { name: "CALEO", type: "org", description: "An organization" },
    { name: "ZOB München", type: "location", description: "The corrected place name" },
  ],
  relations: [
    { source: "CALEO", target: "ZOB München", keywords: ["organisiert"], description: "CALEO runs the ZOB." },
  ],
  keywords: ["runbook", "zob"],
  new_entities: [{ name: "ZOB München", type: "location", description: "The corrected place name" }],
  new_relations: [
    { source: "CALEO", target: "ZOB München", keywords: ["organisiert"], description: "CALEO runs the ZOB." },
  ],
  rechunked: false,
  quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
};

function makeCaller(opts: {
  throws?: Error;
  payload?: Record<string, unknown>;
  contentText?: string;
} = {}): { caller: RefineLlmCaller; prompts: string[]; efforts: Array<string | undefined> } {
  const prompts: string[] = [];
  const efforts: Array<string | undefined> = [];
  // G4.S8.T16: wiki-edit runs on the DIRECT transport — a plain JSON text response.
  const caller: RefineLlmCaller = async (ctx) => {
    prompts.push(ctx.userContent);
    efforts.push(ctx.reasoningEffort);
    if (opts.throws) throw opts.throws;
    const content = opts.contentText ?? JSON.stringify(opts.payload ?? sampleWikiEdit);
    return {
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
      message: { role: "assistant", content: [{ type: "text", text: content }] },
    };
  };
  return { caller, prompts, efforts };
}

const input: WikiEditRefineInput = {
  markdown: "# Runbook\n\nThe image shows a dark sky.\n\nSteps here.",
  before: "# Runbook\n\nThe image shows a bright sky.\n\nSteps here.",
  diff: "@@ -1,3 +1,3 @@\n-The image shows a bright sky.\n+The image shows a dark sky.\n",
  structural: false,
};

test("runWikiEditRefine sends the corrected text + diff and preserves the corrected markdown verbatim", async () => {
  const { caller, prompts } = makeCaller();
  const { document } = await runWikiEditRefine(input, { type: "concept", topic: "ops" }, { httpCaller: caller });

  const prompt = prompts[0]!;
  assert.ok(prompt.includes("# Runbook\n\nThe image shows a dark sky."), "corrected text present");
  assert.ok(prompt.includes("The image shows a bright sky."), "previous version present");
  assert.ok(prompt.includes("-The image shows a bright sky."), "diff present");
  assert.ok(prompt.includes("+The image shows a dark sky."), "diff additions present");
  assert.ok(prompt.includes("structural (heading structure changed): false"));
  assert.ok(prompt.includes("existing topic: ops"));

  // The corrected markdown is emitted verbatim (the emit contract returns it).
  assert.equal(document.markdown, sampleWikiEdit.markdown);
});

test("runWikiEditRefine surfaces the flagged NEW entities/relations + the re-chunk decision", async () => {
  const { caller } = makeCaller();
  const { document } = await runWikiEditRefine(input, undefined, { httpCaller: caller });
  assert.deepEqual(document.new_entities.map((e) => e.name), ["ZOB München"]);
  assert.deepEqual(document.new_relations.map((r) => [r.source, r.target]), [["CALEO", "ZOB München"]]);
  assert.equal(document.rechunked, false);
});

test("normalizeWikiEditRefinement tolerates JSON-string args and defaulted fields", () => {
  const doc = normalizeWikiEditRefinement(JSON.stringify({ ...sampleWikiEdit, rechunked: true }));
  assert.equal(doc.rechunked, true);
  assert.equal(doc.new_entities.length, 1);
  assert.equal(doc.rechunked, true);
  const minimal = normalizeWikiEditRefinement({ markdown: "# X", summary: "", sections: [], frontmatter: { type: "a", topic: "b" }, chunks: [], entities: [], relations: [], keywords: [], quality: { complete: true, confidence: 1, issues: [], action: "auto_accept" } });
  assert.deepEqual(minimal.new_entities, []);
  assert.deepEqual(minimal.new_relations, []);
  assert.equal(minimal.rechunked, false);
});

test("extractWikiEditRefinement accepts plain-text JSON too", () => {
  const doc = extractWikiEditRefinement({
    role: "assistant",
    content: [{ type: "text", text: JSON.stringify(sampleWikiEdit) }],
  });
  assert.equal(doc.markdown, sampleWikiEdit.markdown);
  assert.equal(doc.rechunked, false);
});

test("extractWikiEditRefinement throws when there is no structured output", () => {
  assert.throws(
    () => extractWikiEditRefinement({ role: "assistant", content: [{ type: "text", text: "sorry" }] }),
    /no structured output/,
  );
});

test("runWikiEditRefine retries before giving up and throws on persistent failure", async () => {
  let calls = 0;
  const caller: RefineLlmCaller = async () => {
    calls += 1;
    throw new Error("boom");
  };
  await assert.rejects(runWikiEditRefine(input, undefined, { httpCaller: caller }), /boom/);
  assert.equal(calls, 4, "default retries=3 → up to 4 attempts");
});

test("buildWikiEditRefinePrompt includes the retry nudge after the first attempt", () => {
  const first = buildWikiEditRefinePrompt(input, undefined, 1);
  assert.ok(!first.includes("retry 1"));
  const retry = buildWikiEditRefinePrompt(input, undefined, 2);
  assert.ok(retry.includes("[retry 1]"));
});

test("the incremental prompt now uses DELTA mode: no full-markdown dump, extraction only", () => {
  assert.match(WIKI_EDIT_REFINE_SYSTEM_PROMPT, /DO NOT re-emit the corrected markdown/i);
  assert.match(WIKI_EDIT_REFINE_SYSTEM_PROMPT, /source of truth/i);
  assert.match(WIKI_EDIT_REFINE_SYSTEM_PROMPT, /Output ONLY the EXTRACTION fields/i);
  assert.match(WIKI_EDIT_REFINE_SYSTEM_PROMPT, /new_entities \/ new_relations/);
});

test("fallbackWikiEditRefinement keeps the corrected text, derives chunks from headings and flags review", () => {
  const fallback = fallbackWikiEditRefinement(
    { ...input, structural: false },
    { type: "concept", topic: "ops" },
    new Error("athena down"),
  );
  assert.equal(fallback.markdown, input.markdown, "corrected text preserved verbatim");
  assert.equal(fallback.frontmatter.type, "concept");
  assert.equal(fallback.frontmatter.topic, "ops");
  assert.ok(fallback.chunks.length >= 1, "chunks derived from heading structure");
  assert.deepEqual(fallback.entities, []);
  assert.deepEqual(fallback.new_entities, []);
  assert.equal(fallback.rechunked, false, "a localized edit keeps the chunk structure");
  assert.equal(fallback.quality.action, "review_required");
  assert.match(fallback.quality.issues.join(" "), /athena down/);
});

test("fallbackWikiEditRefinement marks a structural edit for re-chunking", () => {
  const fallback = fallbackWikiEditRefinement({ ...input, structural: true }, undefined, new Error("down"));
  assert.equal(fallback.rechunked, true);
});
