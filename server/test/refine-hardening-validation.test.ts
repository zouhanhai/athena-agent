import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RefinedDocument, RefinedDocumentDelta, RefineLlmCaller } from "../src/agents/refine-document.js";
import {
  HEADER_LEVELS_SCHEMA,
  REFINED_DOCUMENT_SCHEMA,
  createRefineDocumentTool,
  runWikiEditRefine,
  validateRefineDelta,
} from "../src/agents/refine-document.js";
import { refineReasoningFor } from "../src/agents/refine-reasoning.js";
import { callOpenRouter, resolveRefineProviderIgnore, type OpenRouterCallParams } from "../src/agents/llm-direct.js";

/**
 * G4.S8.T16 — refine hardening: cross-field delta validation + repair loop,
 * unified reasoning strategy across the direct-OpenRouter and Pi-runtime paths,
 * and provider exclusion on the direct request body.
 */

const zeroUsage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function validDelta(overrides: Partial<RefinedDocumentDelta> = {}): RefinedDocumentDelta {
  return {
    summary: "CALEO Sommerseminar schedule.",
    sections: [{ title: "Sommerseminar", summary: "The annual event." }],
    frontmatter: { type: "event", topic: "internal/events" },
    entities: [
      { name: "CALEO", type: "org", description: "The organizer." },
      { name: "Mallorca", type: "location", description: "The venue island." },
    ],
    relations: [{ source: "CALEO", target: "Mallorca", keywords: ["hosts"], description: "CALEO hosts in Mallorca." }],
    keywords: ["sommerseminar"],
    quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
    patches: [],
    ...overrides,
  };
}

const SOURCE_MD = "# CALEO Sommerseminar\n\n## Arrival\n\nPickup at Palma airport.\n\n## Workshops\n\nFour workshops.";

// --- validateRefineDelta: cross-field checks ---

test("validateRefineDelta accepts a consistent delta (no errors)", () => {
  assert.deepEqual(validateRefineDelta(validDelta(), SOURCE_MD), []);
});

test("validateRefineDelta flags relation endpoints not among declared entities (whitespace-normalized)", () => {
  const delta = validDelta({
    relations: [
      { source: "CALEO", target: "Palma  Airport", keywords: ["located"], description: "venue" },
      { source: " Ghost Entity ", target: "Mallorca", keywords: ["near"], description: "d" },
    ],
  });
  const errors = validateRefineDelta(delta, SOURCE_MD);
  assert.equal(errors.length, 2);
  assert.match(errors[0]!, /relation .*target.*"Palma  Airport"/i);
  assert.match(errors[1]!, /relation .*source.*"Ghost Entity"/i);
});

test("validateRefineDelta is case-insensitive + whitespace-collapsing when matching endpoints (nameUpper closed world)", () => {
  const delta = validDelta({
    entities: [
      { name: "ZOB München", type: "location", description: "bus station" },
      { name: "CALEO", type: "org", description: "organizer" },
    ],
    relations: [{ source: "zob münchEN", target: "CALEO", keywords: ["serves"], description: "d" }],
  });
  assert.deepEqual(validateRefineDelta(delta, SOURCE_MD), [], "casing/spacing drift must NOT be a validation error (ingest folds via nameUpper)");
});

test("validateRefineDelta flags empty source/target endpoint strings", () => {
  const delta = validDelta({
    entities: [],
    relations: [{ source: "", target: "X", keywords: [], description: "d" }],
  });
  const errors = validateRefineDelta(delta, SOURCE_MD);
  assert.ok(errors.some((e) => /empty/i.test(e) && /source/i.test(e)));
});

test("validateRefineDelta flags relations declared with an EMPTY entities array (the Lüsen failure)", () => {
  const delta = validDelta({
    entities: [],
    relations: [{ source: "A", target: "B", keywords: ["x"], description: "d" }],
  });
  const errors = validateRefineDelta(delta, SOURCE_MD);
  assert.ok(errors.some((e) => /entities .* empty|non-empty/i.test(e)), `got: ${JSON.stringify(errors)}`);
});

test("validateRefineDelta validates issue-anchor quotes exist in the source markdown (T17 contract)", () => {
  const delta = validDelta({
    quality: {
      complete: true,
      confidence: 0.9,
      issues: ["caption missing"],
      action: "review_required",
      issue_anchors: [
        { message: "caption missing", quote: "Pickup at Palma airport." },
        { message: "garbled", quote: "THIS QUOTE IS NOWHERE IN THE DOC" },
      ],
    },
  });
  const errors = validateRefineDelta(delta, SOURCE_MD);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /anchor quote/i);
  assert.match(errors[0]!, /THIS QUOTE IS NOWHERE IN THE DOC/i);
});

