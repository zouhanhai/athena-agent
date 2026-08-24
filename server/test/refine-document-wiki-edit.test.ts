import { test } from "node:test";
import assert from "node:assert/strict";
import type { RefineLlmCaller } from "../src/agents/refine-document.js";
import {
  WIKI_EDIT_REFINE_SYSTEM_PROMPT,
  buildWikiEditRefinePrompt,
  extractWikiEditRefinement,
  fallbackWikiEditRefinement,
  normalizeWikiEditDelta,
  resolveWikiEditRefinement,
  runWikiEditRefine,
  type WikiEditRefineInput,
} from "../src/agents/refine-document.js";

/**
 * G4.S10.T4 contract: the wiki-edit refine emits an ENTITY DELTA over the
 * KNOWN ENTITIES baseline (renames/added/removed/changed_relations). These
 * tests pin the prompt contract + extraction/resolution behavior.
 */

// Delta-mode payload: NO full entity list re-emission — only the delta.
const sampleWikiDelta = {
  summary: "The corrected runbook.",
  sections: [{ title: "Runbook", summary: "The corrected runbook." }],
  frontmatter: { type: "concept", topic: "ops" },
  renames: [{ from: "GALILEO Office", to: "ZOB München", type_match: true, reason: "image description corrected" }],
  added: [{ name: "ZOB München", type: "location", description: "The corrected place name" }],
  removed: ["Ghost Spa"],
  changed_relations: [
    { source: "CALEO", target: "ZOB München", keywords: ["organisiert"], description: "CALEO runs the ZOB." },
  ],
  keywords: ["runbook", "zob"],
  rechunked: false,
  quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
};

const KNOWN_ENTITIES = [
  { name: "CALEO", type: "org", description: "An organization" },
  { name: "GALILEO Office", type: "location", description: "Office at Galileostraße." },
  { name: "Ghost Spa", type: "other", description: "stale place" },
];

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
    const content = opts.contentText ?? JSON.stringify(opts.payload ?? sampleWikiDelta);
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

test("runWikiEditRefine sends the corrected text + diff and resolves over the KNOWN ENTITIES baseline", async () => {
  const { caller, prompts } = makeCaller();
  const { document } = await runWikiEditRefine(
    { ...input, known_entities: KNOWN_ENTITIES },
    { type: "concept", topic: "ops" },
    { httpCaller: caller },
  );

  const prompt = prompts[0]!;
  assert.ok(prompt.includes("# Runbook\n\nThe image shows a dark sky."), "corrected text present");
  assert.ok(prompt.includes("The image shows a bright sky."), "previous version present");
  assert.ok(prompt.includes("-The image shows a bright sky."), "diff present");
  assert.ok(prompt.includes("+The image shows a dark sky."), "diff additions present");
  assert.ok(prompt.includes("structural (heading structure changed): false"));
  assert.ok(prompt.includes("existing topic: ops"));

  // G4.S10.T4 resolution: rename applied over the baseline, unmentioned CALEO
  // implicitly kept, removal honored (Ghost Spa absent from the corrected text).
  const names = (document.entities ?? []).map((e) => e.name).sort();
  assert.deepEqual(names, ["CALEO", "ZOB München"]);
  const renamed = document.entities!.find((e) => e.name === "ZOB München")!;
  assert.equal(renamed.type, "location");
  assert.ok((renamed.aliases ?? []).some((a) => a.toUpperCase() === "GALILEO OFFICE"), "old name rides along as alias");
  assert.deepEqual(document.entity_renames ?? [], [{ from: "GALILEO Office", to: "ZOB München" }]);
});

test("runWikiEditRefine surfaces the DELTA as new_entities/new_relations + the re-chunk decision", async () => {
  const { caller } = makeCaller();
  const { document } = await runWikiEditRefine(input, undefined, { httpCaller: caller });
  assert.deepEqual(document.new_entities.map((e) => e.name), ["ZOB München"]);
  assert.deepEqual(document.new_relations.map((r) => [r.source, r.target]), [["CALEO", "ZOB München"]]);
  assert.equal(document.rechunked, false);
});

test("resolveWikiEditRefinement tolerates JSON-string payloads and defaulted delta fields", () => {
  const doc = resolveWikiEditRefinement(JSON.stringify({ ...sampleWikiDelta, rechunked: true }), [], "");
  assert.equal(doc.rechunked, true);
  assert.equal(doc.new_entities.length, 1);
  const minimal = resolveWikiEditRefinement(
    { summary: "", sections: [], frontmatter: { type: "a", topic: "b" }, chunks: [], renames: [], added: [], removed: [], changed_relations: [], keywords: [], quality: { complete: true, confidence: 1, issues: [], action: "auto_accept" } },
    [],
    "",
  );
  assert.deepEqual(minimal.new_entities, []);
  assert.deepEqual(minimal.new_relations, []);
  assert.deepEqual(minimal.entities, []);
  assert.equal(minimal.rechunked, false);
});

test("extractWikiEditRefinement returns the RAW structured payload (tool args or text JSON)", () => {
  const raw = extractWikiEditRefinement({
    role: "assistant",
    content: [{ type: "text", text: JSON.stringify(sampleWikiDelta) }],
  });
  assert.equal(normalizeWikiEditDelta(raw).added.length, 1);
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

test("the incremental prompt is DELTA-over-BASELINE: no markdown dump, no full entity list", () => {
  assert.match(WIKI_EDIT_REFINE_SYSTEM_PROMPT, /DO NOT re-emit the corrected markdown/i);
  assert.match(WIKI_EDIT_REFINE_SYSTEM_PROMPT, /source of truth/i);
  assert.match(WIKI_EDIT_REFINE_SYSTEM_PROMPT, /renames[\s\S]*added[\s\S]*removed[\s\S]*changed_relations/);
  assert.match(WIKI_EDIT_REFINE_SYSTEM_PROMPT, /implicitly KEPT|implicit keep/i);
  assert.match(
    WIKI_EDIT_REFINE_SYSTEM_PROMPT,
    /do NOT re-emit\s+the baseline entity list/i,
    "full-entity re-emission invites drift — the T4 regression",
  );
});

test("G4.S8.T20: the USER prompt is delta-mode too — it never asks the model to re-emit the markdown or the entity list", () => {
  const prompt = buildWikiEditRefinePrompt(input, undefined, 1);
  assert.doesNotMatch(
    prompt,
    /emit the corrected markdown/i,
    "asking for verbatim re-emission invites the pre-delta truncation failure (system prompt forbids it)",
  );
  assert.match(prompt, /do not re-emit/i, "user prompt carries the same extraction-only contract");
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
