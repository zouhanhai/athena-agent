import { describe, expect, it, vi, afterEach } from "vitest";

import { fetchBoard, type KanbanBoard } from "@/api/kanban";

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

const BOARD: KanbanBoard = {
  goals: [
    {
      ref: "G1",
      goal: {
        id: "g1",
        title: "G1: goal",
        layer: "G",
        owner: "consultant",
        status: "active",
        acceptance_criteria: ["done"],
      },
      specs: [
        {
          ref: "G1.S1",
          spec: {
            id: "g1_s1",
            title: "G1.S1: spec",
            layer: "S",
            parent: "G1",
            owner: "pm",
            status: "active",
            acceptance_criteria: ["done"],
          },
          tickets: [
            {
              ref: "G1.S1.T1",
              ticket: {
                id: "t1",
                title: "G1.S1.T1: ticket",
                layer: "T",
                parent: "G1.S1",
                owner: "eng-director",
                status: "backlog",
                assignee: "",
                blocked_by: [],
                acceptance_criteria: ["works"],
              },
            },
          ],
        },
      ],
    },
  ],
  errors: [],
};

describe("fetchBoard", () => {
  it("GETs /api/kanban with the Bearer token and returns the board", async () => {
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

  it("throws the server error message on a non-ok response", async () => {
    stubFetch(jsonResponse({ error: "unauthorized" }, 401));
    await expect(fetchBoard("tok_1")).rejects.toThrow("unauthorized");
  });
});
