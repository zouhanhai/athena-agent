import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHUNK_EMBEDDING_INDEX,
  CHUNK_TEXT_FTX,
  ENTITY_NAME_ALIASES_FTX,
  type Neo4jDriverLike,
} from "../../src/kb/store/schema.js";
import {
  Neo4jRetrievalService,
  Text2CypherRetriever,
  ToolsRetriever,
  VectorRetriever,
  Bm25Retriever,
  type Neo4jSearchHit,
  type Reranker,
} from "../../src/kb/store/retrieval.js";
import type { TextEmbedder } from "../../src/kb/embedding.js";

interface RecordedCall {
  query: string;
  params: Record<string, unknown>;
}

/** A Neo4j record double: `get(key)` returns the mapped value. */
function record(obj: Record<string, unknown>): { get: (k: string) => unknown; keys: string[] } {
  return { get: (k) => obj[k], keys: Object.keys(obj) };
}

const stubEmbedder: TextEmbedder = {
  embed: async (texts) => texts.map((_, i) => [i + 1, i + 1]),
};

/**
 * Build a driver double whose run() dispatches on the query content: a VECTOR
 * INDEX SEARCH returns chunk records, a fulltext query over Chunk.text returns
 * BM25 records, an entity fulltext query returns graph records. Unmatched
 * queries return an empty record set.
 */
function makeDriver(handler?: (query: string, params: Record<string, unknown>) => Record<string, unknown>[]) {
  const calls: RecordedCall[] = [];
  const driver: Neo4jDriverLike = {
    session() {
      return {
        run: async (query: string, params?: Record<string, unknown>) => {
          const p = params ?? {};
          calls.push({ query, params: p });
          const records = handler?.(query, p) ?? [];
          return { records: records.map(record) };
        },
        close: async () => {},
      };
    },
  };
  return { driver, calls };
}

const CHUNK = (id: string, text: string, topic = "transport") => ({
  id,
  text,
  topic,
  documentId: `doc-${id}`,
  headingPath: `# ${id}`,
  score: 0.9,
});

/** A Chunk hit from the graph retriever (G4.S2.T14): the entity was matched, then
 *  its MENTIONED_IN chunks are returned with the entity + neighbor context. */
const GRAPH_CHUNK = (
  id: string,
  text: string,
  entity: string,
  neighbors: string[] = [],
  extra: Record<string, unknown> = {},
) => ({
  id,
  text,
  topic: "transport",
  documentId: `doc-${id}`,
  sectionPath: "Alpha",
  wikiPath: "wiki/transport/bus.md",
  score: 1.0,
  entity,
  neighbors,
  ...extra,
});

test("VectorRetriever embeds the query and issues a SEARCH VECTOR INDEX query over chunks", async () => {
  const { driver, calls } = makeDriver((q) => (q.includes("VECTOR INDEX") ? [CHUNK("c1", "bus station guide")] : []));
  const retriever = new VectorRetriever({ driver, embedder: stubEmbedder, topK: 5 });

  const hits = await retriever.search("central bus station");

  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.id, "c1");
  assert.equal(hits[0]!.text, "bus station guide");
  assert.equal(hits[0]!.source, "vector");
  const vectorCall = calls.find((c) => c.query.includes("VECTOR INDEX"));
  assert.ok(vectorCall, "vector SEARCH query issued");
  assert.ok(vectorCall!.query.includes(CHUNK_EMBEDDING_INDEX), "references the vector index");
  assert.ok(vectorCall!.query.includes("SEARCH c IN"), "uses the Cypher SEARCH clause");
  assert.deepEqual(vectorCall!.params.embedding, [1, 1], "query embedded into the FOR vector");
});

test("VectorRetriever applies an in-index topic filter when a topic is given", async () => {
  const { driver, calls } = makeDriver((q) => (q.includes("VECTOR INDEX") ? [CHUNK("c1", "tram schedule", "transport")] : []));
  const retriever = new VectorRetriever({ driver, embedder: stubEmbedder, topK: 5 });

  const hits = await retriever.search("tram", { topic: "transport" });

  assert.equal(hits.length, 1);
  const call = calls.find((c) => c.query.includes("VECTOR INDEX"))!;
  assert.match(call.query, /WHERE c\.topic IN \$topics/, "in-index topic predicate present");
  assert.deepEqual(call.params.topics, ["transport"]);
  assert.deepEqual(call.params.topK, 5);
});

