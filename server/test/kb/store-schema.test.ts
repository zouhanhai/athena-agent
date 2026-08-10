import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHUNK_LABEL,
  ENTITY_LABEL,
  DOCUMENT_LABEL,
  WIKIPAGE_LABEL,
  ENTITY_RELATION_TYPE,
  foldName,
  foldAliases,
  storeSchemaStatements,
  applyNeo4jSchema,
  type Neo4jDriverLike,
} from "../../src/kb/store/schema.js";

interface RecordedCall {
  query: string;
  params?: Record<string, unknown>;
}

test("storeSchemaStatements declares the four store node/edge labels", () => {
  const statements = storeSchemaStatements();
  const joined = statements.join("\n");
  assert.ok(joined.includes(`:${CHUNK_LABEL}`), "Chunk label referenced");
  assert.ok(joined.includes(`:${ENTITY_LABEL}`), "Entity label referenced");
  assert.ok(joined.includes(`:${DOCUMENT_LABEL}`), "Document label referenced");
  assert.ok(joined.includes(`:${WIKIPAGE_LABEL}`), "WikiPage label referenced");
});

test("exports the Entity relation edge type constant for ingest graph edges", () => {
  assert.equal(ENTITY_RELATION_TYPE, "RELATION");
});

test("storeSchemaStatements creates unique constraints on node ids", () => {
  const statements = storeSchemaStatements();
  const joined = statements.join("\n");
  for (const [label, prop] of [
    [CHUNK_LABEL, "id"],
    [ENTITY_LABEL, "name"],
    [DOCUMENT_LABEL, "id"],
    [WIKIPAGE_LABEL, "id"],
  ] as const) {
    assert.ok(
      statements.some(
        (s) => s.includes(`CREATE CONSTRAINT`) && s.includes(`:${label}`) && s.includes(`${prop} IS UNIQUE`),
      ),
      `unique constraint on ${label}.${prop} present`,
    );
  }
  assert.match(joined, /CREATE CONSTRAINT\s+\w+\s+IF NOT EXISTS/);
});

test("storeSchemaStatements creates a vector index on Chunk.embedding (cosine) with topic filter property", () => {
  const statements = storeSchemaStatements();
  const vectorStmt = statements.find((s) => s.includes("VECTOR INDEX"));
  assert.ok(vectorStmt, "vector index statement present");
  assert.ok(vectorStmt!.includes(":Chunk"), "vector index targets Chunk");
  assert.ok(vectorStmt!.includes("(n.embedding)"), "vector index on embedding property");
  assert.ok(vectorStmt!.includes("WITH [n.topic]"), "topic declared as additional filter property");
  assert.match(vectorStmt!, /vector\.dimensions`:\s*\d+/);
  assert.match(vectorStmt!, /cosine/);
});

test("storeSchemaStatements indexes folded (case-insensitive) name and aliases", () => {
  const statements = storeSchemaStatements();
  const joined = statements.join("\n");
  assert.ok(
    statements.some((s) => s.includes("RANGE INDEX") && s.includes("(n.nameUpper)")),
    "range index on folded nameUpper property present",
  );
  assert.ok(
    statements.some((s) => s.includes("FULLTEXT INDEX") && s.includes("n.aliases") && s.includes("n.name")),
    "fulltext index over name + aliases present (case/diacritic folding)",
  );
  assert.ok(joined.includes("IF NOT EXISTS"), "all schema statements are idempotent");
});

test("storeSchemaStatements creates a fulltext index over Chunk.text for BM25 retrieval", () => {
  const statements = storeSchemaStatements();
  assert.ok(
    statements.some((s) => s.includes("FULLTEXT INDEX") && s.includes("n.text")),
    "fulltext index over Chunk.text present",
  );
});

test("applyNeo4jSchema runs every schema statement via the driver and closes the session", async () => {
  const statements = storeSchemaStatements();
  const calls: RecordedCall[] = [];
  let closed = false;
  const driver: Neo4jDriverLike = {
    session() {
      return {
        run: async (query: string, params?: Record<string, unknown>) => {
          calls.push({ query, params });
          return { records: [] };
        },
        close: async () => {
          closed = true;
        },
      };
    },
  };

  await applyNeo4jSchema(driver);

  assert.equal(calls.length, statements.length, "each statement executed exactly once");
  for (const [i, stmt] of statements.entries()) {
    assert.equal(calls[i]!.query, stmt);
  }
  assert.equal(closed, true, "driver session closed after applying schema");
});

test("foldName folds to upper-case, unicode-aware (DE umlauts)", () => {
  assert.equal(foldName("ZOB München"), "ZOB MÜNCHEN");
  assert.equal(foldName("caleo"), "CALEO");
  assert.equal(foldName("lüsen"), "LÜSEN");
  assert.equal(foldName(""), "");
});

test("foldAliases folds every alias to upper-case", () => {
  assert.deepEqual(foldAliases(["Zentraler Omnibusbahnhof", "zob münchen"]), [
    "ZENTRALER OMNIBUSBAHNHOF",
    "ZOB MÜNCHEN",
  ]);
  assert.deepEqual(foldAliases([]), []);
});
