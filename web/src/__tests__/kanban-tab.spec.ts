import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import KanbanTab from "@/components/KanbanTab.vue";
import { fetchBoard, fetchGithubIssueComments, fetchGithubProjectBoard } from "@/api/kanban";
import { fetchFileContent } from "@/api/github";
import type { GithubProjectBoard, KanbanIndex } from "@/api/kanban";

vi.mock("@/api/kanban", () => ({
  fetchBoard: vi.fn(),
  fetchGithubProjectBoard: vi.fn(),
  fetchGithubIssueComments: vi.fn(),
  TICKET_STATUSES: [
    "backlog",
    "in_progress",
    "done",
    "in_review",
    "approved",
    "rejected",
  ],
}));

vi.mock("@/api/github", () => ({
  fetchFileContent: vi.fn(),
}));

const fetchBoardMock = fetchBoard as unknown as ReturnType<typeof vi.fn>;
const fetchGithubProjectBoardMock = fetchGithubProjectBoard as unknown as ReturnType<typeof vi.fn>;
const fetchGithubIssueCommentsMock = fetchGithubIssueComments as unknown as ReturnType<typeof vi.fn>;
const fetchFileContentMock = fetchFileContent as unknown as ReturnType<typeof vi.fn>;

const BOARD: KanbanIndex = {
  version: 1,
  generated_at: "2026-08-09T16:00:00Z",
  goals: [
    {
      ref: "G1",
      id: "g1",
      title: "G1: Foundation",
      owner: "consultant",
      status: "active",
      milestone: "M1",
      specs: [
        {
          ref: "G1.S1",
          id: "g1_s1",
          title: "G1.S1: Auth",
          owner: "pm",
          status: "active",
          tickets: [
            {
              ref: "G1.S1.T1",
              id: "t1",
              title: "G1.S1.T1: Login flow",
              owner: "eng-director",
              status: "done",
              assignee: "opencode",
              blocked_by: [],
              acceptance_criteria: ["works"],
            },
            {
              ref: "G1.S1.T2",
              id: "t2",
              title: "G1.S1.T2: Session expiry",
              owner: "eng-director",
              status: "in_progress",
              assignee: "opencode",
              session_id: "ses_1",
              started_at: "2026-08-01",
              progress_last_row: "Implementing session expiry",
              progress_updated_at: "2026-08-09T15:50:00Z",
              blocked_by: [],
              acceptance_criteria: ["expires"],
            },
          ],
        },
      ],
    },
  ],
  errors: [],
};

const REPO = {
  name: "athena-agent",
  full_name: "zouhanhai/athena-agent",
  html_url: "https://github.com/zouhanhai/athena-agent",
  description: "portal",
  private: false,
  default_branch: "master",
};

const PROJECT_BOARD: GithubProjectBoard = {
  project: {
    id: "PVT_1",
    title: "athena-agent",
    number: 3,
    url: "https://github.com/zouhanhai/athena-agent/projects/3",
  },
  columns: [
    {
      status: "Backlog",
      cards: [
        {
          issueNumber: 1,
          ref: "G4.S5",
          title: "Workbench kanban sync",
          status: "Backlog",
          url: "https://github.com/zouhanhai/athena-agent/issues/1",
        },
      ],
    },
    {
      status: "In Progress",
      cards: [
        {
          issueNumber: 2,
          ref: "G4.S5.T2",
          title: "",
          status: "In Progress",
          url: "https://github.com/zouhanhai/athena-agent/issues/2",
        },
      ],
    },
  ],
  generated_at: "2026-08-13T16:00:00Z",
};

const TICKET_MD = `---
id: G4.S5.T4
title: "G4.S5.T4: Workbench Kanban view toggle"
owner: eng-director
status: in_progress
assignee: opencode
session_id: ses_1
blocked_by: "G4.S5.T2"
---

# G4.S5.T4 — Workbench Kanban view toggle

## Context

S5 syncs md to GitHub. This ticket adds a view toggle.

## Task

1. Backend endpoint.
2. Frontend toggle.

## Acceptance

- Toggle works.

## Progress Log
| UTC timestamp | status | progress |
|---|---|---|
| 2026-08-13T14:21:04.639Z | in_progress | opencode claimed G4.S5.T4 |

## Log

[2026-08-13] opencode claimed G4.S5.T4
`;