test("VectorRetriever scopes to a topic-subtree topics list (G4.S3.T4)", async () => {
  const { driver, calls } = makeDriver((q) => (q.includes("VECTOR INDEX") ? [CHUNK("c1", "fiori guide", "sap/fiori")] : []));
  const retriever = new VectorRetriever({ driver, embedder: stubEmbedder, topK: 5 });

  const hits = await retriever.search("fiori", { topics: ["sap", "sap/fiori", "sap/s4hana"] });

  assert.equal(hits.length, 1);
  const call = calls.find((c) => c.query.includes("VECTOR INDEX"))!;
  assert.deepEqual(call.params.topics, ["sap", "sap/fiori", "sap/s4hana"], "subtree topic list applied");
  assert.match(call.query, /WHERE c\.topic IN \$topics/, "in-index predicate uses the expanded list");
});

test("Bm25Retriever scopes to a topic-subtree topics list (G4.S3.T4)", async () => {
  const { driver, calls } = makeDriver((q) => (q.includes(CHUNK_TEXT_FTX) ? [CHUNK("c1", "fiori guide", "sap/fiori")] : []));
  const retriever = new Bm25Retriever({ driver, topK: 5 });

  const hits = await retriever.search("fiori", { topics: ["sap", "sap/fiori"] });

  assert.equal(hits.length, 1);
  const call = calls.find((c) => c.query.includes(CHUNK_TEXT_FTX))!;
  assert.deepEqual(call.params.topics, ["sap", "sap/fiori"], "subtree topic list applied");
  assert.match(call.query, /WHERE c\.topic IN \$topics/, "BM25 predicate uses the expanded list");
});

test("Text2CypherRetriever scopes graph chunk hits to a topic-subtree topics list (G4.S3.T4)", async () => {
  const { driver, calls } = makeDriver((q, p) =>
    q.includes(ENTITY_NAME_ALIASES_FTX) && p.queryText === "sap"
      ? [GRAPH_CHUNK("doc:c1", "SAP runbook", "SAP", [], { topic: "sap/fiori" })]
      : [],
  );
  const retriever = new Text2CypherRetriever({ driver, topK: 5 });

  const hits = await retriever.search("sap", { topics: ["sap", "sap/fiori"] });

  assert.equal(hits.length, 1);
  const call = calls.find((c) => c.query.includes(ENTITY_NAME_ALIASES_FTX))!;
  assert.deepEqual(call.params.topics, ["sap", "sap/fiori"], "graph retriever scopes by the subtree topics");
  assert.match(call.query, /c\.topic IN \$topics/, "graph chunk predicate present");
});

test("Bm25Retriever queries the Chunk.text fulltext index and returns scored hits", async () => {
  const { driver, calls } = makeDriver((q, p) =>
    q.includes(CHUNK_TEXT_FTX) && p.queryText?.includes("omnibusbahnhof")
      ? [CHUNK("c1", "ZOB München central bus station")]
      : [],
  );
  const retriever = new Bm25Retriever({ driver, topK: 5 });

  const hits = await retriever.search("zentraler omnibusbahnhof");

  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.id, "c1");
  assert.equal(hits[0]!.source, "bm25");
  const call = calls.find((c) => c.query.includes(CHUNK_TEXT_FTX))!;
  assert.ok(call, "fulltext BM25 query issued");
  assert.match(call.query, /fulltext\.queryNodes/, "uses db.index.fulltext.queryNodes");
});

test("Bm25Retriever folds the query to lowercase (case-insensitive BM25)", async () => {
  const { driver, calls } = makeDriver((q, p) =>
    q.includes(CHUNK_TEXT_FTX) ? [CHUNK("c1", "ZOB bus")] : [],
  );
  const retriever = new Bm25Retriever({ driver, topK: 5 });

  await retriever.search("ZOB MÜNCHEN");

  const call = calls.find((c) => c.query.includes(CHUNK_TEXT_FTX))!;
  assert.equal(call.params.queryText, "zob münchen", "query folded to lowercase");
});

