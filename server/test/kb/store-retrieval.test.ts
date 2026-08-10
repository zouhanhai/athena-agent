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

const GRAPH_ENTITY = (name: string, description: string, related: string[]) => ({
  id: name,
  text: description,
  score: 1.0,
  related,
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

test("Text2CypherRetriever traverses the entity graph (case-insensitive alias match)", async () => {
  const { driver, calls } = makeDriver((q, p) =>
    q.includes(ENTITY_NAME_ALIASES_FTX) && p.queryText === "zob münchen"
      ? [GRAPH_ENTITY("ZOB München", "central bus station", ["CALEO", "MVV"])]
      : [],
  );
  const retriever = new Text2CypherRetriever({ driver, topK: 5 });

  const hits = await retriever.search("ZOB MÜNCHEN");

  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.id, "ZOB München");
  assert.equal(hits[0]!.source, "graph");
  assert.deepEqual(hits[0]!.related, ["CALEO", "MVV"], "1-2 hop neighbors included");
  const call = calls.find((c) => c.query.includes(ENTITY_NAME_ALIASES_FTX))!;
  assert.ok(call.query.includes(":RELATION"), "traverses RELATION edges");
  assert.equal(call.params.queryText, "zob münchen", "query folded to lowercase");
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
    if (q.includes(ENTITY_NAME_ALIASES_FTX)) return [GRAPH_ENTITY("ZOB", "bus station", [])];
    return [];
  });
  const service = new Neo4jRetrievalService({ driver, embedder: stubEmbedder, topK: 5 });

  const response = await service.search("bus station");

  assert.equal(response.query, "bus station");
  const ids = response.hits.map((h) => h.id).sort();
  assert.deepEqual(ids, ["ZOB", "c1"], "BM25 + graph still returned when vector failed");
  assert.ok(response.hits.find((h) => h.source === "bm25"));
  assert.ok(response.hits.find((h) => h.source === "graph"));
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

test("retrieval hits carry documentId + topic for downstream mapping", async () => {
  const { driver } = makeDriver((q) => (q.includes(CHUNK_TEXT_FTX) ? [CHUNK("c1", "bus", "transport")] : []));
  const service = new Neo4jRetrievalService({ driver, embedder: stubEmbedder, topK: 5 });

  const { hits } = await service.search("bus");
  const hit: Neo4jSearchHit = hits[0]!;
  assert.equal(hit.documentId, "doc-c1");
  assert.equal(hit.topic, "transport");
});
