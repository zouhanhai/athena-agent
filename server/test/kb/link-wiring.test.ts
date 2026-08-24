/**
 * G4.S10.T1 — LINK stage wiring: BOTH refinement pipelines (upload refine pass
 * + wiki-edit diff-refine) must run the SAME linker between delta extraction
 * and the mandatory entity audit — so the audit reviews the MERGED/decided set
 * — and a failing linker must degrade without blocking.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AUDIT_ENTITIES_PROMPT,
  createRefineDocumentTool,
  EMIT_REFINED_DOCUMENT_TOOL,
  EMIT_WIKI_EDIT_REFINE_TOOL,
  runWikiEditRefine,
} from "../../src/agents/refine-document.js";
import type { EntityLinker } from "../../src/kb/link/link-engine.js";

/** Scripted refine caller: first call = extraction emit tool, later = audit. */
function scriptedRefineCaller(
  extractionJson: string,
  auditJson: string,
  toolName: string = EMIT_REFINED_DOCUMENT_TOOL,
) {
  const calls: Array<{ systemPrompt: string; userContent: string }> = [];
  return {
    calls,
    caller: async (params: { systemPrompt: string; userContent: string }) => {
      calls.push({ systemPrompt: params.systemPrompt, userContent: params.userContent });
      const text = calls.length === 1 ? extractionJson : auditJson;
      return {
        message: {
          role: "assistant",
          content: [
            ...(calls.length === 1
              ? [{
                  type: "toolCall" as const,
                  name: toolName,
                  arguments: JSON.parse(text) as unknown,
                }]
              : [{ type: "text" as const, text }]),
          ],
        },
      };
    },
  };
}

const MARKDOWN = "# CALEO onboarding\n\nThe galleo Office handles onboarding for the CALEO group.\n\n## Contact\n\nMail office@caleo.example.\n";

function extractionPayload() {
  return JSON.stringify({
    summary: "Onboarding doc.",
    sections: [{ title: "Contact", summary: "Contact details." }],
    frontmatter: { type: "concept", topic: "corporate/onboarding" },
    entities: [
      { name: "galleo Office", type: "organization", description: "the renamed office", occurrences: ["galleo Office handles onboarding"] },
      { name: "CALEO", type: "org", description: "the group" },
    ],
    relations: [
      { source: "galleo Office", target: "CALEO", keywords: ["part_of"], description: "office of the group" },
    ],
    keywords: ["onboarding"],
    quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
  });
}

const AUDIT_NOOP = JSON.stringify({
  entities: [
    { name: "CALEO Office", type: "org", description: "the renamed office" },
    { name: "CALEO", type: "org", description: "the group" },
  ],
  relations: [
    { source: "CALEO Office", target: "CALEO", keywords: ["part_of"], description: "office of the group" },
  ],
});

/** The rename re-link scenario: 'galleo Office' resolves onto existing 'CALEO Office'. */
function relinkLinker(events: string[]): EntityLinker {
  return async (candidates) => {
    events.push(`link:${candidates.map((c) => c.name).join(",")}`);
    return {
      merges: [{ from: "galleo Office", to: "CALEO Office", similarity: 0.95, evidence: "rename detected in edit" }],
      new_edges: [
        { source: "CALEO Office", target: "CALEO", relation: "PART_OF", evidence_quote: "office of the group" },
      ],
      standalone: ["CALEO"],
    };
  };
}

test("upload pipeline order: refine → LINK → audit → store (audit reviews the MERGED set)", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "link-wiring-"));
  const events: string[] = [];
  const { calls, caller } = scriptedRefineCaller(extractionPayload(), AUDIT_NOOP);
  const linker: EntityLinker = async (candidates) => {
    events.push(`link:${candidates.map((c) => c.name).join(",")}`);
    return {
      merges: [{ from: "galleo Office", to: "CALEO Office", similarity: 0.95, evidence: "rename detected" }],
      new_edges: [],
      standalone: ["CALEO"],
    };
  };

  const tool = createRefineDocumentTool({} as never, { httpCaller: caller, storageDir, entityLinker: linker });
  const result = await tool.execute(
    "refine_document",
    { markdown: MARKDOWN },
    undefined,
    undefined,
    {} as never,
  );
  assert.ok(result, "refine completed");

  // Order: the linker saw the RAW extracted candidates BEFORE any audit call.
  const auditCallIndex = calls.findIndex((c) => c.systemPrompt === AUDIT_ENTITIES_PROMPT);
  assert.ok(auditCallIndex >= 1, "audit session ran after extraction");
  assert.equal(events.length, 1, "exactly one link invocation");
  assert.ok(events[0]!.startsWith("link:galleo Office"), `linker ran pre-audit with raw candidates: ${events[0]}`);

  // The audit reviewed the MERGED names, not the raw candidate spelling.
  const auditInput = calls[auditCallIndex]!.userContent;
  assert.ok(auditInput.includes("[CALEO Office]"), "the canonical merged name got an entity label");
  assert.ok(
    !auditInput.includes('"galleo Office"'),
    "no entity/relation entry still carries the raw candidate name",
  );

  // The stored ref carries the merged entity set + the link edges.
  const text = (result.content as Array<{ type: string; text?: string }>).find((p) => p.type === "text")?.text;
  assert.ok(text);
  const ref = JSON.parse(text!) as { entities: Array<{ name: string }>; link_edges?: unknown[] };
  assert.deepEqual(
    ref.entities.map((e) => e.name).sort(),
    ["CALEO", "CALEO Office"],
  );
});