test("HybridRetriever fuses vector + BM25 hits with reciprocal rank fusion", async () => {
  const { driver } = makeDriver((q) => {
    if (q.includes("VECTOR INDEX")) return [CHUNK("c1", "bus guide"), CHUNK("c2", "tram")];
    if (q.includes(CHUNK_TEXT_FTX)) return [CHUNK("c2", "tram"), CHUNK("c3", "train")];
    return [];
  });
  const hybrid = new Neo4jRetrievalService({
    driver,
    embedder: stubEmbedder,
    topK: 5,
    picker: async () => "hybrid",
  });

  const response = await hybrid.search("tram");

  const ids = response.hits.map((h) => h.id).sort();
  assert.deepEqual(ids, ["c1", "c2", "c3"], "vector + BM25 hits fused");
  assert.ok(response.hits.find((h) => h.source === "vector"));
  assert.ok(response.hits.find((h) => h.source === "bm25"));
});

test("Text2CypherRetriever returns the MENTIONED_IN chunks of a matched entity as chunk hits", async () => {
  const { driver, calls } = makeDriver((q, p) =>
    q.includes(ENTITY_NAME_ALIASES_FTX) && p.queryText === "zob münchen"
      ? [GRAPH_CHUNK("doc:c1", "ZOB München is the central hub.", "ZOB München", ["CALEO", "MVV"])]
      : [],
  );
  const retriever = new Text2CypherRetriever({ driver, topK: 5 });

  const hits = await retriever.search("ZOB MÜNCHEN");

  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.id, "doc:c1", "graph hit id is the chunk id (RRF-fusable with vector/BM25)");
  assert.equal(hits[0]!.text, "ZOB München is the central hub.");
  assert.equal(hits[0]!.source, "graph");
  assert.deepEqual(hits[0]!.related, ["ZOB München", "CALEO", "MVV"], "entity + neighbors kept as context");
  const call = calls.find((c) => c.query.includes(ENTITY_NAME_ALIASES_FTX))!;
  assert.match(call.query, /MENTIONED_IN/, "traverses the entity → chunk MENTIONED_IN edge");
  assert.equal(call.params.queryText, "zob münchen", "query folded to lowercase");
});

test("graph chunk hits carry the T11 chunk shape: topic, documentId, sectionPath, wikiPath", async () => {
  const { driver } = makeDriver((q) =>
    q.includes(ENTITY_NAME_ALIASES_FTX)
      ? [GRAPH_CHUNK("doc:c1", "bus", "ZOB München", [], { topic: "transport", documentId: "doc" })]
      : [],
  );
  const retriever = new Text2CypherRetriever({ driver, topK: 5 });

  const hits = await retriever.search("ZOB");

  const hit = hits[0]!;
  assert.equal(hit.topic, "transport");
  assert.equal(hit.documentId, "doc");
  assert.equal(hit.sectionPath, "Alpha");
  assert.equal(hit.wikiPath, "wiki/transport/bus.md");
  assert.match(hits[0]!.text, /bus/);
});

test("case-insensitive node lookup: searching lowercase 'zob münchen' returns the chunk via the 'ZOB München' entity", async () => {
  const { driver, calls } = makeDriver((q, p) =>
    q.includes(ENTITY_NAME_ALIASES_FTX) && p.queryText === "zob münchen"
      ? [GRAPH_CHUNK("doc:c1", "ZOB München bus station", "ZOB München", ["CALEO"])]
      : [],
  );
  const retriever = new Text2CypherRetriever({ driver, topK: 5 });

  const hits = await retriever.search("zob münchen");

  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.id, "doc:c1", "lowercase query folds and lands on the entity's chunks");
  assert.deepEqual(hits[0]!.related, ["ZOB München", "CALEO"], "canonical entity name surfaces via context");
});

