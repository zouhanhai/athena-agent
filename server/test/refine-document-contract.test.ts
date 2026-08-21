import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DOCUMENT_REFINEMENT_SKILL_PATH,
  DOCUMENT_REFINEMENT_SKILL_NAME,
  GLOBAL_MERGE_SYSTEM_PROMPT,
  HEADER_RELEVEL_SYSTEM_PROMPT,
  REFINED_DOCUMENT_SCHEMA,
  REFINE_DOCUMENT_SYSTEM_PROMPT,
  buildGlobalMergePrompt,
  buildHeaderJudgePrompt,
  normalizeRefinedDocument,
} from "../src/agents/refine-document.js";

/** Minimal RefinedDocument-shaped object for prompt-building helpers. */
function makeMerged() {
  return {
    markdown: "# Doc",
    summary: "s",
    sections: [{ title: "Intro", summary: "about" }],
    frontmatter: { type: "document", topic: "unclassified" },
    chunks: [],
    entities: [],
    relations: [],
    keywords: [],
    quality: { complete: true, confidence: 0.5, issues: [], action: "auto_accept" as const },
  };
}

/** JSON-serialized shape of the TypeBox schema (matches constrainedSampling). */
function schemaJson(schema: unknown): {
  properties: Record<string, { type?: string; properties?: Record<string, unknown>; items?: { properties?: Record<string, unknown> } }>;
} {
  return JSON.parse(JSON.stringify(schema));
}

test("delta output contract schema defines extraction fields + patches (NO markdown/chunks)", () => {
  const s = schemaJson(REFINED_DOCUMENT_SCHEMA);
  assert.equal(s.type, "object");
  const top = Object.keys(s.properties).sort();
  assert.deepEqual(top, ["entities", "frontmatter", "keywords", "patches", "quality", "relations", "sections", "summary"]);
  // markdown/chunks deliberately absent — Athena rebuilds them locally (G4.S8.T1)
  assert.equal(s.properties.markdown, undefined, "markdown is ABSENT from the LLM contract");
  assert.equal(s.properties.chunks, undefined, "chunks are ABSENT from the LLM contract");

  assert.ok(s.properties.frontmatter.properties?.type);
  assert.ok(s.properties.frontmatter.properties?.topic);
});

test("delta output contract summary is a string (~2-3 sentences)", () => {
  const s = schemaJson(REFINED_DOCUMENT_SCHEMA);
  assert.equal(s.properties.summary.type, "string");
});

test("delta output contract sections is {title, summary}[] (one per top-level H1)", () => {
  const s = schemaJson(REFINED_DOCUMENT_SCHEMA);
  assert.equal(s.properties.sections.type, "array");
  const props = s.properties.sections.items?.properties ?? {};
  assert.deepEqual(Object.keys(props).sort(), ["summary", "title"]);
  assert.equal(props.title.type, "string");
  assert.equal(props.summary.type, "string");
});

test("patches contract is an optional array with oneOf header/paragraph ops", () => {
  const s = schemaJson(REFINED_DOCUMENT_SCHEMA);
  assert.equal(s.properties.patches.type, "array");
  const ops = s.properties.patches.items?.anyOf?.map((o: { properties?: { op?: { const?: string } } }) => o.properties?.op?.const) ?? [];
  assert.deepEqual(ops, ["retitle_heading", "refactor_heading", "replace_paragraph", "insert_paragraph", "delete_paragraph"]);
});

test("entity contract: name(title-case)/type/description/aliases (bilingual DE+EN)", () => {
  const entProps = schemaJson(REFINED_DOCUMENT_SCHEMA).properties.entities.items?.properties ?? {};
  assert.deepEqual(Object.keys(entProps).sort(), ["aliases", "description", "name", "type"]);
  assert.equal(entProps.aliases?.type, "array");
});

