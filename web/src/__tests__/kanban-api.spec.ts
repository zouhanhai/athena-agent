import { describe, expect, it, vi, afterEach } from "vitest";

import {
  fetchBoard,
  fetchGithubIssueComments,
  fetchGithubProjectBoard,
  type GithubProjectBoard,
  type KanbanIndex,
} from "@/api/kanban";

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

const PROJECT_BOARD: GithubProjectBoard = {
  project: { id: "PVT_1", title: "athena-agent", number: 3, url: "https://github.com/acme/box/projects/3" },
  columns: [
    {
      status: "Done",
      cards: [
        {
          issueNumber: 2,
          ref: "G4.S5",
          title: "Workbench kanban sync",
          status: "Done",
          url: "https://github.com/acme/box/issues/2",
          progress: { done: 4, total: 5, percent: 80 },
        },
      ],
    },
  ],
  generated_at: "2026-08-13T16:00:00Z",
};

describe("fetchGithubProjectBoard", () => {
  it("GETs /api/kanban/github-project?repo=... with the Bearer token", async () => {
    stubFetch(jsonResponse(PROJECT_BOARD));
    const result = await fetchGithubProjectBoard("tok_1", "acme/box");
    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/kanban/github-project?repo=acme%2Fbox");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok_1");
    expect(result).toEqual(PROJECT_BOARD);
  });

  it("throws the server error message when the repo has no linked Project (404)", async () => {
    stubFetch(jsonResponse({ error: "no linked GitHub Project for acme/box" }, 404));
    await expect(fetchGithubProjectBoard("tok_1", "acme/box")).rejects.toThrow(
      "no linked GitHub Project for acme/box",
    );
  });
});

const COMMENTS = [
  {
    id: 11,
    user_login: "alice",
    body: "Keep the board in the Workbench.",
    created_at: "2026-08-13T10:00:00Z",
    html_url: "https://github.com/acme/box/issues/5#issuecomment-11",
  },
];

describe("fetchGithubIssueComments", () => {
  it("GETs /api/kanban/github-issue-comments?repo=...&issueNumber=... with the Bearer token", async () => {
    stubFetch(jsonResponse({ comments: COMMENTS }));
    const result = await fetchGithubIssueComments("tok_1", "acme/box", 5);
    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/kanban/github-issue-comments?repo=acme%2Fbox&issueNumber=5");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok_1");
    expect(result).toEqual(COMMENTS);
  });

  it("throws the server error message on a non-ok response", async () => {
    stubFetch(jsonResponse({ error: "unauthorized" }, 401));
    await expect(fetchGithubIssueComments("tok_1", "acme/box", 5)).rejects.toThrow("unauthorized");
  });
});