test("case-insensitive node lookup: searching 'caleo' matches the 'CALEO' node (case bug not repeated)", async () => {
  const { driver, calls } = makeDriver((q, p) =>
    q.includes(ENTITY_NAME_ALIASES_FTX) && p.queryText === "caleo"
      ? [GRAPH_CHUNK("doc:c1", "CALEO runs the show", "CALEO", ["ZOB München"])]
      : [],
  );
  const retriever = new Text2CypherRetriever({ driver, topK: 5 });

  const hits = await retriever.search("caleo");

  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0]!.related, ["CALEO", "ZOB München"], "case-sensitive lookup must not recur");
  const call = calls.find((c) => c.query.includes(ENTITY_NAME_ALIASES_FTX))!;
  assert.equal(call.params.queryText, "caleo", "query folded to lowercase before fulltext");
});

test("bilingual alias search: German term returns the chunk mentioning the EN node via its alias (DE→EN)", async () => {
  const { driver, calls } = makeDriver((q, p) =>
    q.includes(ENTITY_NAME_ALIASES_FTX) && p.queryText === "zentraler omnibusbahnhof"
      ? [GRAPH_CHUNK("doc:c1", "ZOB München", "ZOB München", ["MVV"])]
      : [],
  );
  const retriever = new Text2CypherRetriever({ driver, topK: 5 });

  const hits = await retriever.search("Zentraler Omnibusbahnhof");

  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0]!.related, ["ZOB München", "MVV"], "German term resolves to the EN canonical node via aliases");
  const call = calls.find((c) => c.query.includes(ENTITY_NAME_ALIASES_FTX))!;
  assert.equal(call.params.queryText, "zentraler omnibusbahnhof", "German query folded to lowercase");
});

test("bilingual alias search: English term returns the chunk mentioning the DE node via its alias (EN→DE)", async () => {
  const { driver, calls } = makeDriver((q, p) =>
    q.includes(ENTITY_NAME_ALIASES_FTX) && p.queryText === "munich central bus station"
      ? [GRAPH_CHUNK("doc:c1", "Zentraler Omnibusbahnhof München", "Zentraler Omnibusbahnhof München", ["MVV"])]
      : [],
  );
  const retriever = new Text2CypherRetriever({ driver, topK: 5 });

  const hits = await retriever.search("Munich Central Bus Station");

  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0]!.related, ["Zentraler Omnibusbahnhof München", "MVV"], "English term resolves to the DE canonical node via aliases");
  const call = calls.find((c) => c.query.includes(ENTITY_NAME_ALIASES_FTX))!;
  assert.equal(call.params.queryText, "munich central bus station", "English query folded to lowercase");
});

test("fused search surfaces graph chunk hits from a bilingual alias match", async () => {
  const { driver } = makeDriver((q, p) => {
    if (q.includes(ENTITY_NAME_ALIASES_FTX) && p.queryText === "zentraler omnibusbahnhof") {
      return [GRAPH_CHUNK("doc:c1", "ZOB München bus station", "ZOB München", ["MVV"])];
    }
    return [];
  });
  const service = new Neo4jRetrievalService({ driver, embedder: stubEmbedder, topK: 5 });

  const response = await service.search("Zentraler Omnibusbahnhof");

  assert.ok(
    response.hits.some((h) => h.id === "doc:c1" && h.source === "graph" && h.related?.includes("ZOB München")),
    "German term fuses into the chunk mentioning the EN node via the alias fulltext graph retriever",
  );
});

test("ToolsRetriever lets the picker choose the best retriever per query", async () => {
  const { driver, calls } = makeDriver((q) => (q.includes(CHUNK_TEXT_FTX) ? [CHUNK("c1", "runbook")] : []));
  const service = new Neo4jRetrievalService({
    driver,
    embedder: stubEmbedder,
    topK: 5,
    picker: async (query) => (query.includes("runbook") ? "bm25" : "hybrid"),
  });
  const tools = new ToolsRetriever({
    driver,
    embedder: stubEmbedder,
    topK: 5,
    picker: async (query) => (query.includes("runbook") ? "bm25" : "hybrid"),
  });

  const bm25Hits = await tools.search("find the runbook");
  assert.equal(bm25Hits.length, 1);
  assert.equal(bm25Hits[0]!.source, "bm25");
  assert.ok(calls.some((c) => c.query.includes(CHUNK_TEXT_FTX)), "bm25 retriever ran");
  assert.ok(!calls.some((c) => c.query.includes("VECTOR INDEX")), "vector retriever skipped");
  assert.equal(typeof service.search, "function");
});