test("validateRefineDelta validates frontmatter type/topic per taxonomy", () => {
  const errors = validateRefineDelta(validDelta({ frontmatter: { type: "newsletter", topic: "internal/events" } }), SOURCE_MD);
  assert.ok(errors.some((e) => /frontmatter\.type/.test(e) && /newsletter/.test(e)));

  const badTopic = validateRefineDelta(validDelta({ frontmatter: { type: "event", topic: "recipes/cakes" } }), SOURCE_MD);
  assert.ok(badTopic.some((e) => /frontmatter\.topic/.test(e) && /recipes/.test(e)));
});

// --- repair loop: invalid delta → error-fed retry → passes; exhausts → fallback ---

interface CallRecord {
  systemPrompt?: string;
  userContent: string;
  schema?: unknown;
}

function makeSequenceCaller(responses: unknown[]): { caller: RefineLlmCaller; calls: CallRecord[] } {
  const calls: CallRecord[] = [];
  let i = 0;
  const caller: RefineLlmCaller = async (ctx) => {
    calls.push({ ...ctx });
    const text = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      usage: zeroUsage,
      message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(text) }] },
    };
  };
  return { caller, calls };
}

function fakeStore(recorder: { stored?: RefinedDocument; fallback?: boolean } = {}) {
  return async (doc: RefinedDocument): Promise<RefinedDocument> => {
    recorder.stored = doc;
    return doc as never;
  };
}

const GOOD_DELTA = validDelta();

test("repair loop: first delta violates cross-field constraints → model re-invoked WITH the error list → second delta accepted", async () => {
  const badDelta = validDelta({
    entities: [GOOD_DELTA.entities[0]!],
    relations: [{ source: "CALEO", target: "GHOST HOTEL", keywords: ["nearby"], description: "d" }],
  });
  const { caller, calls } = makeSequenceCaller([badDelta, GOOD_DELTA]);
  const tool = createRefineDocumentTool({} as ModelRuntime, {
    httpCaller: caller,
    storageDir: "storage",
    storeImpl: fakeStore(),
  });

  const result = await tool.execute("c", { markdown: SOURCE_MD }, undefined, undefined, {} as never);
  const details = result.details as { fallback?: boolean; validationRetries?: Array<{ attempt: number; errors: string[] }> };

  assert.equal(details.fallback, undefined, "repair loop recovered within bounds — no fallback");
  assert.equal(calls.length, 2, "one re-invocation after the validation failure");
  const retryPrompt = calls[1]!.userContent;
  assert.match(retryPrompt, /\[validation retry 1\]/i, "retry prompt marks the validation repair");
  assert.match(retryPrompt, /GHOST HOTEL/, "retry prompt carries the SPECIFIC validation error");
  assert.deepEqual(details.validationRetries?.map((r) => r.errors.length), [1], "each retry logged with its error list");
});

test("repair loop: bounded at 2 retries → exhaustion throws → deterministic fallbackRefinement runs", async () => {
  const badDelta = validDelta({ entities: [], relations: [{ source: "A", target: "B", keywords: [], description: "d" }] });
  const { caller, calls } = makeSequenceCaller([badDelta]);
  const recorder: { stored?: RefinedDocument } = {};
  const tool = createRefineDocumentTool({} as ModelRuntime, {
    httpCaller: caller,
    storageDir: "storage",
    storeImpl: async (doc) => {
      recorder.stored = doc;
      return doc as never;
    },
  });

  const result = await tool.execute("c", { markdown: SOURCE_MD }, undefined, undefined, {} as never);
  const details = result.details as { fallback?: boolean; error?: string };

  assert.equal(details.fallback, true, "exhausted repair loop falls back deterministically");
  assert.match(details.error ?? "", /cross-field validation/i);
  assert.equal(calls.length, 3, "initial pass + exactly 2 validation retries");
  assert.ok(recorder.stored, "fallback refinement still stored");
  assert.equal(recorder.stored!.quality.action, "review_required");
});

