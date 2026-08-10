import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DOCUMENT_REFINEMENT_SKILL_PATH,
  DOCUMENT_REFINEMENT_SKILL_NAME,
  REFINED_DOCUMENT_SCHEMA,
  REFINE_DOCUMENT_SYSTEM_PROMPT,
  normalizeRefinedDocument,
} from "../src/agents/refine-document.js";

/** JSON-serialized shape of the TypeBox schema (matches constrainedSampling). */
function schemaJson(schema: unknown): {
  properties: Record<string, { type?: string; properties?: Record<string, unknown>; items?: { properties?: Record<string, unknown> } }>;
} {
  return JSON.parse(JSON.stringify(schema));
}

test("output contract schema defines markdown/frontmatter/chunks/entities/relations/keywords/quality", () => {
  const s = schemaJson(REFINED_DOCUMENT_SCHEMA);
  assert.equal(s.type, "object");
  const top = Object.keys(s.properties).sort();
  assert.deepEqual(top, ["chunks", "entities", "frontmatter", "keywords", "markdown", "quality", "relations"]);

  assert.ok(s.properties.markdown.type === "string");
  assert.ok(s.properties.frontmatter.properties?.type);
  assert.ok(s.properties.frontmatter.properties?.topic);
});

test("chunk contract: id/text/heading_path (paragraph-semantic ~1200tok)", () => {
  const chunkProps = schemaJson(REFINED_DOCUMENT_SCHEMA).properties.chunks.items?.properties ?? {};
  assert.deepEqual(Object.keys(chunkProps).sort(), ["heading_path", "id", "text"]);
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

test("quality contract: complete/confidence/issues/action (auto_accept|review_required)", () => {
  const q = schemaJson(REFINED_DOCUMENT_SCHEMA).properties.quality.properties ?? {};
  assert.deepEqual(Object.keys(q).sort(), ["action", "complete", "confidence", "issues"]);
  const action = q.action as { anyOf?: Array<{ const?: string }> };
  assert.deepEqual(action.anyOf?.map((x) => x.const), ["auto_accept", "review_required"]);
});

test("normalizeRefinedDocument maps heading_path + source/target/keywords/description", () => {
  const doc = normalizeRefinedDocument({
    markdown: "# Sommerseminar\n\n## Workshops\n\nDetails.",
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

test("refinement prompt embeds docs/taxonomy.md (type criteria + hierarchical topic tree)", () => {
  assert.match(REFINE_DOCUMENT_SYSTEM_PROMPT, /report/i);
  assert.match(REFINE_DOCUMENT_SYSTEM_PROMPT, /internal\/events/);
  assert.match(REFINE_DOCUMENT_SYSTEM_PROMPT, /sap\/consolidation\/group-reporting/);
});

test("refinement prompt encodes cross-RAG best practices + single full-doc pass + constrained emit", () => {
  const p = REFINE_DOCUMENT_SYSTEM_PROMPT;
  assert.match(p, /heading_path/);
  assert.match(p, /source.*target|binary/i);
  assert.match(p, /title[- ]case/i);
  assert.match(p, /direct.*meaningful|meaningful/i);
  assert.match(p, /1200/);
  assert.match(p, /relationship keywords|query keywords/i);
  assert.match(p, /emit_refined_document/);
  assert.match(p, /ONE|single/);
});

test("refinement prompt emits bilingual (DE+EN) entity aliases for RAG retrieval", () => {
  const p = REFINE_DOCUMENT_SYSTEM_PROMPT;
  assert.match(p, /aliases/i);
  assert.match(p, /German.*English|DE.*EN|bilingual|same node/i);
  assert.match(p, /canonical/i);
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
