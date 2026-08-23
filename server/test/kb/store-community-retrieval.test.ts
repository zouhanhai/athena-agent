import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMMUNITY_SUMMARY_EMBEDDING_INDEX,
  COMMUNITY_SUMMARY_FTX,
  ENTITY_NAME_ALIASES_FTX,
  CHUNK_TEXT_FTX,
  type Neo4jDriverLike,
} from "../../src/kb/store/schema.js";
import {
  CommunityMemberChunksRetriever,
  CommunitySummaryBm25Retriever,
  CommunitySummaryVectorRetriever,
  Neo4jRetrievalService,
  type Reranker,
} from "../../src/kb/store/retrieval.js";
import type { TextEmbedder } from "../../src/kb/embedding.js";

interface RecordedCall {
  query: string;
  params: Record<string, unknown>;
}

function record(obj: Record<string, unknown>): { get: (k: string) => unknown } {
  return { get: (k) => obj[k] };
}

const stubEmbedder: TextEmbedder = {
  embed: async (texts) => texts.map(() => [1, 2]),
};

function makeDriver(handler?: (query: string, params: Record<string, unknown>) => Record<string, unknown>[]) {
  const calls: RecordedCall[] = [];
  const driver: Neo4jDriverLike = {
    session() {
      return {
        run: async (query: string, params?: Record<string, unknown>) => {
          const p = params ?? {};
          calls.push({ query, params: p });
          return { records: (handler?.(query, p) ?? []).map(record) };
        },
        close: async () => {},
      };
    },
  };
  return { driver, calls };
}

const SUMMARY_ROW = (id: string, theme: string) => ({
  id,
  text: `${theme} summary of ${id}`,
  theme,
  score: id === "c_caleo" ? 0.9 : 0.5,
});

const MEMBER_CHUNK = (id: string, text: string) => ({
  id,
  text,
  topic: "internal/events",
  documentId: `doc-${id}`,
  sectionPath: "Infos Sommerseminar",
  wikiPath: "wiki/events/sommer.md",
});

test("CommunitySummaryVectorRetriever searches the community-summary vector index and tags hits", async () => {
  const { driver, calls } = makeDriver((q) =>
    q.includes(COMMUNITY_SUMMARY_EMBEDDING_INDEX) ? [SUMMARY_ROW("c_caleo", "CALEO events")] : [],
  );
  const retriever = new CommunitySummaryVectorRetriever({ driver, embedder: stubEmbedder, topK: 3 });

  const hits = await retriever.search("what events does CALEO organize");

  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.id, "c_caleo");
  assert.equal(hits[0]!.communityId, "c_caleo");
  assert.ok(hits[0]!.text.includes("CALEO events"), "summary text carried");
  assert.equal(hits[0]!.topic, "CALEO events", "theme surfaces as topic");
  const call = calls.find((c) => c.query.includes(COMMUNITY_SUMMARY_EMBEDDING_INDEX))!;
  assert.match(call.query, /SEARCH/, "uses the vector SEARCH clause");
  assert.deepEqual(call.params.embedding, [1, 2], "query embedded");
  assert.deepEqual(call.params.topK, 3);
});

test("CommunitySummaryBm25Retriever queries the community fulltext index with a folded query", async () => {
  const { driver, calls } = makeDriver((q) =>
    q.includes(COMMUNITY_SUMMARY_FTX) ? [SUMMARY_ROW("c_sap", "SAP consolidation")] : [],
  );
  const retriever = new CommunitySummaryBm25Retriever({ driver, topK: 3 });

  const hits = await retriever.search("SAP Consolidation");

  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.communityId, "c_sap");
  const call = calls.find((c) => c.query.includes(COMMUNITY_SUMMARY_FTX))!;
  assert.match(call.query, /fulltext\.queryNodes/);
  assert.equal(call.params.queryText, "sap consolidation");
});

test("CommunityMemberChunksRetriever walks MENTIONED_IN chunks of the picked communities", async () => {
  const { driver, calls } = makeDriver(() => [MEMBER_CHUNK("d1:c1", "CALEO organizes the Sommerseminar in Lüsen.")]);
  const retriever = new CommunityMemberChunksRetriever({ driver, topK: 5 });

  const hits = await retriever.search(["c_caleo", "c_sap"]);

  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.source, "graph");
  const call = calls.find((c) => c.query.includes("UNWIND $communityIds"))!;
  assert.match(call.query, /:MEMBER]->\(e:Entity\)/, "community membership edge walked");
  assert.match(call.query, /MENTIONED_IN/, "member entities fall through to their chunks");
  assert.deepEqual(call.params.communityIds, ["c_caleo", "c_sap"]);
});