test("unparseable output retries keep their existing generic nudge (distinct from validation retries)", async () => {
  const calls: CallRecord[] = [];
  let n = 0;
  const caller: RefineLlmCaller = async (ctx) => {
    calls.push({ ...ctx });
    n += 1;
    if (n === 1) return { usage: zeroUsage, message: { role: "assistant", content: [{ type: "text", text: "not json at all" }] } };
    return {
      usage: zeroUsage,
      message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(GOOD_DELTA) }] },
    };
  };
  const tool = createRefineDocumentTool({} as ModelRuntime, { httpCaller: caller, storageDir: "storage", storeImpl: fakeStore() });
  const result = await tool.execute("c", { markdown: SOURCE_MD }, undefined, undefined, {} as never);
  const details = result.details as { fallback?: boolean };
  assert.equal(details.fallback, undefined);
  assert.match(calls[1]!.userContent, /\[retry 1\]/, "generic retry nudge preserved");
  assert.doesNotMatch(calls[1]!.userContent, /\[validation retry/i, "parse failures do NOT consume validation retries");
});

// --- unified reasoning strategy: same policy function drives BOTH paths ---

test("refineReasoningFor: extraction tasks default to no thinking; analysis defaults to thinking (env-tunable)", () => {
  const extraction = refineReasoningFor("extraction");
  assert.equal(extraction.effort, "none", "structured extraction (delta/patches/entities/relations) runs without thinking by default");

  const analysis = refineReasoningFor("analysis");
  assert.equal(analysis.effort, "high", "understanding/generation (summaries/quality synthesis) thinks by default");

  // env overrides
  const envLow = refineReasoningFor("extraction", { REFINE_REASONING_EXTRACTION: "low" });
  assert.equal(envLow.effort, "low");
  const envMax = refineReasoningFor("analysis", { REFINE_REASONING_ANALYSIS: "max" });
  assert.equal(envMax.effort, "high", "max/xhigh normalize to high for OpenRouter effort");

  // Pi thinking level mapping stays expressible for the runtime path
  assert.equal(refineReasoningFor("extraction").piThinkingLevel, "minimal");
  assert.equal(refineReasoningFor("analysis").piThinkingLevel, "high");

  // garbage env values fall back to the class default
  const fallback = refineReasoningFor("extraction", { REFINE_REASONING_EXTRACTION: "banana" });
  assert.equal(fallback.effort, "none");
});

test("direct path sends task-class effort: extraction calls none, global merge (analysis) high", async () => {
  const seenEfforts: Array<string | undefined> = [];
  const caller: RefineLlmCaller = async (ctx) => {
    seenEfforts.push((ctx as { reasoningEffort?: string }).reasoningEffort);
    if (JSON.stringify(ctx.schema) === JSON.stringify(HEADER_LEVELS_SCHEMA)) {
      return { usage: zeroUsage, message: { role: "assistant", content: [{ type: "text", text: '{"levels":[]}' }] } };
    }
    if (ctx.userContent.startsWith("The document was refined in")) {
      return {
        usage: zeroUsage,
        message: { role: "assistant", content: [{ type: "text", text: "{}" }] }, // empty global view
      };
    }
    return {
      usage: zeroUsage,
      message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(GOOD_DELTA) }] },
    };
  };
  const md = "# T\n\n## A\n\nbody";
  const tool = createRefineDocumentTool({} as ModelRuntime, { httpCaller: caller, storageDir: "storage", storeImpl: fakeStore() });
  await tool.execute("c", { markdown: md }, undefined, undefined, {} as never);

  // single-pass path only: one delta (extraction) call
  assert.deepEqual(seenEfforts, ["none"]);
  assert.equal(seenEfforts[0], refineReasoningFor("extraction").effort, "delta pass uses the EXTRACTION policy");
});

test("global merge (summary/quality synthesis = analysis class) requests thinking effort", async () => {
  const seenEfforts: Array<string | undefined> = [];
  const caller: RefineLlmCaller = async (ctx) => {
    seenEfforts.push((ctx as { reasoningEffort?: string }).reasoningEffort);
    if (JSON.stringify(ctx.schema) === JSON.stringify(HEADER_LEVELS_SCHEMA)) {
      return { usage: zeroUsage, message: { role: "assistant", content: [{ type: "text", text: '{"levels":[]}' }] } };
    }
    if (ctx.userContent.startsWith("The document was refined in")) {
      return { usage: zeroUsage, message: { role: "assistant", content: [{ type: "text", text: "{}" }] } };
    }
    return { usage: zeroUsage, message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(GOOD_DELTA) }] } };
  };
  // >1MB doc forces the two-stage path: stage-1 header judge + per-section delta + global merge.
  const md = "# Report\n\n" + Array.from({ length: 60 }, (_, i) => `## S${i}\n\n${"body ".repeat(4000)}`).join("\n");
  const tool = createRefineDocumentTool({} as ModelRuntime, { httpCaller: caller, storageDir: "storage", storeImpl: fakeStore() });
  await tool.execute("c", { markdown: md }, undefined, undefined, {} as never);

  assert.ok(seenEfforts.length >= 3, "stage-1 + per-section + global-merge calls observed");
  assert.equal(seenEfforts[0], refineReasoningFor("extraction").effort, "header judge = extraction class");
  assert.equal(seenEfforts[1], refineReasoningFor("extraction").effort, "per-section delta = extraction class");
  assert.equal(
    seenEfforts[seenEfforts.length - 1],
    refineReasoningFor("analysis").effort,
    "global merge (summaries + quality synthesis) = analysis class → thinking effort",
  );
});

