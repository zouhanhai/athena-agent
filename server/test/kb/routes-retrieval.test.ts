import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../src/app.js";
import type { FastifyInstance } from "fastify";
import type { KnowledgeRetrievalService } from "../../src/kb/retrieval.js";

function stubRetrieval(
  overrides: Partial<KnowledgeRetrievalService> = {},
): KnowledgeRetrievalService {
  return {
    getGraph: async () => ({
      nodes: [{ id: "n1", label: "Alpha", type: "concept" }],
      edges: [{ source: "n1", target: "n2", weight: 1 }],
    }),
    getWikiTree: async () => [{ name: "runbook.md", path: "runbook.md", isDir: false }],
    readWikiPage: async (path: string) => ({ path, content: "# Runbook\nbody" }),
    getWikiCodeMeta: async () => ({
      type: "code",
      system: "S4H",
      devclass: "ZFI",
      chunks: [],
    }),
    readWikiImage: async (path: string) => ({
      data: Buffer.from(`bytes-of:${path}`),
      contentType: "image/png",
    }),
    search: async (query: string) => ({
      query,
      results: [{ source: "llmwiki", title: "Runbook", snippet: "Incident handling" }],
    }),
    ...overrides,
  } as unknown as KnowledgeRetrievalService;
}

async function appWith(retrieval: KnowledgeRetrievalService): Promise<FastifyInstance> {
  const app = buildApp({ retrieval });
  return app;
}

test("GET /api/kb/graph returns nodes/edges from the Neo4j store", async () => {
  const app = await appWith(stubRetrieval());
  try {
    const res = await app.inject({ method: "GET", url: "/api/kb/graph" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.nodes.length, 1);
    assert.equal(body.nodes[0].label, "Alpha");
    assert.equal(body.edges.length, 1);
  } finally {
    await app.close();
  }
});

test("GET /api/kb/graph ignores label/topic query params (full Neo4j graph, G4.S2.T10)", async () => {
  let calls = 0;
  const app = await appWith(
    stubRetrieval({
      getGraph: async () => {
        calls += 1;
        return { nodes: [], edges: [] };
      },
    }),
  );
  try {
    const res = await app.inject({ method: "GET", url: "/api/kb/graph?label=finance&topic=sommerseminar" });
    assert.equal(res.statusCode, 200);
    assert.equal(calls, 1, "the store graph is fetched without label/topic filtering");
  } finally {
    await app.close();
  }
});

test("GET /api/kb/graph/topics returns the topic list", async () => {
  const app = await appWith(
    stubRetrieval({
      getGraphTopics: async () => ["ops", "sommerseminar"],
    }),
  );
  try {
    const res = await app.inject({ method: "GET", url: "/api/kb/graph/topics" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { topics: ["ops", "sommerseminar"] });
  } finally {
    await app.close();
  }
});

test("GET /api/kb/wiki returns the wiki page tree", async () => {
  const app = await appWith(stubRetrieval());
  try {
    const res = await app.inject({ method: "GET", url: "/api/kb/wiki" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.files.length, 1);
    assert.equal(body.files[0].name, "runbook.md");
  } finally {
    await app.close();
  }
});

test("GET /api/kb/wiki/page requires a path", async () => {
  const app = await appWith(stubRetrieval());
  try {
    const res = await app.inject({ method: "GET", url: "/api/kb/wiki/page" });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error ?? "", /path is required/);
  } finally {
    await app.close();
  }
});

test("GET /api/kb/wiki/page returns markdown content", async () => {
  const app = await appWith(stubRetrieval());
  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/kb/wiki/page?path=runbook.md",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.path, "runbook.md");
    assert.match(body.content, /^# Runbook/);
  } finally {
    await app.close();
  }
});

test("GET /api/kb/wiki/image streams image bytes with the right content-type (G3.S5.T5)", async () => {
  let seenPath: string | undefined;
  const app = await appWith(
    stubRetrieval({
      readWikiImage: async (path: string) => {
        seenPath = path;
        return { data: Buffer.from("PNG-BYTES"), contentType: "image/png" };
      },
    }),
  );
  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/kb/wiki/image?path=wiki/sommerseminar/images/report.pdf/image_000000_abc.png",
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "image/png");
    assert.equal(res.rawPayload.toString(), "PNG-BYTES");
    assert.equal(seenPath, "wiki/sommerseminar/images/report.pdf/image_000000_abc.png");
  } finally {
    await app.close();
  }
});