test("Neo4jRetrievalService.search returns fused results and tolerates a failing source", async () => {
  const { driver } = makeDriver((q) => {
    if (q.includes("VECTOR INDEX")) throw new Error("embedding down");
    if (q.includes(CHUNK_TEXT_FTX)) return [CHUNK("c1", "bus")];
    if (q.includes(ENTITY_NAME_ALIASES_FTX)) return [GRAPH_CHUNK("doc:c2", "bus station guide", "ZOB", [])];
    return [];
  });
  const service = new Neo4jRetrievalService({ driver, embedder: stubEmbedder, topK: 5 });

  const response = await service.search("bus station");

  assert.equal(response.query, "bus station");
  const ids = response.hits.map((h) => h.id).sort();
  assert.deepEqual(ids, ["c1", "doc:c2"], "BM25 + graph chunks still returned when vector failed");
  assert.ok(response.hits.find((h) => h.source === "bm25"));
  assert.ok(response.hits.find((h) => h.source === "graph"));
});

test("fused search RRF-fuses graph chunks into the ranking (not appended last)", async () => {
  const { driver } = makeDriver((q) => {
    if (q.includes("VECTOR INDEX")) return [CHUNK("c1", "tram line 1"), CHUNK("c2", "tram line 2")];
    if (q.includes(CHUNK_TEXT_FTX)) return [CHUNK("c2", "tram line 2"), CHUNK("c3", "tram line 3")];
    // graph-only chunk: found by no other source — must rank via its RRF position
    if (q.includes(ENTITY_NAME_ALIASES_FTX)) return [GRAPH_CHUNK("doc:c9", "tram hub", "ZOB", [])];
    return [];
  });
  const service = new Neo4jRetrievalService({ driver, embedder: stubEmbedder, topK: 5 });

  const response = await service.search("tram");

  const ids = response.hits.map((h) => h.id);
  assert.ok(ids.includes("doc:c9"), "graph-only chunk fused into the ranked hits");
  assert.ok(ids.length < 4 || ids.indexOf("doc:c9") < ids.length - 1, "graph chunk participates in fusion order");
  assert.ok(response.hits.find((h) => h.source === "graph"));
});

test("fused search dedupes a chunk found by multiple sources (graph vs vector) by id", async () => {
  const { driver } = makeDriver((q) => {
    if (q.includes("VECTOR INDEX")) return [CHUNK("doc:c1", "hub", "transport")];
    if (q.includes(ENTITY_NAME_ALIASES_FTX)) return [GRAPH_CHUNK("doc:c1", "hub", "ZOB")];
    return [];
  });
  const service = new Neo4jRetrievalService({ driver, embedder: stubEmbedder, topK: 5 });

  const response = await service.search("hub");

  const ids = response.hits.map((h) => h.id);
  assert.equal(new Set(ids).size, ids.length, "no duplicate chunk ids across sources");
});

test("Neo4jRetrievalService.search returns empty hits when every source fails", async () => {
  const { driver } = makeDriver(() => {
    throw new Error("neo4j down");
  });
  const service = new Neo4jRetrievalService({ driver, embedder: stubEmbedder, topK: 5 });

  const response = await service.search("anything");
  assert.deepEqual(response.hits, []);
  assert.equal(response.query, "anything");
});

test("Neo4jRetrievalService.search propagates the topic filter to chunk retrievers", async () => {
  const { driver, calls } = makeDriver((q) => {
    if (q.includes("VECTOR INDEX")) return [CHUNK("c1", "tram", "transport")];
    if (q.includes(CHUNK_TEXT_FTX)) return [CHUNK("c2", "tram", "transport")];
    return [];
  });
  const service = new Neo4jRetrievalService({ driver, embedder: stubEmbedder, topK: 5 });

  const response = await service.search("tram", { topic: "transport" });

  assert.equal(response.hits.length, 2);
  for (const call of calls) {
    if (call.query.includes(CHUNK_TEXT_FTX) || call.query.includes("VECTOR INDEX")) {
      assert.deepEqual(call.params.topics, ["transport"], "topic filter applied");
    }
  }
});