test("Pi-runtime wiki-edit path derives its reasoning level from the SAME strategy function (no more accidental max)", async () => {
  // G4.S8.T16 scope C: wiki-edit migrated OFF Pi completeSimple onto the direct transport —
  // its caller now receives the SAME task-class effort as the upload delta pass.
  let seenEffort: string | undefined;
  const caller: RefineLlmCaller = async (ctx) => {
    seenEffort = ctx.reasoningEffort;
    throw new Error("stop after capture");
  };
  await assert.rejects(
    () =>
      runWikiEditRefine(
        {
          markdown: "# Page\n\nbody",
          before: "# Page\n\nbody",
          diff: "",
          structural: false,
        },
        undefined,
        { httpCaller: caller, retries: 0 },
      ),
    /stop after capture/,
  );

  assert.equal(seenEffort, refineReasoningFor("extraction").effort, "wiki-edit refine = structured extraction class → SAME policy as the upload path");
  assert.notEqual(seenEffort, "high", "the accidental reasoning:max default is gone");
});

test("callOpenRouter body carries provider.ignore from ATHENA_REFINE_PROVIDER_IGNORE (default Alibaba)", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }], usage: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  await callOpenRouter({ systemPrompt: "s", userContent: "u" } as OpenRouterCallParams, {
    apiKey: "k",
    fetchImpl,
    retries: 0,
  });
  assert.deepEqual(bodies[0]!.provider, { ignore: ["Alibaba"] }, "default provider ignore list excludes Alibaba (~deepseek routes stably to Relace)");

  await callOpenRouter({ systemPrompt: "s", userContent: "u" } as OpenRouterCallParams, {
    apiKey: "k",
    fetchImpl,
    retries: 0,
  });
  delete process.env.ATHENA_REFINE_PROVIDER_IGNORE;
  process.env.ATHENA_REFINE_PROVIDER_IGNORE = "Deepinfra, Alibaba ,  ";
  try {
    bodies.length = 0;
    await callOpenRouter({ systemPrompt: "s", userContent: "u" } as OpenRouterCallParams, {
      apiKey: "k",
      fetchImpl,
      retries: 0,
    });
    assert.deepEqual(bodies[0]!.provider, { ignore: ["Deepinfra", "Alibaba"] }, "comma-separated env value parsed + trimmed");
  } finally {
    delete process.env.ATHENA_REFINE_PROVIDER_IGNORE;
  }
  assert.deepEqual(resolveRefineProviderIgnore(), ["Alibaba"]);
});

test("ingest-dedicated key chain: env → auth[athenaingest] → auth[athena] fallback", async () => {
  const { readAthenaOpenRouterKey } = await import("../src/agents/llm-direct.js");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  // 1. env wins
  assert.equal(
    await readAthenaOpenRouterKey({ ATHENA_OPENROUTER_KEY: "env-key" }, "/nonexistent/auth.json"),
    "env-key",
  );

  const dir = await mkdtemp(join(tmpdir(), "auth-"));
  try {
    const authPath = join(dir, "auth.json");

    // 2. dedicated ingest key
    await writeFile(authPath, JSON.stringify({ athena: { key: "chat-key" }, athenaingest: { key: "ingest-key" } }));
    assert.equal(await readAthenaOpenRouterKey({}, authPath), "ingest-key", "athenaingest preferred over athena");

    // 3. chat provider fallback
    await writeFile(authPath, JSON.stringify({ athena: { key: "chat-key" } }));
    assert.equal(await readAthenaOpenRouterKey({}, authPath), "chat-key", "athena used when no athenaingest key");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("schema contract carries optional issue_anchors + patch anchor fields", () => {
  const schema = JSON.parse(JSON.stringify(REFINED_DOCUMENT_SCHEMA)) as {
    properties: Record<string, { properties?: Record<string, unknown> }>;
  };
  const quality = schema.properties["quality"] as { properties?: Record<string, unknown> } | undefined;
  assert.ok(quality?.properties?.issue_anchors, "quality.issue_anchors present in the emit schema (T17 anchor contract)");
});