test("upload ref carries cross-document link_edges into the store contract", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "link-edges-"));
  const { caller } = scriptedRefineCaller(extractionPayload(), AUDIT_NOOP);
  const linker: EntityLinker = async () => ({
    merges: [],
    new_edges: [{ source: "CALEO", target: "CALEO Office", relation: "HAS_OFFICE", evidence_quote: "hq" }],
    standalone: [],
  });
  const tool = createRefineDocumentTool({} as never, { httpCaller: caller, storageDir, entityLinker: linker });
  const result = await tool.execute("refine_document", { markdown: MARKDOWN }, undefined, undefined, {} as never);
  const text = (result.content as Array<{ type: string; text?: string }>).find((p) => p.type === "text")?.text;
  assert.ok(text, "ref returned");
  const ref = JSON.parse(text!) as { link_edges?: Array<{ relation: string; source: string; target: string }> };
  assert.equal(ref.link_edges?.length, 1, "link_edges persisted on the small ref");
  assert.deepEqual(ref.link_edges![0], {
    source: "CALEO",
    target: "CALEO Office",
    relation: "HAS_OFFICE",
    evidence_quote: "hq",
  });
});

test("wiki-edit pipeline reuses the SAME linker after delta-refine and BEFORE its audit (rename auto re-link)", async () => {
  const events: string[] = [];
  const { calls, caller } = scriptedRefineCaller(
    JSON.stringify({
      summary: "Edited page.",
      sections: [],
      frontmatter: { type: "concept", topic: "corporate/onboarding" },
      entities: [
        { name: "galleo Office", type: "org", description: "renamed in edit" },
        { name: "CALEO", type: "org", description: "the group" },
      ],
      relations: [{ source: "galleo Office", target: "CALEO", keywords: ["part_of"], description: "rel" }],
      new_entities: [{ name: "galleo Office", type: "org", description: "renamed in edit" }],
      new_relations: [],
      keywords: [],
      rechunked: false,
      quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
    }),
    AUDIT_NOOP,
    EMIT_WIKI_EDIT_REFINE_TOOL,
  );

  const { document } = await runWikiEditRefine(
    {
      markdown: MARKDOWN,
      before: "# CALEO onboarding\n\nThe CALEO Office handles onboarding.\n",
      diff: "-The CALEO Office handles onboarding.\n+The galleo Office handles onboarding.\n",
      structural: false,
    },
    undefined,
    { httpCaller: caller, entityLinker: relinkLinker(events) },
  );

  const auditCallIndex = calls.findIndex((c) => c.systemPrompt === AUDIT_ENTITIES_PROMPT);
  assert.ok(auditCallIndex >= 1, "wiki audit session ran");
  assert.equal(events.length, 1, "same engine invoked exactly once");
  assert.ok(events[0]!.startsWith("link:galleo Office"), "linker ran on the extracted candidates");

  // Rename re-linked: document now carries ONLY the canonical node, and the
  // re-linked name is NOT new — it IS the existing graph node.
  assert.ok(document.entities.some((e) => e.name === "CALEO Office"));
  assert.ok(!document.entities.some((e) => e.name === "galleo Office"));
  assert.deepEqual(document.new_entities, [], "a rename onto an existing node introduces nothing new");
  assert.equal(document.relations[0]!.source, "CALEO Office", "relation endpoints redirected");

  // The audit reviewed the MERGED set.
  assert.ok(calls[auditCallIndex]!.userContent.includes("[CALEO Office]"));
  assert.ok(!calls[auditCallIndex]!.userContent.includes('"galleo Office"'));
});

test("a THROWING linker never blocks the pipeline (degrade to unlinked extraction)", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "link-degrade-"));
  const { calls, caller } = scriptedRefineCaller(extractionPayload(), AUDIT_NOOP);
  const tool = createRefineDocumentTool({} as never, {
    httpCaller: caller,
    storageDir,
    entityLinker: async () => {
      throw new Error("graph unavailable");
    },
  });
  const result = await tool.execute("refine_document", { markdown: MARKDOWN }, undefined, undefined, {} as never);
  assert.ok(result, "refine still completes when linking fails");
  const auditIndex = calls.findIndex((c) => c.systemPrompt === AUDIT_ENTITIES_PROMPT);
  assert.ok(auditIndex >= 1, "audit still ran");
});