test("Neo4jRetrievalService.search propagates the topic-subtree list to chunk + graph retrievers (G4.S3.T4)", async () => {
  const { driver, calls } = makeDriver((q) => {
    if (q.includes("VECTOR INDEX")) return [CHUNK("c1", "tram", "sap/fiori")];
    if (q.includes(CHUNK_TEXT_FTX)) return [CHUNK("c2", "tram", "sap/s4hana")];
    if (q.includes(ENTITY_NAME_ALIASES_FTX)) return [GRAPH_CHUNK("doc:c3", "tram", "SAP", [], { topic: "sap" })];
    return [];
  });
  const service = new Neo4jRetrievalService({ driver, embedder: stubEmbedder, topK: 5 });

  const response = await service.search("tram", { topics: ["sap", "sap/fiori", "sap/s4hana"] });

  assert.equal(response.hits.length, 3);
  const topicCalls = calls.filter(
    (c) =>
      c.query.includes(CHUNK_TEXT_FTX) ||
      c.query.includes("VECTOR INDEX") ||
      c.query.includes(ENTITY_NAME_ALIASES_FTX),
  );
  assert.ok(topicCalls.length >= 3, "all three retrievers ran");
  for (const call of topicCalls) {
    assert.deepEqual(call.params.topics, ["sap", "sap/fiori", "sap/s4hana"], "subtree topics propagated");
  }
});

test("retrieval hits carry documentId + topic for downstream mapping", async () => {
  const { driver } = makeDriver((q) => (q.includes(CHUNK_TEXT_FTX) ? [CHUNK("c1", "bus", "transport")] : []));
  const service = new Neo4jRetrievalService({ driver, embedder: stubEmbedder, topK: 5 });

  const { hits } = await service.search("bus");
  const hit: Neo4jSearchHit = hits[0]!;
  assert.equal(hit.documentId, "doc-c1");
  assert.equal(hit.topic, "transport");
});

test("vector retriever joins chunks to their Section chain and Document → WikiPage", async () => {
  const { driver, calls } = makeDriver((q) => (q.includes("VECTOR INDEX") ? [CHUNK("c1", "bus")] : []));
  const retriever = new VectorRetriever({ driver, embedder: stubEmbedder, topK: 5 });

  await retriever.search("bus");

  const call = calls.find((c) => c.query.includes("VECTOR INDEX"))!;
  assert.match(call.query, /PART_OF/, "joins the chunk to its Section");
  assert.match(call.query, /IS_DOCUMENT/, "joins Document → WikiPage");
  assert.match(call.query, /sectionPath/, "returns the section heading path");
  assert.match(call.query, /wikiPath/, "returns the wiki page path");
});

test("chunk hits carry wikiPath + sectionPath from the section/wiki join", async () => {
  const { driver } = makeDriver((q) =>
    q.includes(CHUNK_TEXT_FTX)
      ? [{ ...CHUNK("c1", "bus"), sectionPath: "Alpha / Beta", wikiPath: "wiki/transport/bus.md" }]
      : [],
  );
  const service = new Neo4jRetrievalService({ driver, embedder: stubEmbedder, topK: 5 });

  const { hits } = await service.search("bus");
  const hit: Neo4jSearchHit = hits[0]!;
  assert.equal(hit.sectionPath, "Alpha / Beta");
  assert.equal(hit.wikiPath, "wiki/transport/bus.md");
});

test("sameSectionTexts returns the sibling chunks that share the hit's deepest Section", async () => {
  const { driver } = makeDriver((q) => {
    if (q.includes("sib.id <> c.id")) {
      return [
        { id: "doc:c2", text: "sibling two", topic: "transport", documentId: "doc", sectionPath: "Alpha / Beta" },
        { id: "doc:c3", text: "sibling three", topic: "transport", documentId: "doc", sectionPath: "Alpha / Beta" },
      ];
    }
    return [];
  });
  const service = new Neo4jRetrievalService({ driver, embedder: stubEmbedder, topK: 5 });

  const texts = await service.sameSectionTexts({ id: "doc:c1" }, 4);
  assert.deepEqual(texts, ["sibling two", "sibling three"]);
});

