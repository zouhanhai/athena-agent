import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../src/app.js";
import type { FastifyInstance } from "fastify";
import type { KnowledgeRetrievalService } from "../../src/kb/retrieval.js";

function stubRetrieval(
  overrides: Partial<KnowledgeRetrievalService> = {},
): KnowledgeRetrievalService {
  return {
    getGraph: async (label?: string) => ({
      nodes: [{ id: "n1", label: "Alpha", type: "concept" }],
      edges: [{ source: "n1", target: "n2", weight: 1 }],
      label,
    }),
    getWikiTree: async () => [{ name: "runbook.md", path: "runbook.md", isDir: false }],
    readWikiPage: async (path: string) => ({ path, content: "# Runbook\nbody" }),
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

test("GET /api/kb/graph returns nodes/edges from LightRAG", async () => {
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

test("GET /api/kb/graph forwards the label query param", async () => {
  let seenLabel: string | undefined;
  const app = await appWith(
    stubRetrieval({
      getGraph: async (label?: string) => {
        seenLabel = label;
        return { nodes: [], edges: [] };
      },
    }),
  );
  try {
    const res = await app.inject({ method: "GET", url: "/api/kb/graph?label=finance" });
    assert.equal(res.statusCode, 200);
    assert.equal(seenLabel, "finance");
  } finally {
    await app.close();
  }
});

test("GET /api/kb/graph forwards the topic query param", async () => {
  let seenTopic: string | undefined;
  const app = await appWith(
    stubRetrieval({
      getGraph: async (_label?: string, topic?: string) => {
        seenTopic = topic;
        return { nodes: [], edges: [] };
      },
    }),
  );
  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/kb/graph?topic=sommerseminar",
    });
    assert.equal(res.statusCode, 200);
    assert.equal(seenTopic, "sommerseminar");
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
        throw new Error("lightrag down");
      },
    }),
  );
  try {
    const res = await app.inject({ method: "GET", url: "/api/kb/graph" });
    assert.equal(res.statusCode, 500);
    assert.match(res.json().error ?? "", /lightrag down/);
  } finally {
    await app.close();
  }
});