test("relation contract: source/target/keywords/description (binary)", () => {
  const relProps = schemaJson(REFINED_DOCUMENT_SCHEMA).properties.relations.items?.properties ?? {};
  assert.deepEqual(Object.keys(relProps).sort(), ["description", "keywords", "source", "target"]);
  assert.equal(relProps.keywords?.type, "array");
});

test("quality contract: complete/confidence/issues/action (auto_accept|review_required) + optional anchored issues (G4.S8.T16)", () => {
  const q = schemaJson(REFINED_DOCUMENT_SCHEMA).properties.quality.properties ?? {};
  assert.deepEqual(Object.keys(q).sort(), ["action", "complete", "confidence", "issue_anchors", "issues"]);
  const action = q.action as { anyOf?: Array<{ const?: string }> };
  assert.deepEqual(action.anyOf?.map((x) => x.const), ["auto_accept", "review_required"]);
  // G4.S8.T16: issue_anchors is OPTIONAL (T17 anchor contract) with message+quote strings.
  assert.deepEqual(Object.keys((q.issue_anchors as { items?: { properties?: unknown } }).items?.properties ?? {}).sort(), [
    "message",
    "quote",
  ]);
});

test("normalizeRefinedDocument maps heading_path + source/target/keywords/description + summary + sections", () => {
  const doc = normalizeRefinedDocument({
    markdown: "# Sommerseminar\n\n## Workshops\n\nDetails.",
    summary: "CALEO's annual Sommerseminar covers workshops and talks.",
    sections: [{ title: "Sommerseminar", summary: "The annual CALEO event with workshops and talks." }],
    frontmatter: { type: "event", topic: "internal/events" },
    chunks: [{ id: "c1", text: "Details.", heading_path: "Workshops" }],
    entities: [
      {
        name: "ZOB München",
        type: "location",
        description: "Munich central bus station",
        aliases: ["Zentraler Omnibusbahnhof", "München ZOB"],
      },
    ],
    relations: [
      { source: "ZOB München", target: "Sommerseminar", keywords: ["hosts"], description: "ZOB hosts Sommerseminar" },
    ],
    keywords: ["sommerseminar", "workshop"],
    quality: { complete: true, confidence: 0.85, issues: [], action: "auto_accept" },
  });

  assert.equal(doc.markdown, "# Sommerseminar\n\n## Workshops\n\nDetails.");
  assert.deepEqual(doc.frontmatter, { type: "event", topic: "internal/events" });
  assert.deepEqual(doc.chunks, [{ id: "c1", text: "Details.", heading_path: "Workshops" }]);
  assert.deepEqual(doc.entities[0], {
    name: "ZOB München",
    type: "location",
    description: "Munich central bus station",
    aliases: ["Zentraler Omnibusbahnhof", "München ZOB"],
  });
  assert.deepEqual(doc.relations[0], {
    source: "ZOB München",
    target: "Sommerseminar",
    keywords: ["hosts"],
    description: "ZOB hosts Sommerseminar",
  });
  assert.deepEqual(doc.keywords, ["sommerseminar", "workshop"]);
  assert.equal(doc.quality.action, "auto_accept");
  assert.equal(doc.summary, "CALEO's annual Sommerseminar covers workshops and talks.");
  assert.deepEqual(doc.sections, [{ title: "Sommerseminar", summary: "The annual CALEO event with workshops and talks." }]);
});

test("normalizeRefinedDocument defaults entity aliases to [] when absent", () => {
  const doc = normalizeRefinedDocument({
    markdown: "# D",
    frontmatter: { type: "document", topic: "unclassified" },
    chunks: [],
    entities: [{ name: "CALEO", type: "org", description: "An organization" }],
    relations: [],
    keywords: [],
    quality: { complete: true, confidence: 0.5, issues: [], action: "auto_accept" },
  });
  assert.deepEqual(doc.entities[0].aliases, []);
});

test("normalizeRefinedDocument defaults summary to empty string when absent", () => {
  const doc = normalizeRefinedDocument({
    markdown: "# D",
    frontmatter: { type: "document", topic: "unclassified" },
    chunks: [],
    entities: [],
    relations: [],
    keywords: [],
    quality: { complete: true, confidence: 0.5, issues: [], action: "auto_accept" },
  });
  assert.equal(doc.summary, "");
  assert.deepEqual(doc.sections, []);
});