test("sameSectionTexts scopes sibling lookup to the hit's deepest Section", async () => {
  const { driver, calls } = makeDriver(() => [{ id: "doc:c2", text: "sibling two" }]);
  const service = new Neo4jRetrievalService({ driver, embedder: stubEmbedder, topK: 5 });

  await service.sameSectionTexts({ id: "doc:c1" }, 2);

  const call = calls.find((c) => c.query.includes("sib.id <> c.id"))!;
  assert.deepEqual(call.params, { id: "doc:c1", limit: 2 }, "matches by chunk id + limits");
  assert.match(call.query, /PART_OF/, "traverses through the shared Section");
  assert.match(call.query, /sib.id <> c.id/, "excludes the hit chunk itself");
});

test("search with enrichContext attaches same-section sibling texts to chunk hits", async () => {
  const { driver } = makeDriver((q, p) => {
    if (q.includes("VECTOR INDEX")) return [CHUNK("c1", "bus"), CHUNK("c2", "tram")];
    if (q.includes("sib.id <> c.id")) {
      return p.id === "c1" ? [{ id: "doc-c1:c9", text: "same-section sibling" }] : [];
    }
    return [];
  });
  const service = new Neo4jRetrievalService({ driver, embedder: stubEmbedder, topK: 5 });

  const { hits } = await service.search("bus", { enrichContext: true });
  const bus = hits.find((h) => h.id === "c1")!;
  assert.deepEqual(bus.siblings, ["same-section sibling"], "same-section context attached");
  assert.ok(!("siblings" in hits.find((h) => h.id === "c2")!), "no siblings when the section has none");
});

test("search without enrichContext leaves hits untouched", async () => {
  const { driver, calls } = makeDriver((q) => (q.includes(CHUNK_TEXT_FTX) ? [CHUNK("c1", "bus")] : []));
  const service = new Neo4jRetrievalService({ driver, embedder: stubEmbedder, topK: 5 });

  const { hits } = await service.search("bus");
  assert.equal(hits[0]!.siblings, undefined);
  assert.ok(
    !calls.some((c) => c.query.includes("sib.id <> c.id")),
    "no sibling enrichment queries when disabled",
  );
});

test("search reranks the fused hits with the injected reranker (query + fused top-k)", async () => {
  const { driver } = makeDriver((q) => {
    if (q.includes("VECTOR INDEX")) return [CHUNK("c1", "a"), CHUNK("c2", "b"), CHUNK("c3", "c")];
    return [];
  });
  const rerankCalls: Array<{ query: string; count: number }> = [];
  const reranker: Reranker = {
    rerank: async (query, hits) => {
      rerankCalls.push({ query, count: hits.length });
      return [...hits].reverse();
    },
  };
  const service = new Neo4jRetrievalService({ driver, embedder: stubEmbedder, topK: 5, reranker });

  const response = await service.search("tram");

  assert.deepEqual(
    response.hits.map((h) => h.id),
    ["c3", "c2", "c1"],
    "reranker's order wins over the RRF order",
  );
  assert.deepEqual(rerankCalls, [{ query: "tram", count: 3 }], "reranker saw the query + fused top-k");
});

test("search falls back to the RRF-only ranking when the reranker fails", async () => {
  const { driver } = makeDriver((q) => {
    if (q.includes("VECTOR INDEX")) return [CHUNK("c1", "a"), CHUNK("c2", "b")];
    return [];
  });
  const reranker: Reranker = {
    rerank: async () => {
      throw new Error("rerank endpoint down");
    },
  };
  const service = new Neo4jRetrievalService({ driver, embedder: stubEmbedder, topK: 5, reranker });

  const response = await service.search("tram");

  assert.deepEqual(
    response.hits.map((h) => h.id),
    ["c1", "c2"],
    "no regression when reranking is unavailable",
  );
});

test("search skips reranking entirely when no reranker is configured", async () => {
  const { driver } = makeDriver((q) => (q.includes("VECTOR INDEX") ? [CHUNK("c1", "a")] : []));
  const service = new Neo4jRetrievalService({ driver, embedder: stubEmbedder, topK: 5 });

  const response = await service.search("tram");

  assert.equal(response.hits[0]!.id, "c1");
});
