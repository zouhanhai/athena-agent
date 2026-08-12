import { describe, expect, it, vi, afterEach } from "vitest";

import {
  getGraph,
  getGraphTopics,
  getWikiTree,
  readWikiPage,
  searchKnowledge,
  searchKnowledgeFull,
  listSemanticMappings,
  addSemanticMapping,
  deleteSemanticMapping,
  addManualQa,
  deleteQaPair,
  ingestFile,
  ingestUrl,
  getTask,
  retryTask,
} from "@/api/kb";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function stubFetch(response: Response) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getGraph", () => {
  it("GETs /api/kb/graph without a label param and returns nodes/edges", async () => {
    const body = {
      nodes: [{ id: "n1", label: "Alpha", type: "concept" }],
      edges: [{ source: "n1", target: "n2", weight: 1 }],
    };
    stubFetch(jsonResponse(body));
    const graph = await getGraph();

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe("/api/kb/graph");
    expect(init).toBeUndefined();
    expect(graph).toEqual(body);
  });

  it("appends the label query param when provided", async () => {
    stubFetch(jsonResponse({ nodes: [], edges: [] }));
    await getGraph("finance");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/kb/graph?label=finance");
  });

  it("appends the topic query param when provided", async () => {
    stubFetch(jsonResponse({ nodes: [], edges: [] }));
    await getGraph(undefined, "sommerseminar");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/kb/graph?topic=sommerseminar");
  });

  it("appends both label and topic params together", async () => {
    stubFetch(jsonResponse({ nodes: [], edges: [] }));
    await getGraph("all", "sommerseminar");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/kb/graph?label=all&topic=sommerseminar");
  });

  it("throws with the status when the response is not ok", async () => {
    stubFetch(jsonResponse({ error: "boom" }, 500));
    await expect(getGraph()).rejects.toThrow("500");
  });
});

describe("getGraphTopics", () => {
  it("GETs /api/kb/graph/topics and returns the topic list", async () => {
    stubFetch(jsonResponse({ topics: ["ops", "sommerseminar"] }));
    const topics = await getGraphTopics();

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe("/api/kb/graph/topics");
    expect(topics).toEqual(["ops", "sommerseminar"]);
  });
});

describe("getWikiTree", () => {
  it("GETs /api/kb/wiki and returns the file array", async () => {
    stubFetch(jsonResponse({ files: [{ name: "a.md", path: "a.md", isDir: false }] }));
    const tree = await getWikiTree();

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe("/api/kb/wiki");
    expect(tree).toEqual([{ name: "a.md", path: "a.md", isDir: false }]);
  });
});

describe("readWikiPage", () => {
  it("GETs /api/kb/wiki/page with the encoded path and returns markdown", async () => {
    stubFetch(jsonResponse({ path: "docs/a b.md", content: "# Title" }));
    const content = await readWikiPage("docs/a b.md");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/kb/wiki/page?path=docs%2Fa%20b.md");
    expect(content).toBe("# Title");
  });
});

describe("searchKnowledge", () => {
  it("POSTs { query } to /api/kb/search and returns results", async () => {
    const results = [
      { source: "neo4j", title: "doc1:c1", snippet: "bus station guide" },
      { source: "llmwiki", title: "Runbook", snippet: "Incident", path: "runbook.md" },
    ];
    stubFetch(jsonResponse({ query: "incidents", results }));
    const got = await searchKnowledge("incidents");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/kb/search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
        body: JSON.stringify({ query: "incidents" }),
      }),
    );
    expect(got).toEqual(results);
  });

  it("throws with the status on failure", async () => {
    stubFetch(jsonResponse({ error: "bad" }, 400));
    await expect(searchKnowledge("x")).rejects.toThrow("400");
  });

  it("sends the optional topic scope and accepts neo4j-sourced hits (G4.S2.T5)", async () => {
    const results = [
      { source: "neo4j", title: "doc1:c1", snippet: "bus station", score: 0.9 },
      { source: "llmwiki", title: "Bus", snippet: "keyword", path: "bus.md" },
    ];
    stubFetch(jsonResponse({ query: "bus", results }));
    const got = await searchKnowledge("bus", "transport");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/kb/search",
      expect.objectContaining({
        body: JSON.stringify({ query: "bus", topic: "transport" }),
      }),
    );
    expect(got).toEqual(results);
  });
});

describe("ingestFile", () => {
  it("POSTs a multipart form with the file and returns the task id", async () => {
    stubFetch(jsonResponse({ taskId: "t-1" }, 202));
    const file = new File(["hello"], "doc.md", { type: "text/markdown" });
    const taskId = await ingestFile(file);

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/kb/ingest");
    expect(init!.method).toBe("POST");
    expect(init!.body).toBeInstanceOf(FormData);
    const form = init!.body as FormData;
    expect(form.get("file")).toBe(file);
    expect(taskId).toBe("t-1");
  });
});

