import { describe, expect, it, vi, afterEach } from "vitest";

import { fetchBoard, type KanbanIndex } from "@/api/kanban";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function stubFetch(response: Response) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function fetchMock(): ReturnType<typeof vi.fn> {
  return fetch as unknown as ReturnType<typeof vi.fn>;
}

const BOARD: KanbanIndex = {
  version: 1,
  generated_at: "2026-08-09T16:00:00Z",
  goals: [
    {
      ref: "G1",
      id: "g1",
      title: "G1: goal",
      owner: "consultant",
      status: "active",
      specs: [
        {
          ref: "G1.S1",
          id: "g1_s1",
          title: "G1.S1: spec",
          owner: "pm",
          status: "active",
          tickets: [
            {
              ref: "G1.S1.T1",
              id: "t1",
              title: "G1.S1.T1: ticket",
              owner: "eng-director",
              status: "backlog",
              assignee: "",
              blocked_by: [],
              acceptance_criteria: ["works"],
            },
          ],
        },
      ],
    },
  ],
  errors: [],
};

describe("fetchBoard", () => {
  it("GETs /api/kanban with the Bearer token and returns the root index", async () => {
    stubFetch(jsonResponse(BOARD));
    const result = await fetchBoard("tok_1");
    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/kanban");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok_1");
    expect(result).toEqual(BOARD);
  });

  it("GETs /api/kanban?repo=owner/repo when a repo is selected", async () => {
    stubFetch(jsonResponse(BOARD));
    await fetchBoard("tok_1", "acme/box");
    const [url] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/kanban?repo=acme%2Fbox");
  });

  it("GETs /api/kanban?rescan=1 when a rescan is requested", async () => {
    stubFetch(jsonResponse(BOARD));
    await fetchBoard("tok_1", undefined, true);
    const [url] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/kanban?rescan=1");
  });

  it("combines repo and rescan query params", async () => {
    stubFetch(jsonResponse(BOARD));
    await fetchBoard("tok_1", "acme/box", true);
    const [url] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/kanban?repo=acme%2Fbox&rescan=1");
  });

  it("throws the server error message on a non-ok response", async () => {
    stubFetch(jsonResponse({ error: "unauthorized" }, 401));
    await expect(fetchBoard("tok_1")).rejects.toThrow("unauthorized");
  });
});