test("refinement prompt embeds docs/taxonomy.md (type criteria + hierarchical topic tree)", () => {
  assert.match(REFINE_DOCUMENT_SYSTEM_PROMPT, /report/i);
  assert.match(REFINE_DOCUMENT_SYSTEM_PROMPT, /internal\/events/);
  assert.match(REFINE_DOCUMENT_SYSTEM_PROMPT, /sap\/consolidation\/group-reporting/);
});

test("refinement prompt encodes cross-RAG best practices + single full-doc pass + raw-JSON emit", () => {
  const p = REFINE_DOCUMENT_SYSTEM_PROMPT;
  assert.match(p, /heading_path/);
  assert.match(p, /source.*target|binary/i);
  assert.match(p, /title[- ]case/i);
  assert.match(p, /direct.*meaningful|meaningful/i);
  assert.match(p, /1200/);
  assert.match(p, /relationship keywords|query keywords/i);
  assert.match(p, /JSON object/i);
  assert.match(p, /ONE|single/);
});

test("refinement prompt emits bilingual (DE+EN) entity aliases for RAG retrieval", () => {
  const p = REFINE_DOCUMENT_SYSTEM_PROMPT;
  assert.match(p, /aliases/i);
  assert.match(p, /German.*English|DE.*EN|bilingual|same node/i);
  assert.match(p, /canonical/i);
});

test("refinement prompt instructs a concise 2-3 sentence document summary", () => {
  const p = REFINE_DOCUMENT_SYSTEM_PROMPT;
  assert.match(p, /summar/i);
  assert.match(p, /2-3 sentences|two or three|concise/i);
});

test("refinement prompt emits per-H1-section summaries ({title, summary})", () => {
  const p = REFINE_DOCUMENT_SYSTEM_PROMPT;
  assert.match(p, /sections/i);
  assert.match(p, /per.*section|one.*section|each.*section/i);
});

test("document-refinement SKILL.md exists with required guidance sections", () => {
  const name = DOCUMENT_REFINEMENT_SKILL_NAME;
  assert.equal(name, "document-refinement");

  const content = readFileSync(DOCUMENT_REFINEMENT_SKILL_PATH, "utf8");
  assert.match(content, /^---/);
  assert.match(content, /name:\s*document-refinement/);
  assert.match(content, /description:/);
  assert.match(content, /[Hh]eader re-level/);
  assert.match(content, /taxonomy/i);
  assert.match(content, /[Qq]uality/);
  assert.match(content, /[Ee]ntit/);
  assert.match(content, /[Rr]elation/);
  assert.match(content, /single|one pass|full-doc/i);
  assert.match(content, /aliases/i);
});

test("G4.S8.T6: refinement prompts no longer instruct calling a tool — they ask for raw JSON", () => {
  assert.doesNotMatch(REFINE_DOCUMENT_SYSTEM_PROMPT, /emit_refined_document tool/, "main prompt must not ask for a tool call");
  assert.doesNotMatch(REFINE_DOCUMENT_SYSTEM_PROMPT, /call the emit/i);
  assert.doesNotMatch(HEADER_RELEVEL_SYSTEM_PROMPT, /emit_header_levels tool/);
  assert.doesNotMatch(GLOBAL_MERGE_SYSTEM_PROMPT, /emit_global_refinement tool/);
  assert.doesNotMatch(buildGlobalMergePrompt(makeMerged(), undefined, 2), /emit_global_refinement/, "global-merge prompt must not reference the emit tool");
  assert.doesNotMatch(buildHeaderJudgePrompt([]), /emit_header_levels/, "header-judge prompt must not reference the emit tool");
  assert.match(buildGlobalMergePrompt(makeMerged(), undefined, 2), /JSON object|matching the contract/i);
});
