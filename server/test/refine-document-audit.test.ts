import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RefinedDocument, RefinedDocumentDelta, RefineLlmCaller } from "../src/agents/refine-document.js";
import {
  AUDIT_ENTITIES_SCHEMA,
  REFINED_DOCUMENT_SCHEMA,
  buildAuditPrompt,
  createRefineDocumentTool,
  runEntityAudit,
} from "../src/agents/refine-document.js";

/**
 * G4.S8.T19 — mandatory per-document LLM audit gate.
 *
 * EVERY refined document runs ONE independent audit session after the main
 * pass (reasoning off, entities/relations only): merge near-duplicate entity
 * names (Belly→Affiliated), force every relation endpoint to exactly reference
 * the entity list, never invent entities. The audited set must flow into the
 * graph overwrite + persisted output; a per-document "[refine_document] audit
 * pass:" log line is mandatory. Audit also rescues validation exhaustion
 * before the mechanical fallback.
 */

const zeroUsage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
};

const SOURCE_MD = [
  "# Hotel Palma Bellver",
  "",
  "The hotel is operated by Melia Hotels International.",
  "",
  "## Location",
  "",
  "It stands on the Paseo Maritimo in Palma de Mallorca.",
].join("\n");

/** The observed drift fixture: relation endpoint says "Belly", entity list says "Affiliated". */
function bellyDelta(overrides: Partial<RefinedDocumentDelta> = {}): RefinedDocumentDelta {
  return {
    summary: "Hotel fact sheet.",
    sections: [{ title: "Hotel Palma Bellver", summary: "A Melia-operated hotel." }],
    frontmatter: { type: "report", topic: "internal/venues" },
    entities: [
      { name: "Hotel Palma Bellver Affiliated by Melia", type: "org", description: "The hotel.", aliases: ["Palma Bellver"] },
      { name: "Melia Hotels International", type: "org", description: "The operator." },
    ],
    relations: [
      {
        source: "Hotel Palma Bellver Belly by Melia",
        target: "Melia Hotels International",
        keywords: ["operated by"],
        description: "Operated by Melia.",
      },
    ],
    keywords: ["hotel"],
    quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
    patches: [],
    ...overrides,
  };
}

/** Canonical rewrite the auditor should produce for the Belly fixture (closed-world). */
const AUDIT_CANONICAL = {
  entities: [
    { name: "Hotel Palma Bellver Affiliated by Melia", type: "org", description: "The hotel." },
    { name: "Melia Hotels International", type: "org", description: "The operator." },
  ],
  relations: [
    {
      source: "Hotel Palma Bellver Affiliated by Melia",
      target: "Melia Hotels International",
      keywords: ["operated by"],
      description: "Operated by Melia.",
    },
  ],
};

function textCaller(response: unknown): { caller: RefineLlmCaller; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const caller: RefineLlmCaller = async (ctx) => {
    calls.push({ ...ctx } as Record<string, unknown>);
    return { usage: zeroUsage, message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(response) }] } };
  };
  return { caller, calls };
}

function fakeStore(recorder: { stored?: RefinedDocument } = {}) {
  return async (doc: RefinedDocument): Promise<never> => {
    recorder.stored = doc;
    return doc as never;
  };
}

// --- unit: runEntityAudit ---

test("runEntityAudit adopts a canonical rewrite and merges Belly into Affiliated (closed-world endpoints)", async () => {
  const drifted = bellyDelta();
  const { caller, calls } = textCaller(AUDIT_CANONICAL);
  const result = await runEntityAudit(caller, SOURCE_MD, drifted);

  assert.equal(result.adopted, true, "valid canonical rewrite is adopted");
  assert.ok(result.changedEntities + result.changedRelations > 0, "change counters non-zero");
  const names = new Set(result.delta.entities.map((e) => e.name));
  for (const r of result.delta.relations) {
    assert.ok(names.has(r.source), `source ${r.source} exactly references the entity list`);
    assert.ok(names.has(r.target), `target ${r.target} exactly references the entity list`);
  }
  assert.ok(![...names].some((n) => n.includes("Belly")), "drifted Belly name is gone");
  // aliases survive the audit (bilingual RAG lookup must not regress)
  const hotel = result.delta.entities.find((e) => e.name.startsWith("Hotel Palma Bellver"));
  assert.deepEqual(hotel?.aliases, ["Palma Bellver"], "aliases carried over from the pre-audit entity");
  // audit call shape: narrow schema + no thinking
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.schema, AUDIT_ENTITIES_SCHEMA as unknown);
  assert.equal(calls[0]!.reasoningEffort, "none");
});