test("scope=global on the Sommerseminar corpus: embed query → top summaries → best communities → member chunks → fusion (+rerank)", async () => {
  // Community shaped like T1/T2 produce it on the Sommerseminar fixtures:
  // CALEO + Sommerseminar + ZOB München + Lüsen + C-Day + Mitarbeiter.
  const CALEO_SUMMARY =
    "CALEOs Eventwelt: CALEO organisiert das Sommerseminar in Lüsen und den C-Day für alle Mitarbeiter.";
  const { driver, calls } = makeDriver((q, p) => {
    if (q.includes(COMMUNITY_SUMMARY_EMBEDDING_INDEX)) {
      return [
        { id: "c_caleo", text: CALEO_SUMMARY, theme: "CALEO Events", score: 0.9 },
        { id: "c_sap", text: "SAP topics summary", theme: "SAP topics", score: 0.5 },
        { id: "c_misc", text: "misc summary", theme: "misc", score: 0.4 },
        { id: "c_extra", text: "extra summary", theme: "extra", score: 0.3 }, // ranked 4th → dropped
      ];
    }
    if (q.includes(COMMUNITY_SUMMARY_FTX)) {
      return [{ id: "c_sap", text: "SAP topics summary", theme: "SAP topics", score: 2 }];
    }
    if (q.includes("UNWIND $communityIds")) {
      assert.deepEqual(
        [...p.communityIds].sort(),
        ["c_caleo", "c_misc", "c_sap"],
        "the top-ranked communities are expanded (cap 3)",
      );
      return [
        MEMBER_CHUNK("sommerseminar-2026:c1", "Infos Sommerseminar 2026 — CALEO organisiert das Sommerseminar in Lüsen."),
        MEMBER_CHUNK("cday-finance:c1", "C-Day für die CALEOs — richtet sich an alle Mitarbeiter."),
      ];
    }
    return [];
  });
  const rerankedWith: string[] = [];
  const reranker: Reranker = {
    rerank: async (_query, hits) => {
      rerankedWith.push(...hits.map((h) => h.id));
      return hits;
    },
  };
  const service = new Neo4jRetrievalService({
    driver,
    embedder: stubEmbedder,
    topK: 5,
    reranker,
  });

  const response = await service.search("was veranstaltet CALEO im Jahr?", { scope: "global" });

  const ids = response.hits.map((h) => h.id);
  assert.ok(ids.includes("sommerseminar-2026:c1"), "member chunk from the best community is in the answer pool");
  assert.ok(ids.includes("c_caleo"), "community summary itself is fused in (grounded content)");
  assert.ok(
    response.hits.find((h) => h.communityId === "c_caleo")?.text.includes("Sommerseminar"),
    "the answer pool carries the community-grounded summary content",
  );
  assert.ok(!ids.includes("c_extra"), "only the top 1-3 communities are selected");
  const summaryHit = response.hits.find((h) => h.communityId !== undefined)!;
  assert.ok(summaryHit, "summary hits stay tagged as community hits after fusion");
  assert.ok(
    rerankedWith.some((id) => id.startsWith("c_")) && rerankedWith.some((id) => !id.startsWith("c_")),
    "rerank sees summaries + member chunks together",
  );
  assert.ok(
    !calls.some((c) => c.query.includes(CHUNK_TEXT_FTX)),
    "global scope does NOT run the per-chunk BM25 source",
  );
});

test("scope=global degrades gracefully when no community summaries exist yet", async () => {
  const { driver } = makeDriver(); // every query → no rows
  const service = new Neo4jRetrievalService({ driver, embedder: stubEmbedder, topK: 5 });

  const response = await service.search("anything", { scope: "global" });

  assert.deepEqual(response.hits, [], "no summaries → empty result, never throws");
});

test("default (scope unset/local) keeps the current fused behavior and never touches community indexes", async () => {
  const { driver, calls } = makeDriver((q) => {
    if (q.includes(CHUNK_TEXT_FTX)) return [{ id: "d1:c1", text: "bus", topic: "t", documentId: "d1", score: 1 }];
    if (q.includes(ENTITY_NAME_ALIASES_FTX)) return [];
    return [];
  });
  const service = new Neo4jRetrievalService({ driver, embedder: stubEmbedder, topK: 5 });

  const response = await service.search("bus");

  assert.equal(response.hits.length, 1);
  assert.equal(response.hits[0]!.id, "d1:c1");
  assert.ok(!calls.some((c) => c.query.includes(COMMUNITY_SUMMARY_FTX)), "no community BM25");
  assert.ok(!calls.some((c) => c.query.includes(COMMUNITY_SUMMARY_EMBEDDING_INDEX)), "no community vector");
  assert.ok(!calls.some((c) => c.query.includes("UNWIND $communityIds")), "no member walk");
});

test("graph retriever expands neighbors over RELATION|CO_OCCURS (G4.S9.T3 graph expansion)", async () => {
  const { driver, calls } = makeDriver((q) =>
    q.includes(ENTITY_NAME_ALIASES_FTX)
      ? [{
          id: "doc:c1",
          text: "chunk",
          entity: "CALEO",
          neighbors: ["ZOB München"],
          score: 1,
        }]
      : [],
  );
  const retriever = new Neo4jRetrievalService({ driver, embedder: stubEmbedder });

  await retriever.toolsSearch("caleo", { retriever: "graph" });

  const call = calls.find((c) => c.query.includes(ENTITY_NAME_ALIASES_FTX))!;
  assert.match(
    call.query,
    /RELATION\|CO_OCCURS/,
    "neighbor context traverses real relations AND weak co-occurrence edges",
  );
});