test("GET /api/kb/wiki/image rejects missing and unsafe paths", async () => {
  const app = await appWith(stubRetrieval());
  try {
    const missing = await app.inject({ method: "GET", url: "/api/kb/wiki/image" });
    assert.equal(missing.statusCode, 400);
    for (const path of ["", "foo.png", "wiki/../etc/passwd", "/etc/passwd", "sommerseminar/images/a.png"]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/kb/wiki/image?path=${encodeURIComponent(path)}`,
      });
      assert.equal(res.statusCode, 400, `path=${path}`);
    }
  } finally {
    await app.close();
  }
});

test("GET /api/kb/wiki/image returns 404 when the image file is missing", async () => {
  const app = await appWith(
    stubRetrieval({
      readWikiImage: async () => {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      },
    }),
  );
  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/kb/wiki/image?path=wiki/concepts/images/missing.png",
    });
    assert.equal(res.statusCode, 404);
    assert.match(res.json().error ?? "", /not found/);
  } finally {
    await app.close();
  }
});

// G4.S8.T11: code-meta API.

test("GET /api/kb/wiki/code-meta requires a path", async () => {
  const app = await appWith(stubRetrieval());
  try {
    const res = await app.inject({ method: "GET", url: "/api/kb/wiki/code-meta" });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error ?? "", /path is required/);
  } finally {
    await app.close();
  }
});

test("GET /api/kb/wiki/code-meta returns the structured code metadata", async () => {
  let seenPath: string | undefined;
  const app = await appWith(
    stubRetrieval({
      getWikiCodeMeta: async (path: string) => {
        seenPath = path;
        return {
          type: "code",
          topic: "code/S4H",
          system: "S4H",
          devclass: "ZFI",
          transport: "K900123",
          chunks: [
            { id: "ddic-1", path: "MARA/_header", heading_path: "MARA/_header", metadata: { tableName: "MARA", fields: [] } },
          ],
        };
      },
    }),
  );
  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/kb/wiki/code-meta?path=wiki%2Fcode%2FS4H%2Fmara.md",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.type, "code");
    assert.equal(body.system, "S4H");
    assert.equal(body.devclass, "ZFI");
    assert.equal(body.transport, "K900123");
    assert.equal(body.chunks.length, 1);
    assert.equal(body.chunks[0].path, "MARA/_header");
    assert.equal(body.chunks[0].metadata.tableName, "MARA");
    assert.equal(seenPath, "wiki/code/S4H/mara.md");
  } finally {
    await app.close();
  }
});

test("GET /api/kb/wiki/code-meta returns 404 for a missing or non-code page", async () => {
  let calls = 0;
  const nullApp = await appWith(
    stubRetrieval({
      getWikiCodeMeta: async () => {
        calls += 1;
        return null;
      },
    }),
  );
  try {
    const res = await nullApp.inject({
      method: "GET",
      url: "/api/kb/wiki/code-meta?path=wiki%2Fconcepts%2Fnote.md",
    });
    assert.equal(res.statusCode, 404);
    assert.match(res.json().error ?? "", /not found/);
    assert.equal(calls, 1);
  } finally {
    await nullApp.close();
  }
});

test("GET /api/kb/wiki/code-meta maps service errors to 500", async () => {
  const app = await appWith(
    stubRetrieval({
      getWikiCodeMeta: async () => {
        throw new Error("store down");
      },
    }),
  );
  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/kb/wiki/code-meta?path=wiki%2Fcode%2FS4H%2Fmara.md",
    });
    assert.equal(res.statusCode, 500);
    assert.match(res.json().error ?? "", /store down/);
  } finally {
    await app.close();
  }
});

test("GET /api/kb/wiki/code-meta succeeds with a valid employee session token (read path like other KB GET routes)", async () => {
  const app = await appWith(stubRetrieval());
  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/kb/wiki/code-meta?path=wiki%2Fcode%2FS4H%2Fmara.md",
      headers: { authorization: "Bearer employee-session-token" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().type, "code");
  } finally {
    await app.close();
  }
});

test("POST /api/kb/search requires a query", async () => {
  const app = await appWith(stubRetrieval());
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/search",
      payload: { query: "  " },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("POST /api/kb/search returns fused results", async () => {
  const app = await appWith(stubRetrieval());
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/search",
      payload: { query: "incidents" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.query, "incidents");
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].source, "llmwiki");
  } finally {
    await app.close();
  }
});

test("retrieval route errors map to 500", async () => {
  const app = await appWith(
    stubRetrieval({
      getGraph: async () => {
        throw new Error("neo4j down");
      },
    }),
  );
  try {
    const res = await app.inject({ method: "GET", url: "/api/kb/graph" });
    assert.equal(res.statusCode, 500);
    assert.match(res.json().error ?? "", /neo4j down/);
  } finally {
    await app.close();
  }
});

test("POST /api/kb/search forwards scope=global to the retrieval service", async () => {
  const seen: Array<{ query: string; options?: { scope?: string } }> = [];
  const retrieval = stubRetrieval({
    search: (async (query: string, options?: { scope?: string }) => {
      seen.push({ query, options });
      return { query, results: [] };
    }) as KnowledgeRetrievalService["search"],
  });
  const app = await appWith(retrieval);
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/search",
      payload: { query: "corpus question", scope: "global" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(seen[0]?.options?.scope, "global");
  } finally {
    await app.close();
  }
});

test("POST /api/kb/search rejects an invalid scope with 400", async () => {
  const app = await appWith(stubRetrieval());
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/search",
      payload: { query: "x", scope: "weird" },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await app.close();
  }
});
