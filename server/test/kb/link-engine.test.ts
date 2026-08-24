/**
 * G4.S10.T1 — LINK engine unit tests (pure, no Neo4j, no real LLM).
 *
 * Covers: deterministic tiers (exact/alias/substring/vector≥0.92 + same-type),
 * different-type NEVER merges (typed-edge path), LLM adjudication for the
 * 0.6–0.92 band, retry+repair ≤3, total-failure degradation to
 * deterministic-only, output-contract bounds (endpoints, evidence ≤80 chars,
 * max_tokens cap), and merge dedup.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_MERGE_SIMILARITY,
  EVIDENCE_MAX_CHARS,
  LINK_MAX_TOKENS,
  applyMergesToEntities,
  linkCandidates,
  normalizeLinkType,
  type ExistingGraphApi,
  type LinkCandidate,
  type ExistingEntityMatch,
} from "../../src/kb/link/link-engine.js";

// --- fakes -------------------------------------------------------------------

interface LlmCall {
  systemPrompt: string;
  userContent: string;
  schema?: unknown;
  maxTokens?: number;
}

type LlmBehavior =
  | { kind: "json"; text: string }
  | { kind: "throw"; error?: Error };

/** Scripted LLM double: one behavior per call, records every request. */
function scriptedLlm(script: LlmBehavior[]): {
  calls: LlmCall[];
  caller: (params: LlmCall) => Promise<{ message: { content: Array<{ type: string; text?: string }> } }>;
} {
  const calls: LlmCall[] = [];
  return {
    calls,
    caller: async (params) => {
      calls.push(params);
      const behavior = script[Math.min(calls.length - 1, script.length - 1)]!;
      if (behavior.kind === "throw") throw behavior.error ?? new Error("llm down");
      return {
        message: { content: [{ type: "text", text: behavior.text }] },
      };
    },
  };
}

function apiWith(
  matches: Array<{ candidateUpper: string; hits: ExistingEntityMatch[] }>,
): ExistingGraphApi & { requested: LinkCandidate[]; limits: number[] } {
  const requested: LinkCandidate[] = [];
  const limits: number[] = [];
  return {
    requested,
    limits,
    async findMatches(candidate: LinkCandidate, limit: number) {
      requested.push(candidate);
      limits.push(limit);
      const key = candidate.name.toUpperCase();
      return matches.find((m) => m.candidateUpper === key)?.hits ?? [];
    },
  };
}

const EXISTING_CALEO: ExistingEntityMatch = {
  name: "CALEO",
  type: "org",
  similarity: 1,
  evidence_quote: "CALEO GmbH is the parent organization",
  source: "exact",
};

function llmJson(payload: unknown): string {
  return JSON.stringify(payload);
}

// --- deterministic tier --------------------------------------------------------

test("exact nameUpper match with the same normalized type auto-merges WITHOUT any LLM call", async () => {
  const api = apiWith([{ candidateUpper: "CALEO GMBH", hits: [EXISTING_CALEO] }]);
  const decisions = await linkCandidates({
    candidates: [{ name: "CALEO GmbH", type: "organization", description: "the company" }],
    existingGraphApi: api,
  });
  // llm omitted entirely → deterministic-only path must still merge
  assert.deepEqual(decisions.merges, [
    { from: "CALEO GmbH", to: "CALEO", similarity: 1, evidence: "CALEO GmbH is the parent organization" },
  ]);
  assert.deepEqual(decisions.new_edges, []);
  assert.deepEqual(decisions.standalone, []);
});

test("alias hit with the same type auto-merges", async () => {
  const api = apiWith([
    {
      candidateUpper: "CALEO HQ",
      hits: [{ name: "CALEO", type: "org", similarity: 0.98, evidence_quote: "alias CALEO HQ", source: "alias" }],
    },
  ]);
  const decisions = await linkCandidates({
    candidates: [{ name: "CALEO HQ", type: "org" }],
    existingGraphApi: api,
  });
  assert.equal(decisions.merges.length, 1);
  assert.equal(decisions.merges[0]!.to, "CALEO");
});

test("substring hit with the same type auto-merges", async () => {
  const api = apiWith([
    {
      candidateUpper: "CALEO OFFICE MUNICH",
      hits: [{ name: "CALEO Office", type: "org", similarity: 0.9, evidence_quote: "CALEO Office Munich opened", source: "substring" }],
    },
  ]);
  const decisions = await linkCandidates({
    candidates: [{ name: "CALEO Office Munich", type: "org" }],
    existingGraphApi: api,
  });
  assert.equal(decisions.merges.length, 1);
  assert.equal(decisions.merges[0]!.to, "CALEO Office");
});