describe("ingestUrl", () => {
  it("POSTs { url } to /api/kb/ingest-url and returns the task id", async () => {
    stubFetch(jsonResponse({ taskId: "t-2" }, 202));
    const taskId = await ingestUrl("https://example.com/page");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/kb/ingest-url");
    expect(JSON.parse(String(init!.body))).toEqual({ url: "https://example.com/page" });
    expect(taskId).toBe("t-2");
  });
});

describe("getTask", () => {
  it("GETs /api/kb/task/:id and returns the task status", async () => {
    const task = {
      id: "t-1",
      source: "doc.md",
      status: "ingesting",
      progress: 72,
      stages: {
        parsing: { name: "parsing", status: "done" },
        ingesting_llmwiki: { name: "ingesting_llmwiki", status: "running" },
        ingesting_neo4j: { name: "ingesting_neo4j", status: "done" },
      },
    };
    stubFetch(jsonResponse(task));
    const got = await getTask("t-1");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/kb/task/t-1");
    expect(got).toEqual(task);
  });

  it("throws with the status when the task is not found", async () => {
    stubFetch(jsonResponse({ error: "task not found" }, 404));
    await expect(getTask("missing")).rejects.toThrow("404");
  });
});

describe("retryTask", () => {
  it("POSTs { taskId } to /api/kb/ingest/retry and returns the updated task", async () => {
    const task = {
      id: "t-1",
      source: "doc.md",
      status: "ingesting",
      progress: 85,
      stages: {
        parsing: { name: "parsing", status: "done" },
        ingesting_llmwiki: { name: "ingesting_llmwiki", status: "running" },
        ingesting_neo4j: { name: "ingesting_neo4j", status: "done" },
      },
    };
    stubFetch(jsonResponse(task));
    const got = await retryTask("t-1");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/kb/ingest/retry",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
        body: JSON.stringify({ taskId: "t-1" }),
      }),
    );
    expect(got).toEqual(task);
  });
});

// ---- G4.S3.T6: semantic mappings + manual Q&A + full search ----

describe("semantic mappings API", () => {
  it("listSemanticMappings GETs /api/kb/mappings and returns the list", async () => {
    const mappings = [{ id: "m1", term: "C-Day", canonical: "CALEO Day" }];
    stubFetch(jsonResponse({ mappings }));
    const got = await listSemanticMappings();

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith("/api/kb/mappings", undefined);
    expect(got).toEqual(mappings);
  });

  it("addSemanticMapping POSTs { term, canonical }", async () => {
    const mapping = { id: "m1", term: "HW", canonical: "Haushaltswaren" };
    stubFetch(jsonResponse({ mapping }));
    const got = await addSemanticMapping("HW", "Haushaltswaren");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/kb/mappings",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ term: "HW", canonical: "Haushaltswaren" }),
      }),
    );
    expect(got).toEqual(mapping);
  });

  it("deleteSemanticMapping DELETEs /api/kb/mappings/:id", async () => {
    stubFetch(jsonResponse({ ok: true }));
    const ok = await deleteSemanticMapping("m1");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/kb/mappings/m1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(ok).toBe(true);
  });
});

describe("manual Q&A API", () => {
  it("addManualQa POSTs /api/kb/qa/manual and returns the dedup decision", async () => {
    const result = {
      action: "needs_decision",
      pair: null,
      similar: { id: "p1", question: "What is C-Day?", score: 0.93 },
    };
    stubFetch(jsonResponse(result));
    const got = await addManualQa({ question: "What is C Day?", answer: "A new answer." });

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/kb/qa/manual",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ question: "What is C Day?", answer: "A new answer." }),
      }),
    );
    expect(got.action).toBe("needs_decision");
    expect(got.similar?.score).toBe(0.93);
  });

  it("addManualQa forwards the chosen merge/overwrite/add-anyway mode", async () => {
    stubFetch(jsonResponse({ action: "merged", pair: { id: "p1" } }));
    await addManualQa({ question: "q", answer: "a", mode: "merge" });

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/kb/qa/manual",
      expect.objectContaining({ body: JSON.stringify({ question: "q", answer: "a", mode: "merge" }) }),
    );
  });

  it("deleteQaPair DELETEs /api/kb/qa/:id", async () => {
    stubFetch(jsonResponse({ ok: true }));
    const ok = await deleteQaPair("p1");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/kb/qa/p1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(ok).toBe(true);
  });
});

describe("searchKnowledgeFull", () => {
  it("returns the full response including expandedQuery and qaReference", async () => {
    const body = {
      query: "What is C-Day?",
      expandedQuery: "What is CALEO Day?",
      results: [{ source: "neo4j", title: "doc1:c1", snippet: "CALEO Day" }],
      qaReference: {
        id: "p1",
        question: "What is C-Day?",
        answer: "C-Day is the CALEO Day.",
        score: 0.95,
      },
    };
    stubFetch(jsonResponse(body));
    const got = await searchKnowledgeFull("What is C-Day?");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/kb/search",
      expect.objectContaining({ body: JSON.stringify({ query: "What is C-Day?" }) }),
    );
    expect(got.results.length).toBe(1);
    expect(got.expandedQuery).toBe("What is CALEO Day?");
    expect(got.qaReference?.answer).toBe("C-Day is the CALEO Day.");
  });
});