const COMMENTS = [
  {
    id: 11,
    user_login: "alice",
    body: "Keep the board inside the Workbench.",
    created_at: "2026-08-13T10:00:00Z",
    html_url: "https://github.com/zouhanhai/athena-agent/issues/5#issuecomment-11",
  },
];

async function mountKanbanTab(repo: typeof REPO | null = null) {
  const wrapper = mount(KanbanTab, {
    props: { repo },
    global: { plugins: [createPinia(), TDesign] },
  });
  await flushPromises();
  return wrapper;
}

type Wrapper = Awaited<ReturnType<typeof mountKanbanTab>>;

function columns(wrapper: Wrapper) {
  return wrapper.findAll(".kanban-column");
}

function columnByStatus(wrapper: Wrapper, status: string) {
  return columns(wrapper).find((c) => c.classes().includes(`kanban-column-${status}`));
}

describe("KanbanTab", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.clearAllMocks();
    fetchBoardMock.mockResolvedValue(BOARD);
    fetchGithubProjectBoardMock.mockResolvedValue(PROJECT_BOARD);
    fetchGithubIssueCommentsMock.mockResolvedValue(COMMENTS);
    fetchFileContentMock.mockResolvedValue({
      path: "docs/kanban/G4/S5/T4.md",
      sha: "s",
      size: TICKET_MD.length,
      content: TICKET_MD,
    });
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("shows an empty state without a session token and makes no API calls", async () => {
    const wrapper = await mountKanbanTab();
    expect(wrapper.find(".kanban-empty").exists()).toBe(true);
    expect(fetchBoardMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("loads the local board on mount when no repo is selected", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab();

    expect(fetchBoardMock).toHaveBeenCalledWith("tok_1", undefined, false);
    expect(columns(wrapper).length).toBeGreaterThan(0);
    const labels = columns(wrapper).map((c) => c.find(".kanban-column-title").text());
    for (const status of ["backlog", "in_progress", "done", "in_review", "approved", "rejected"]) {
      expect(labels.some((l) => l.includes(status.replace("_", " ")))).toBe(true);
    }
    wrapper.unmount();
  });

  it("loads the selected repo's board when a repo is passed", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab(REPO);

    expect(fetchBoardMock).toHaveBeenCalledWith("tok_1", "zouhanhai/athena-agent", false);
    expect(wrapper.find(".kanban-source").text()).toContain("zouhanhai/athena-agent");
    wrapper.unmount();
  });

  it("labels the source as the local athena repo when none is selected", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab();
    expect(wrapper.find(".kanban-source").text()).toContain("local");
    wrapper.unmount();
  });

  it("places each ticket in the column matching its status", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab();

    const done = columnByStatus(wrapper, "done");
    expect(done!.text()).toContain("G1.S1.T1");
    expect(done!.text()).toContain("Login flow");

    const inProgress = columnByStatus(wrapper, "in_progress");
    expect(inProgress!.text()).toContain("G1.S1.T2");
    expect(inProgress!.text()).toContain("Session expiry");
    wrapper.unmount();
  });

  it("shows the live status, assignee, session_id and progress row on each ticket card", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab();

    const inProgress = columnByStatus(wrapper, "in_progress");
    const card = inProgress!.find(".kanban-card");
    expect(card!.text()).toContain("in progress");
    expect(card!.text()).toContain("opencode");
    expect(card!.text()).toContain("ses_1");
    expect(card!.find(".kanban-card-progress").text()).toContain("Implementing session expiry");
    wrapper.unmount();
  });

  it("shows the goal and spec refs on the board", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab();

    const text = wrapper.text();
    expect(text).toContain("G1");
    expect(text).toContain("G1.S1");
    expect(text).toContain("G1: Foundation");
    expect(text).toContain("Auth");
    wrapper.unmount();
  });

  it("renders spec badges as a two-part layout: ref shown once + title without the ref prefix", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab();

    const spec = wrapper.find(".kanban-spec");
    expect(spec.exists()).toBe(true);
    expect(spec.find(".kanban-spec-ref").text()).toBe("G1.S1");
    expect(spec.find(".kanban-spec-title").text()).toBe("Auth");
    expect(spec.text()).not.toMatch(/G1\.S1 · G1\.S1/);
    wrapper.unmount();
  });

  it("lays each goal row out as a two-part row (left ref+title, right spec badges)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab();

    const goal = wrapper.find(".kanban-goal");
    expect(goal.find(".kanban-goal-main .kanban-goal-ref").text()).toBe("G1");
    expect(goal.find(".kanban-goal-main .kanban-goal-title").text()).toBe("G1: Foundation");
    expect(goal.find(".kanban-goal-specs .kanban-spec").exists()).toBe(true);
    wrapper.unmount();
  });

  it("renders an empty column when no ticket uses a status", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab();

    const review = columnByStatus(wrapper, "in_review");
    expect(review!.exists()).toBe(true);
    expect(review!.find(".kanban-card").exists()).toBe(false);
    wrapper.unmount();
  });

  it("the refresh button re-fetches the board with rescan=1 (rebuild the index)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab(REPO);
    const callsAfterMount = fetchBoardMock.mock.calls.length;
    await wrapper.find(".kanban-refresh").trigger("click");
    await flushPromises();
    expect(fetchBoardMock.mock.calls.length).toBe(callsAfterMount + 1);
    expect(fetchBoardMock).toHaveBeenLastCalledWith("tok_1", "zouhanhai/athena-agent", true);
    wrapper.unmount();
  });

  it("re-fetches when the selected repo prop changes", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab(null);
    await wrapper.setProps({ repo: REPO });
    await flushPromises();
    expect(fetchBoardMock).toHaveBeenLastCalledWith("tok_1", "zouhanhai/athena-agent", false);
    wrapper.unmount();
  });

  it("shows the index generated_at as the refreshed timestamp", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab();
    expect(wrapper.find(".kanban-refreshed").text()).toContain("Refreshed");
    wrapper.unmount();
  });

  it("shows an error message when the kanban API fails", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    fetchBoardMock.mockRejectedValue(new Error("disk read failed"));
    const wrapper = await mountKanbanTab();
    expect(wrapper.find(".kanban-error").text()).toContain("disk read failed");
    wrapper.unmount();
  });

  it("shows scan-progress feedback while the board refreshes", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    let resolveFetch!: (board: KanbanIndex) => void;
    fetchBoardMock.mockImplementation(
      () =>
        new Promise<KanbanIndex>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const wrapper = await mountKanbanTab();

    expect(wrapper.find(".kanban-refresh").attributes("disabled")).toBeDefined();
    expect(wrapper.find(".kanban-refresh").text()).toContain("Scanning");
    expect(wrapper.text()).toContain("Scanning docs/kanban");

    resolveFetch(BOARD);
    await flushPromises();

    expect(wrapper.find(".kanban-refresh").attributes("disabled")).toBeUndefined();
    expect(wrapper.find(".kanban-refresh").text()).not.toContain("Scanning");
    expect(wrapper.find(".kanban-column").exists()).toBe(true);
    wrapper.unmount();
  });

  it("surfaces the number of files that failed to scan after a refresh", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    fetchBoardMock.mockResolvedValue({
      version: 1,
      generated_at: "2026-08-09T16:00:00Z",
      goals: BOARD.goals,
      errors: [{ file: "docs/kanban/G1/S1/T9.md", error: "boom" }],
    });
    const wrapper = await mountKanbanTab();

    expect(wrapper.find(".kanban-scan-errors").text()).toContain("1 file(s) failed to scan");
    expect(wrapper.find(".kanban-scan-error-file").text()).toContain("docs/kanban/G1/S1/T9.md");
    expect(wrapper.find(".kanban-scan-error-msg").text()).toContain("boom");
    wrapper.unmount();
  });

  it("shows the Progress Log last row + 'updated Xs ago' on an in_progress card (G4.S4.T2)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T10:00:00Z"));
    try {
      localStorage.setItem("athena.session_token", "tok_1");
      fetchBoardMock.mockResolvedValue({
        version: 1,
        generated_at: "2026-08-13T10:00:00Z",
        goals: [
          {
            ref: "G1",
            id: "g1",
            title: "G1: Foundation",
            owner: "consultant",
            status: "active",
            specs: [
              {
                ref: "G1.S1",
                id: "g1_s1",
                title: "G1.S1: Auth",
                owner: "pm",
                status: "active",
                tickets: [
                  {
                    ref: "G1.S1.T2",
                    id: "t2",
                    title: "G1.S1.T2: Session expiry",
                    owner: "eng-director",
                    status: "in_progress",
                    assignee: "opencode",
                    session_id: "ses_1",
                    progress_last_row: "Implementing session expiry",
                    progress_updated_at: "2026-08-13T09:59:48Z",
                    blocked_by: [],
                    acceptance_criteria: ["expires"],
                  },
                ],
              },
            ],
          },
        ],
        errors: [],
      });

      const wrapper = await mountKanbanTab();
      const inProgress = columnByStatus(wrapper, "in_progress");
      const card = inProgress!.find(".kanban-card");
      expect(card!.find(".kanban-card-progress").text()).toContain("Implementing session expiry");
      expect(card!.find(".kanban-card-updated").text()).toBe("updated 12s ago");
      expect(card!.find(".kanban-card-stalled").exists()).toBe(false);
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flags an in_progress card as stalled when its last row is older than ~3 min (G4.S4.T2)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T10:00:00Z"));
    try {
      localStorage.setItem("athena.session_token", "tok_1");
      fetchBoardMock.mockResolvedValue(BOARD);

      const wrapper = await mountKanbanTab();
      const inProgress = columnByStatus(wrapper, "in_progress");
      const card = inProgress!.find(".kanban-card");
      // BOARD.T2 is in_progress with progress_updated_at 2026-08-09 15:50Z → old.
      expect(card!.find(".kanban-card-stalled").text()).toContain("stalled");
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT flag a non-in_progress card as stalled even with an old row (observation-only) (G4.S4.T2)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T10:00:00Z"));
    try {
      localStorage.setItem("athena.session_token", "tok_1");
      fetchBoardMock.mockResolvedValue({
        version: 1,
        generated_at: "2026-08-13T10:00:00Z",
        goals: [
          {
            ref: "G1",
            id: "g1",
            title: "G1: Foundation",
            owner: "consultant",
            status: "active",
            specs: [
              {
                ref: "G1.S1",
                id: "g1_s1",
                title: "G1.S1: Auth",
                owner: "pm",
                status: "active",
                tickets: [
                  {
                    ref: "G1.S1.T1",
                    id: "t1",
                    title: "G1.S1.T1: Login flow",
                    owner: "eng-director",
                    status: "done",
                    assignee: "opencode",
                    progress_last_row: "Shipped login",
                    progress_updated_at: "2026-08-09T15:50:00Z",
                    blocked_by: [],
                    acceptance_criteria: ["works"],
                  },
                ],
              },
            ],
          },
        ],
        errors: [],
      });

      const wrapper = await mountKanbanTab();
      const done = columnByStatus(wrapper, "done");
      const card = done!.find(".kanban-card");
      expect(card!.find(".kanban-card-updated").exists()).toBe(true);
      expect(card!.find(".kanban-card-stalled").exists()).toBe(false);
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("expands a column on header click (wider) and collapses on the same click (all 1fr)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab();
    const columnsEl = wrapper.find(".kanban-columns");

    // Initially all equal width (no inline grid-template-columns).
    expect(columnsEl.attributes("style") || "").not.toContain("grid-template-columns");

    // Click the done column header → it expands (3.75fr via minmax(0,...)), others narrow (0.5fr).
    const done = columnByStatus(wrapper, "done")!;
    await done.find(".kanban-column-header").trigger("click");
    await flushPromises();
    const expandedStyle = columnsEl.attributes("style") || "";
    expect(expandedStyle).toContain("minmax(0, 3.75fr)");
    expect(expandedStyle).toContain("minmax(0, 0.5fr)");
    expect(done.classes()).toContain("kanban-column-expanded");

    // Click the same header again → collapses back to equal width.
    await done.find(".kanban-column-header").trigger("click");
    await flushPromises();
    expect(columnsEl.attributes("style") || "").not.toContain("grid-template-columns");
    expect(done.classes()).not.toContain("kanban-column-expanded");

    wrapper.unmount();
  });

  it("renders a Local | GitHub Project view toggle, Local active by default (G4.S5.T4)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab(REPO);

    expect(wrapper.find(".kanban-view-toggle-local").exists()).toBe(true);
    expect(wrapper.find(".kanban-view-toggle-github").exists()).toBe(true);
    expect(wrapper.find(".kanban-view-toggle-local").classes()).toContain("kanban-view-toggle-active");
    expect(wrapper.find(".kanban-view-toggle-github").classes()).not.toContain("kanban-view-toggle-active");
    expect(fetchGithubProjectBoardMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("fetches the synced GitHub Project and renders columns/cards (G4.S5.T4)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab(REPO);

    await wrapper.find(".kanban-view-toggle-github").trigger("click");
    await flushPromises();

    expect(fetchGithubProjectBoardMock).toHaveBeenCalledWith("tok_1", "zouhanhai/athena-agent");
    const columnsEl = wrapper.findAll(".kanban-project-column");
    expect(columnsEl.length).toBe(2);
    expect(columnsEl[0].find(".kanban-project-column-title").text()).toBe("Backlog");
    expect(columnsEl[0].find(".kanban-project-column-count").text()).toBe("1");
    expect(columnsEl[1].find(".kanban-project-column-title").text()).toBe("In Progress");

    const card = columnsEl[0].find(".kanban-project-card");
    expect(card.element.tagName).toBe("BUTTON");
    expect(card.text()).toContain("G4.S5");
    expect(card.text()).toContain("Workbench kanban sync");
    expect(card.text()).toContain("Backlog");
    expect(card.attributes("href")).toBeUndefined();
    wrapper.unmount();
  });

  it("clicking a card opens a LOCAL detail panel with md details + GitHub comments (no redirect) (G4.S5.T4)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab(REPO);

    await wrapper.find(".kanban-view-toggle-github").trigger("click");
    await flushPromises();

    const ticketCard = wrapper.findAll(".kanban-project-card")[1];
    await ticketCard.trigger("click");
    await flushPromises();

    // No navigation happened; a local panel is open instead.
    expect(wrapper.find(".kanban-detail-panel").exists()).toBe(true);
    expect(wrapper.find(".kanban-detail-ref").text()).toBe("G4.S5.T2");

    // The md file for the ticket ref is pulled from the repo and parsed.
    expect(fetchFileContentMock).toHaveBeenCalledWith(
      "tok_1",
      "zouhanhai",
      "athena-agent",
      "docs/kanban/G4/S5/T2.md",
    );
    // The detail panel shows the md's frontmatter chips, description and Progress Log.
    expect(wrapper.find(".kanban-detail-fm").text()).toContain("assignee: opencode");
    expect(wrapper.find(".kanban-detail-description").text()).toContain("This ticket adds a view toggle.");
    expect(wrapper.find(".kanban-detail-progress-row").exists()).toBe(true);

    // GitHub comments are fetched and rendered.
    expect(fetchGithubIssueCommentsMock).toHaveBeenCalledWith("tok_1", "zouhanhai/athena-agent", 2);
    expect(wrapper.find(".kanban-detail-comment-body").text()).toContain("Keep the board inside the Workbench");
    wrapper.unmount();
  });

  it("closes the local detail panel back to the board (G4.S5.T4)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab(REPO);

    await wrapper.find(".kanban-view-toggle-github").trigger("click");
    await flushPromises();
    await wrapper.find(".kanban-project-card").trigger("click");
    await flushPromises();
    expect(wrapper.find(".kanban-detail-panel").exists()).toBe(true);

    await wrapper.find(".kanban-detail-close").trigger("click");
    await flushPromises();
    expect(wrapper.find(".kanban-detail-panel").exists()).toBe(false);
    expect(wrapper.find(".kanban-project-columns").exists()).toBe(true);
    wrapper.unmount();
  });

  it("keeps the local board (goal tree, columns, expand) in the default Local view (G4.S5.T4)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab();

    expect(wrapper.find(".kanban-tree").exists()).toBe(true);
    expect(wrapper.find(".kanban-columns").exists()).toBe(true);
    expect(wrapper.find(".kanban-project-board").exists()).toBe(false);
    expect(fetchGithubProjectBoardMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("shows a select-a-repo hint in the GitHub view and skips the fetch without a repo (G4.S5.T4)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab(null);

    await wrapper.find(".kanban-view-toggle-github").trigger("click");
    await flushPromises();

    expect(wrapper.find(".kanban-project-empty").text()).toContain("Select a repository");
    expect(fetchGithubProjectBoardMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("isolates the two views: GitHub hides the local tree, switching back restores it (G4.S5.T4)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab(REPO);

    // Expand the done column in the Local view first — the state must survive switching.
    const done = columnByStatus(wrapper, "done")!;
    await done.find(".kanban-column-header").trigger("click");
    await flushPromises();
    expect(wrapper.find(".kanban-columns").attributes("style") || "").toContain("grid-template-columns");

    await wrapper.find(".kanban-view-toggle-github").trigger("click");
    await flushPromises();
    expect(wrapper.find(".kanban-tree").exists()).toBe(false);
    expect(wrapper.find(".kanban-columns").exists()).toBe(false);
    expect(wrapper.find(".kanban-project-columns").exists()).toBe(true);

    await wrapper.find(".kanban-view-toggle-local").trigger("click");
    await flushPromises();
    expect(wrapper.find(".kanban-project-board").exists()).toBe(false);
    expect(wrapper.find(".kanban-tree").exists()).toBe(true);
    expect(wrapper.find(".kanban-columns").attributes("style") || "").toContain("grid-template-columns");
    wrapper.unmount();
  });

  it("shows a select-a-repo hint in the GitHub view and skips the fetch without a repo (G4.S5.T4)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab(null);

    await wrapper.find(".kanban-view-toggle-github").trigger("click");
    await flushPromises();

    expect(wrapper.find(".kanban-project-empty").text()).toContain("Select a repository");
    expect(fetchGithubProjectBoardMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("surfaces the endpoint error when the repo has no linked Project (G4.S5.T4)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    fetchGithubProjectBoardMock.mockRejectedValue(
      new Error("no linked GitHub Project for zouhanhai/athena-agent"),
    );
    const wrapper = await mountKanbanTab(REPO);

    await wrapper.find(".kanban-view-toggle-github").trigger("click");
    await flushPromises();

    expect(wrapper.find(".kanban-error").text()).toContain("no linked GitHub Project");
    wrapper.unmount();
  });

  it("the refresh button re-pulls the GitHub Project board in the GitHub view (G4.S5.T4)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab(REPO);

    await wrapper.find(".kanban-view-toggle-github").trigger("click");
    await flushPromises();
    const callsAfterEntry = fetchGithubProjectBoardMock.mock.calls.length;
    expect(callsAfterEntry).toBeGreaterThan(0);

    await wrapper.find(".kanban-refresh").trigger("click");
    await flushPromises();
    expect(fetchGithubProjectBoardMock.mock.calls.length).toBe(callsAfterEntry + 1);
    wrapper.unmount();
  });
});