test("vector similarity ≥ 0.92 with the same type auto-merges; below the bar goes to the LLM band", async () => {
  const strong = apiWith([
    { candidateUpper: "CALEOS", hits: [{ name: "CALEO", type: "org", similarity: AUTO_MERGE_SIMILARITY + 0.01, evidence_quote: "vec", source: "vector" }] },
  ]);
  const strongDecision = await linkCandidates({
    candidates: [{ name: "CALEOs", type: "org" }],
    existingGraphApi: strong,
  });
  assert.equal(strongDecision.merges.length, 1);

  const weak = apiWith([
    { candidateUpper: "CALEOS", hits: [{ name: "CALEO", type: "org", similarity: 0.85, evidence_quote: "vec", source: "vector" }] },
  ]);
  const { calls, caller } = scriptedLlm([
    { kind: "json", text: llmJson({ merges: [{ from: "CALEOs", to: "CALEO", similarity: 0.85, evidence: "same group" }], new_edges: [], standalone: [] }) },
  ]);
  const ambiguous = await linkCandidates({
    candidates: [{ name: "CALEOs", type: "org" }],
    existingGraphApi: weak,
    llm: caller,
  });
  assert.equal(calls.length, 1, "ambiguous candidate adjudicated by exactly ONE LLM call");
  assert.equal(ambiguous.merges.length, 1);
  assert.equal(ambiguous.merges[0]!.to, "CALEO");
});

test("different normalized types NEVER merge deterministically — routed to the typed-edge LLM path", async () => {
  // Same surface name, CONFLICTING types (place candidate vs org node) — the
  // classic mis-typed-extraction case: identity must NOT merge, an edge may.
  const api = apiWith([
    {
      candidateUpper: "CALEO TOWER",
      hits: [
        { name: "CALEO Tower", type: "org", similarity: 1, evidence_quote: "the building unit", source: "exact" },
        { name: "CALEO", type: "org", similarity: 0.88, evidence_quote: "group HQ", source: "vector" },
      ],
    },
  ]);
  const { calls, caller } = scriptedLlm([
    {
      kind: "json",
      text: llmJson({
        merges: [],
        new_edges: [{ source: "CALEO", target: "CALEO Tower", relation: "HAS_OFFICE", evidence_quote: "HQ at CALEO Tower" }],
        standalone: ["CALEO Tower"],
      }),
    },
  ]);
  const decisions = await linkCandidates({
    candidates: [{ name: "CALEO Tower", type: "place" }],
    existingGraphApi: api,
    llm: caller,
  });
  assert.equal(decisions.merges.length, 0, "org vs location must not merge");
  assert.equal(decisions.new_edges.length, 1);
  assert.equal(decisions.new_edges[0]!.relation, "HAS_OFFICE");
  assert.ok(calls.length >= 1, "typed-edge decision went through the LLM");
});

test("no matches → standalone without LLM", async () => {
  const api = apiWith([]);
  const decisions = await linkCandidates({
    candidates: [{ name: "SAP", type: "org" }],
    existingGraphApi: api,
  });
  assert.deepEqual(decisions.merges, []);
  assert.deepEqual(decisions.standalone, ["SAP"]);
});

// --- type normalization ---------------------------------------------------------

test("normalizeLinkType folds organization/group→org and place→location", () => {
  assert.equal(normalizeLinkType("organization"), "org");
  assert.equal(normalizeLinkType("Organization"), "org");
  assert.equal(normalizeLinkType("group"), "org");
  assert.equal(normalizeLinkType("place"), "location");
  assert.equal(normalizeLinkType("LOCATION"), "location");
  assert.equal(normalizeLinkType("person"), "person");
});

test("group vs organization are the SAME normalized type → deterministic merge applies", async () => {
  const api = apiWith([
    { candidateUpper: "CALEO GROUP", hits: [{ name: "CALEO", type: "org", similarity: 1, evidence_quote: "group parent", source: "exact" }] },
  ]);
  const decisions = await linkCandidates({
    candidates: [{ name: "CALEO Group", type: "organization" }],
    existingGraphApi: api,
  });
  assert.equal(decisions.merges.length, 1);
});

// --- LLM tier contract -----------------------------------------------------------

