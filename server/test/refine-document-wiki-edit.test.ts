import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  EMIT_WIKI_EDIT_REFINE_TOOL,
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

function makeRuntime(opts: {
  completeThrows?: Error;
  toolCallArgs?: Record<string, unknown>;
  contentText?: string;
} = {}): { runtime: ModelRuntime; prompts: string[] } {
  const prompts: string[] = [];
  const runtime = {
    async completeSimple(
      model: { provider: string; id: string },
      context: { systemPrompt?: string; messages: unknown[]; tools: unknown[] },
      options: unknown,
    ) {
      prompts.push((context.messages[0] as { content: string }).content);
      if (opts.completeThrows) throw opts.completeThrows;
      const content = opts.contentText ?? JSON.stringify(opts.toolCallArgs ?? sampleWikiEdit);
      return {
        role: "assistant",
        content: opts.contentText
          ? [{ type: "text", text: content }]
          : [
              {
                type: "toolCall",
                id: "t1",
                name: EMIT_WIKI_EDIT_REFINE_TOOL,
                arguments: opts.toolCallArgs ?? sampleWikiEdit,
              },
            ],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
        stopReason: "stop",
        timestamp: 1,
      };
    },
  } as unknown as ModelRuntime;
  return { runtime, prompts };
}

const input: WikiEditRefineInput = {
  markdown: "# Runbook\n\nThe image shows a dark sky.\n\nSteps here.",
  before: "# Runbook\n\nThe image shows a bright sky.\n\nSteps here.",
  diff: "@@ -1,3 +1,3 @@\n-The image shows a bright sky.\n+The image shows a dark sky.\n",
  structural: false,
};

const model = { provider: "athena", id: "~deepseek/deepseek-v4-flash-latest" } as never;

test("runWikiEditRefine sends the corrected text + diff and preserves the corrected markdown verbatim", async () => {
  const { runtime, prompts } = makeRuntime();
  const { document } = await runWikiEditRefine(runtime, model, input, { type: "concept", topic: "ops" });

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
  const { runtime } = makeRuntime();
  const { document } = await runWikiEditRefine(runtime, model, input);
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
  const { runtime } = makeRuntime({ completeThrows: new Error("boom") });
  await assert.rejects(runWikiEditRefine(runtime, model, input), /boom/);
});

test("buildWikiEditRefinePrompt includes the retry nudge after the first attempt", () => {
  const first = buildWikiEditRefinePrompt(input, undefined, 1);
  assert.ok(!first.includes("retry 1"));
  const retry = buildWikiEditRefinePrompt(input, undefined, 2);
  assert.ok(retry.includes("[retry 1]"));
});

test("the incremental prompt instructs preserving the manual edit verbatim", () => {
  assert.match(WIKI_EDIT_REFINE_SYSTEM_PROMPT, /PRESERVE THE USER'S EDIT/i);
  assert.match(WIKI_EDIT_REFINE_SYSTEM_PROMPT, /NEVER rewrite/i);
  assert.match(WIKI_EDIT_REFINE_SYSTEM_PROMPT, /rechunked=false/);
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