test("runEntityAudit keeps the original delta when the audit output is invalid", async () => {
  const drifted = bellyDelta();
  const invalidAudit = {
    entities: [],
    relations: AUDIT_CANONICAL.relations, // relations with EMPTY entities → invalid
  };
  const { caller } = textCaller(invalidAudit);
  const result = await runEntityAudit(caller, SOURCE_MD, drifted);

  assert.equal(result.adopted, false, "invalid audit output is rejected");
  assert.equal(result.delta, drifted, "pre-audit delta object kept verbatim");
});

test("runEntityAudit returns the original delta when the audit caller fails", async () => {
  const drifted = bellyDelta();
  const caller: RefineLlmCaller = async () => {
    throw new Error("provider down");
  };
  const result = await runEntityAudit(caller, SOURCE_MD, drifted);
  assert.equal(result.adopted, false);
  assert.equal(result.delta, drifted);
});

// --- unit: occurrence-anchored audit prompt ---

test("buildAuditPrompt anchors each entity to its ±200-char occurrence context in the markdown", () => {
  const delta = bellyDelta({
    entities: [
      {
        name: "Melia Hotels International",
        type: "org",
        description: "The operator.",
        occurrences: ["operated by Melia Hotels International."],
      },
    ],
  });
  const prompt = buildAuditPrompt(SOURCE_MD, delta);
  assert.match(prompt, /\[Melia Hotels International\]/, "entity labeled context block");
  assert.match(prompt, /The hotel is operated by Melia Hotels International\./, "±200 chars around the quote hit");
  assert.match(prompt, /CURRENT ENTITIES:/);
  assert.match(prompt, /CURRENT RELATIONS:/);
});

test("buildAuditPrompt flags entities whose occurrences cannot be located", () => {
  const delta = bellyDelta({
    entities: [{ name: "Ghost Hotel", type: "location", description: "nowhere" }],
  });
  const prompt = buildAuditPrompt(SOURCE_MD, delta);
  assert.match(prompt, /\[Ghost Hotel\] NO OCCURRENCE FOUND/, "unlocatable entity flagged for the auditor");
});

// --- wiring through runRefinePass via the tool ---

interface CallRec {
  systemPrompt?: string;
  userContent: string;
}

/** Caller that answers the MAIN pass with mainResponses in order, then every AUDIT call with auditResponse. */
function mainThenAuditCaller(mainResponses: unknown[], auditResponse: unknown) {
  const calls: CallRec[] = [];
  let main = 0;
  const caller: RefineLlmCaller = async (ctx) => {
    calls.push({ systemPrompt: ctx.systemPrompt, userContent: ctx.userContent });
    const isAudit =
      ctx.systemPrompt.includes("consistency auditor") || JSON.stringify(ctx.schema) === JSON.stringify(AUDIT_ENTITIES_SCHEMA);
    const payload = isAudit ? auditResponse : mainResponses[Math.min(main, mainResponses.length - 1)];
    if (!isAudit) main += 1;
    return { usage: zeroUsage, message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(payload) }] } };
  };
  return { caller, calls };
}

async function captureWarn(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const d1 = mock.method(console, "warn", (...args: unknown[]) => void lines.push(args.map(String).join(" ")));
  const d2 = mock.method(console, "log", (...args: unknown[]) => void lines.push(args.map(String).join(" ")));
  try {
    await fn();
  } finally {
    d1.mock.restore();
    d2.mock.restore();
  }
  return lines;
}

test("mandatory audit gate: clean main pass still runs the audit; audited entities land in the STORED document", async () => {
  const drifted = bellyDelta();
  const { caller } = mainThenAuditCaller([drifted], AUDIT_CANONICAL);
  const recorder: { stored?: RefinedDocument } = {};
  const tool = createRefineDocumentTool({} as ModelRuntime, {
    httpCaller: caller,
    storageDir: "storage",
    storeImpl: fakeStore(recorder),
  });

  const logs = await captureWarn(async () => {
    await tool.execute("c", { markdown: SOURCE_MD }, undefined, undefined, {} as never);
  });

  assert.ok(recorder.stored, "document stored");
  const names = new Set(recorder.stored!.entities.map((e) => e.name));
  for (const r of recorder.stored!.relations) {
    assert.ok(names.has(r.source) && names.has(r.target), "stored relations are closed-world (audited set)");
  }
  assert.ok(
    logs.some((l) => l.includes("[refine_document] audit pass:") && /changed \d+ entities\/\d+ relations|no-op/.test(l)),
    `one audit-pass log line per document, got: ${JSON.stringify(logs)}`,
  );
});