test("LLM adjudication receives a BOUNDED prompt (top-5 matches + evidence quotes, no full document) and a capped max_tokens", async () => {
  // A >80-char occurrence can never cross the boundary (truncated to a quote).
  const sentinel = `FULL_DOCUMENT_SENTINEL_${"x".repeat(120)}_NEVER_REEMITTED_WHOLE`;
  const hits: ExistingEntityMatch[] = Array.from({ length: 8 }, (_, i) => ({
    name: `Match ${i}`,
    type: "org",
    similarity: 0.7 + i * 0.01,
    evidence_quote: `evidence ${i}`,
    source: "vector",
  })).reverse();
  const api = apiWith([{ candidateUpper: "MYSTERY ORG", hits }]);
  const { calls, caller } = scriptedLlm([
    { kind: "json", text: llmJson({ merges: [], new_edges: [], standalone: [] }) },
  ]);
  await linkCandidates({
    candidates: [{ name: "Mystery Org", type: "org", description: "an org", occurrences: [sentinel] }],
    existingGraphApi: api,
    llm: caller,
    topK: 5,
  });
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.maxTokens, LINK_MAX_TOKENS, "output capped via max_tokens");
  assert.ok(call.schema, "json_schema contract attached");
  assert.ok(!call.userContent.includes(sentinel), "occurrence full text is NOT re-emitted");
  assert.equal(call.userContent.split("Match ").length - 1 <= 5, true, "at most top-5 matches carried");
  assert.ok(call.userContent.includes("0.77"), "similarity scores carried to the LLM");
});

test("LLM proposes a phantom merge target → dropped by endpoint validation, candidate stays standalone", async () => {
  const api = apiWith([
    { candidateUpper: "GHOSTLY", hits: [{ name: "Real Org", type: "org", similarity: 0.75, evidence_quote: "fuzzy", source: "vector" }] },
  ]);
  const { caller } = scriptedLlm([
    {
      kind: "json",
      text: llmJson({ merges: [{ from: "Ghostly", to: "Phantom Node", similarity: 0.9, evidence: "x" }], new_edges: [], standalone: [] }),
    },
  ]);
  const decisions = await linkCandidates({
    candidates: [{ name: "Ghostly", type: "org" }],
    existingGraphApi: api,
    llm: caller,
  });
  assert.deepEqual(decisions.merges, [], "merge.to ∉ existing → rejected");
  assert.deepEqual(decisions.standalone, ["Ghostly"]);
});

test("edge endpoints outside candidates∪existing are rejected; overlong evidence truncated to ≤80 chars", async () => {
  const api = apiWith([
    { candidateUpper: "GHOSTLY", hits: [{ name: "Real Org", type: "org", similarity: 0.75, evidence_quote: "fuzzy", source: "vector" }] },
  ]);
  const longEvidence = "e".repeat(200);
  const { caller } = scriptedLlm([
    {
      kind: "json",
      text: llmJson({
        merges: [],
        new_edges: [
          { source: "Ghostly", target: "Nowhere Man", relation: "KNOWS", evidence_quote: longEvidence },
          { source: "Ghostly", target: "Real Org", relation: "RELATED_TO", evidence_quote: longEvidence },
        ],
        standalone: [],
      }),
    },
  ]);
  const decisions = await linkCandidates({
    candidates: [{ name: "Ghostly", type: "org" }],
    existingGraphApi: api,
    llm: caller,
  });
  assert.equal(decisions.new_edges.length, 1, "phantom edge endpoint dropped, valid edge kept");
  assert.equal(decisions.new_edges[0]!.target, "Real Org");
  assert.ok(decisions.new_edges[0]!.evidence_quote.length <= EVIDENCE_MAX_CHARS);
  assert.ok((decisions.merges.every((m) => m.evidence.length <= EVIDENCE_MAX_CHARS)));
});

test("schema-mismatch repair: first answer invalid, repaired second attempt adopted (≤3 attempts)", async () => {
  const api = apiWith([
    { candidateUpper: "FUZZY THING", hits: [{ name: "Real Org", type: "org", similarity: 0.8, evidence_quote: "fuzzy", source: "vector" }] },
  ]);
  const { calls, caller } = scriptedLlm([
    { kind: "json", text: "not json at all {{{" },
    {
      kind: "json",
      text: llmJson({ merges: [{ from: "Fuzzy Thing", to: "Real Org", similarity: 0.8, evidence: "close enough" }], new_edges: [], standalone: [] }),
    },
  ]);
  const decisions = await linkCandidates({
    candidates: [{ name: "Fuzzy Thing", type: "org" }],
    existingGraphApi: api,
    llm: caller,
  });
  assert.equal(calls.length, 2, "one repair retry after unparseable output");
  assert.ok(calls[1]!.userContent.includes("retry") || calls[1]!.userContent.includes("previous"), "repair feedback carried");
  assert.equal(decisions.merges.length, 1);
});

test("total LLM failure degrades to deterministic-only WITHOUT blocking (never throws)", async () => {
  const api = apiWith([
    { candidateUpper: "SOLID", hits: [EXISTING_CALEO] },
    { candidateUpper: "SHAKY", hits: [{ name: "Real Org", type: "org", similarity: 0.7, evidence_quote: "fuzzy", source: "vector" }] },
  ]);
  let attempts = 0;
  const decisions = await linkCandidates({
    candidates: [
      { name: "Solid", type: "org" },
      { name: "Shaky", type: "org" },
    ],
    existingGraphApi: api,
    llm: async () => {
      attempts += 1;
      throw new Error("provider down");
    },
    retries: 2,
  });
  assert.equal(attempts, 2, "retries respected (≤ configured bound)");
  assert.equal(decisions.merges.length, 1, "deterministic merge survives degradation");
  assert.equal(decisions.merges[0]!.from, "Solid");
  assert.deepEqual(decisions.standalone, ["Shaky"], "ambiguous candidate degrades to standalone");
});

