import { describe, expect, it, vi, afterEach } from "vitest";

import {
  getGraph,
  getWikiTree,
  readWikiPage,
  searchKnowledge,
  ingestFile,
  ingestUrl,
  getTask,
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

  it("throws with the status when the response is not ok", async () => {
    stubFetch(jsonResponse({ error: "boom" }, 500));
    await expect(getGraph()).rejects.toThrow("500");
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
      { source: "lightrag", title: "RAG summary", snippet: "answer" },
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
        ingesting_lightrag: { name: "ingesting_lightrag", status: "done" },
        ingesting_llmwiki: { name: "ingesting_llmwiki", status: "running" },
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