test("Belly fixture regression: name drift no longer reaches the graph — audit canonicalizes before store", async () => {
  const { caller } = mainThenAuditCaller([bellyDelta()], AUDIT_CANONICAL);
  const recorder: { stored?: RefinedDocument } = {};
  const tool = createRefineDocumentTool({} as ModelRuntime, {
    httpCaller: caller,
    storageDir: "storage",
    storeImpl: fakeStore(recorder),
  });
  const result = await tool.execute("c", { markdown: SOURCE_MD }, undefined, undefined, {} as never);
  const details = result.details as { fallback?: boolean };

  assert.equal(details.fallback, undefined, "no mechanical fallback");
  assert.equal(recorder.stored!.entities.length, 2);
  assert.ok(!JSON.stringify(recorder.stored!.entities).includes("Belly"), "audited names only");
});

test("audit rescue: validation exhaustion → audit session fixes the delta instead of mechanical fallback", async () => {
  // Main pass always emits a NON-fuzzy ghost endpoint → repair loop exhausts.
  const badDelta = bellyDelta({
    relations: [{ source: "Zauberschloss Fantasia", target: "Melia Hotels International", keywords: ["near"], description: "d" }],
  });
  const { caller, calls } = mainThenAuditCaller([badDelta], AUDIT_CANONICAL);
  const recorder: { stored?: RefinedDocument } = {};
  const tool = createRefineDocumentTool({} as ModelRuntime, {
    httpCaller: caller,
    storageDir: "storage",
    storeImpl: fakeStore(recorder),
  });

  const logs = await captureWarn(async () => {
    await tool.execute("c", { markdown: SOURCE_MD }, undefined, undefined, {} as never);
  });
  const details = await (async () => {
    const result = await tool.execute("c", { markdown: SOURCE_MD }, undefined, undefined, {} as never);
    return result.details as { fallback?: boolean };
  })();

  assert.equal(details.fallback, undefined, "audit rescued the exhausted repair loop");
  const names = new Set(recorder.stored!.entities.map((e) => e.name));
  for (const r of recorder.stored!.relations) {
    assert.ok(names.has(r.source) && names.has(r.target), "rescued relations closed-world");
  }
  assert.ok(calls.some((c) => c.systemPrompt?.includes?.("consistency auditor")), "independent audit session invoked");
  assert.ok(
    logs.some((l) => /audit pass rescued/i.test(l)),
    `rescue logged, got: ${JSON.stringify(logs)}`,
  );
});

test("audit rescue failure still falls back mechanically (never worse than no audit)", async () => {
  const badDelta = bellyDelta({
    relations: [{ source: "Zauberschloss Fantasia", target: "Melia Hotels International", keywords: ["near"], description: "d" }],
  });
  // audit returns the SAME broken shape (empty entities + relations) → invalid → not adopted
  const { caller } = mainThenAuditCaller([badDelta], { entities: [], relations: badDelta.relations });
  const recorder: { stored?: RefinedDocument } = {};
  const tool = createRefineDocumentTool({} as ModelRuntime, {
    httpCaller: caller,
    storageDir: "storage",
    storeImpl: fakeStore(recorder),
  });
  const result = await tool.execute("c", { markdown: SOURCE_MD }, undefined, undefined, {} as never);
  const details = result.details as { fallback?: boolean };

  assert.equal(details.fallback, true, "mechanical fallback after failed rescue");
  assert.match(details.error ?? "", /cross-field validation/i);
  assert.deepEqual(recorder.stored!.entities, [], "fallback has no fabricated entities");
});

test("audit output invalid on the CLEAN path → pre-audit delta kept, document NOT dropped", async () => {
  const goodButDrifted = bellyDelta(); // passes lenient fuzzy validation
  const { caller } = mainThenAuditCaller([goodButDrifted], { entities: [], relations: goodButDrifted.relations });
  const recorder: { stored?: RefinedDocument } = {};
  const tool = createRefineDocumentTool({} as ModelRuntime, {
    httpCaller: caller,
    storageDir: "storage",
    storeImpl: fakeStore(recorder),
  });
  const result = await tool.execute("c", { markdown: SOURCE_MD }, undefined, undefined, {} as never);
  const details = result.details as { fallback?: boolean };

  assert.equal(details.fallback, undefined);
  assert.equal(recorder.stored!.entities.length, 2, "pre-audit entities kept");
  assert.match(
    JSON.stringify(recorder.stored!.relations),
    /Belly/,
    "original (pre-audit) RELATION set preserved — invalid audit output must not be adopted",
  );
});

// --- contract plumbing ---

test("REFINED_DOCUMENT_SCHEMA entities carry optional occurrences quotes", () => {
  const schema = JSON.parse(JSON.stringify(REFINED_DOCUMENT_SCHEMA)) as {
    properties: Record<string, { properties?: Record<string, unknown> }>;
  };
  const entities = schema.properties["entities"] as {
    items?: { properties?: Record<string, unknown> };
  };
  assert.ok(entities.items?.properties?.occurrences, "occurrences present in the emit schema");
});