test("no LLM configured → ambiguous candidates become standalone (deterministic-only mode)", async () => {
  const api = apiWith([
    { candidateUpper: "SHAKY", hits: [{ name: "Real Org", type: "org", similarity: 0.7, evidence_quote: "fuzzy", source: "vector" }] },
  ]);
  const decisions = await linkCandidates({
    candidates: [{ name: "Shaky", type: "org" }],
    existingGraphApi: api,
  });
  assert.deepEqual(decisions.merges, []);
  assert.deepEqual(decisions.standalone, ["Shaky"]);
});

// --- merge dedup ------------------------------------------------------------------

test("two batch candidates resolving to the SAME existing node produce two well-formed merges; identical decisions dedupe", async () => {
  const api = apiWith([
    { candidateUpper: "CALEO OFFICE", hits: [{ name: "CALEO", type: "org", similarity: 1, evidence_quote: "office page", source: "exact" }] },
    { candidateUpper: "CALEOS", hits: [{ name: "CALEO", type: "org", similarity: 1, evidence_quote: "plural form", source: "exact" }] },
  ]);
  const decisions = await linkCandidates({
    candidates: [
      { name: "CALEO Office", type: "org" },
      { name: "CALEOs", type: "org" },
    ],
    existingGraphApi: api,
  });
  assert.equal(decisions.merges.length, 2);
  assert.deepEqual(
    decisions.merges.map((m) => m.from).sort(),
    ["CALEOs", "CALEO Office"].sort(),
  );
  assert.ok(decisions.merges.every((m) => m.to === "CALEO"));
});

test("duplicate LLM merge decisions for the same (from,to) pair are deduped", async () => {
  const api = apiWith([
    { candidateUpper: "SHAKY", hits: [{ name: "Real Org", type: "org", similarity: 0.7, evidence_quote: "fuzzy", source: "vector" }] },
  ]);
  const { caller } = scriptedLlm([
    {
      kind: "json",
      text: llmJson({
        merges: [
          { from: "Shaky", to: "Real Org", similarity: 0.7, evidence: "a" },
          { from: "Shaky", to: "Real Org", similarity: 0.7, evidence: "b" },
        ],
        new_edges: [],
        standalone: [],
      }),
    },
  ]);
  const decisions = await linkCandidates({
    candidates: [{ name: "Shaky", type: "org" }],
    existingGraphApi: api,
    llm: caller,
  });
  assert.equal(decisions.merges.length, 1);
});

test("standalone recomputed truthfully: merged candidates excluded, others listed once, input order preserved", async () => {
  const api = apiWith([
    { candidateUpper: "MERGE ME", hits: [{ name: "CALEO", type: "org", similarity: 1, evidence_quote: "q", source: "exact" }] },
  ]);
  const decisions = await linkCandidates({
    candidates: [
      { name: "Merge Me", type: "org" },
      { name: "SAP", type: "org" },
      { name: "ZOB München", type: "place" },
    ],
    existingGraphApi: api,
  });
  assert.deepEqual(decisions.standalone, ["SAP", "ZOB München"]);
});

// --- pure transform used by both pipelines ------------------------------------------

test("applyMergesToEntities renames merged candidates + their relation endpoints and unions aliases onto the local twin", () => {
  const entities = [
    { name: "galleo Office", type: "org", description: "renamed office", aliases: ["galleo"] },
    { name: "CALEO Office", type: "org", description: "existing canonical" },
    { name: "SAP", type: "org", description: "untouched" },
  ];
  const relations = [
    { source: "galleo Office", target: "SAP", keywords: ["uses"], description: "rel" },
  ];
  const { entities: renamed, relations: rerouted } = applyMergesToEntities(entities, relations, [
    { from: "galleo Office", to: "CALEO Office", similarity: 0.93, evidence: "rename detected" },
  ]);
  assert.equal(renamed.find((e) => e.name === "galleo Office"), undefined, "shadowed candidate removed");
  const twin = renamed.find((e) => e.name === "CALEO Office");
  assert.ok(twin);
  assert.deepEqual(
    twin!.aliases,
    ["galleo Office", "galleo"],
    "the pre-rename spelling survives as aliases on the surviving node",
  );
  assert.equal(rerouted[0]!.source, "CALEO Office", "relation endpoint redirected");
  assert.equal(rerouted[0]!.target, "SAP");
});
