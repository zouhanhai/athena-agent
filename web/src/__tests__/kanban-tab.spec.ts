import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import KanbanTab from "@/components/KanbanTab.vue";
import {
  fetchBoard,
  fetchGithubIssueBody,
  fetchGithubIssueComments,
  fetchGithubProjectBoard,
  fetchGithubProjects,
  postGithubIssueComment,
} from "@/api/kanban";
import { applyTheme } from "@/theme";
import type { GithubProjectBoard, KanbanIndex } from "@/api/kanban";

vi.mock("@/api/kanban", () => ({
  fetchBoard: vi.fn(),
  fetchGithubProjectBoard: vi.fn(),
  fetchGithubProjects: vi.fn(),
  fetchGithubIssueBody: vi.fn(),
  fetchGithubIssueComments: vi.fn(),
  postGithubIssueComment: vi.fn(),
  TICKET_STATUSES: [
    "backlog",
    "in_progress",
    "done",
    "in_review",
    "approved",
    "rejected",
  ],
}));

const fetchBoardMock = fetchBoard as unknown as ReturnType<typeof vi.fn>;
const fetchGithubProjectBoardMock = fetchGithubProjectBoard as unknown as ReturnType<typeof vi.fn>;
const fetchGithubProjectsMock = fetchGithubProjects as unknown as ReturnType<typeof vi.fn>;
const fetchGithubIssueBodyMock = fetchGithubIssueBody as unknown as ReturnType<typeof vi.fn>;
const fetchGithubIssueCommentsMock = fetchGithubIssueComments as unknown as ReturnType<typeof vi.fn>;
const postGithubIssueCommentMock = postGithubIssueComment as unknown as ReturnType<typeof vi.fn>;

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

// G4.S5.T12 — the repo's OPEN linked Projects for the selector. A CLOSED
// project (e.g. the user's accidental 'untitled project') is filtered out
// server-side, so it never reaches the frontend.
const PROJECTS = [
  { id: "PVT_1", title: "athena-agent", number: 3, url: "https://github.com/zouhanhai/athena-agent/projects/3" },
];

// The SECOND open project, for the switching-the-selector test.
const PROJECTS_TWO = [
  { id: "PVT_1", title: "athena-agent", number: 3, url: "https://github.com/zouhanhai/athena-agent/projects/3" },
  { id: "PVT_2", title: "Second project", number: 4, url: "https://github.com/zouhanhai/athena-agent/projects/4" },
];

// T9: the synced board carries BOTH Spec cards (with sub-task progress for the
// segmented bar + the brand-orange accent) AND ticket sub-issue cards (plain),
// each in its own Status column — GitHub-native board behavior.
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
          progress: { done: 4, total: 5, percent: 80 },
          subIssues: [
            { ref: "G4.S5.T1", title: "G4.S5.T1 GitHub GraphQL client", status: "done", number: 11 },
            { ref: "G4.S5.T2", title: "G4.S5.T2 md→GitHub projection", status: "open", number: 12 },
            { ref: "G4.S5.T3", title: "G4.S5.T3 Feedback loop", status: "open", number: 13 },
            { ref: "G4.S5.T4", title: "G4.S5.T4 Workbench toggle", status: "open", number: 14 },
            { ref: "G4.S5.T5", title: "G4.S5.T5 Sync CLI", status: "open", number: 15 },
          ],
        },
        {
          issueNumber: 13,
          ref: "G4.S5.T3",
          title: "Feedback loop",
          status: "Backlog",
          url: "https://github.com/zouhanhai/athena-agent/issues/13",
          progress: { done: 0, total: 0, percent: 0 },
          subIssues: [],
        },
      ],
    },
    {
      status: "In Progress",
      cards: [
        {
          issueNumber: 12,
          ref: "G4.S5.T2",
          title: "md→GitHub projection",
          status: "In Progress",
          url: "https://github.com/zouhanhai/athena-agent/issues/12",
          progress: { done: 0, total: 0, percent: 0 },
          subIssues: [],
        },
        {
          issueNumber: 2,
          ref: "G4.S6",
          title: "KB lifecycle",
          status: "In Progress",
          url: "https://github.com/zouhanhai/athena-agent/issues/2",
          progress: { done: 1, total: 2, percent: 50 },
          subIssues: [
            { ref: "G4.S6.T1", title: "G4.S6.T1 KB lifecycle", status: "done", number: 21 },
            { ref: "G4.S6.T2", title: "G4.S6.T2 Agentic RAG", status: "open", number: 22 },
          ],
        },
      ],
    },
    {
      status: "Done",
      cards: [
        {
          issueNumber: 11,
          ref: "G4.S5.T1",
          title: "GitHub GraphQL client",
          status: "Done",
          url: "https://github.com/zouhanhai/athena-agent/issues/11",
          progress: { done: 0, total: 0, percent: 0 },
          subIssues: [],
        },
      ],
    },
  ],
  generated_at: "2026-08-13T16:00:00Z",
};

const COMMENTS = [
  {
    id: 11,
    user_login: "alice",
    body: "Keep the board inside the Workbench.",
    created_at: "2026-08-13T10:00:00Z",
    html_url: "https://github.com/zouhanhai/athena-agent/issues/5#issuecomment-11",
  },
];

// G4.S5.T16: the detail panel reads the GITHUB ISSUE BODY (same content the
// Issues panel shows) — the local md / Progress Log is NOT rendered anywhere.
const GITHUB_ISSUE = {
  number: 2,
  title: "KB lifecycle",
  state: "open",
  html_url: "https://github.com/zouhanhai/athena-agent/issues/2",
  user_login: "alice",
  body: "## Context\n\nKB lifecycle is a GitHub issue body.\n\n- [x] Track confidence\n- [ ] Auto re-curate",
  labels: ["G4"],
  assignees: ["alice"],
};

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
    fetchGithubProjectsMock.mockResolvedValue(PROJECTS);
    fetchGithubIssueCommentsMock.mockResolvedValue(COMMENTS);
    fetchGithubIssueBodyMock.mockResolvedValue(GITHUB_ISSUE);
    postGithubIssueCommentMock.mockResolvedValue({
      id: 99,
      user_login: "alice",
      body: "Posted from the panel",
      created_at: "2026-08-13T13:00:00Z",
      html_url: "https://github.com/zouhanhai/athena-agent/issues/1#issuecomment-99",
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

  it("does NOT render a stalled badge on an old in_progress card — web reads remote GitHub md which lacks the local Progress Log (G4.S5.T13)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T10:00:00Z"));
    try {
      localStorage.setItem("athena.session_token", "tok_1");
      fetchBoardMock.mockResolvedValue(BOARD);

      const wrapper = await mountKanbanTab();
      const inProgress = columnByStatus(wrapper, "in_progress");
      const card = inProgress!.find(".kanban-card");
      // BOARD.T2 is in_progress with progress_updated_at 2026-08-09 15:50Z → old,
      // but the web tier must NOT derive a stalled flag from it (GitHub md has
      // no local Progress Log, so a stale remote timestamp is not evidence of
      // a stalled worker).
      expect(card!.find(".kanban-card-stalled").exists()).toBe(false);
      expect(card!.text()).not.toContain("stalled");
      // 'updated Xs ago' stays — it is context, not a stalled judgment.
      expect(card!.find(".kanban-card-updated").exists()).toBe(true);
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

    expect(fetchGithubProjectsMock).toHaveBeenCalledWith("tok_1", "zouhanhai/athena-agent");
    expect(fetchGithubProjectBoardMock).toHaveBeenCalledWith("tok_1", "zouhanhai/athena-agent", "PVT_1");
    const columnsEl = wrapper.findAll(".kanban-project-column");
    expect(columnsEl.length).toBe(3);
    expect(columnsEl[0].find(".kanban-project-column-title").text()).toBe("Backlog");
    expect(columnsEl[0].find(".kanban-project-column-count").text()).toBe("2");
    expect(columnsEl[1].find(".kanban-project-column-title").text()).toBe("In Progress");
    expect(columnsEl[2].find(".kanban-project-column-title").text()).toBe("Done");

    const card = columnsEl[0].find(".kanban-project-card");
    expect(card.element.tagName).toBe("BUTTON");
    expect(card.text()).toContain("G4.S5");
    expect(card.text()).toContain("Workbench kanban sync");
    expect(card.text()).toContain("Backlog");
    expect(card.attributes("href")).toBeUndefined();
    wrapper.unmount();
  });

  it("lists ONLY the open linked projects in the selector (closed ones never reach the view) (G4.S5.T12)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    fetchGithubProjectsMock.mockResolvedValue(PROJECTS);
    const wrapper = await mountKanbanTab(REPO);

    await wrapper.find(".kanban-view-toggle-github").trigger("click");
    await flushPromises();

    const select = wrapper.findComponent({ name: "TSelect" });
    expect(select.exists()).toBe(true);
    // One option per OPEN linked project — the closed 'untitled project' is absent.
    expect(select.props("options")).toEqual([
      { label: "athena-agent", value: "PVT_1" },
    ]);
    // The default selection is the first open project.
    expect(select.props("modelValue")).toBe("PVT_1");
    expect(fetchGithubProjectBoardMock).toHaveBeenCalledWith("tok_1", "zouhanhai/athena-agent", "PVT_1");
    wrapper.unmount();
  });

  it("defaults the selector to the first open project and loads its board (G4.S5.T12)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    fetchGithubProjectsMock.mockResolvedValue(PROJECTS_TWO);
    const wrapper = await mountKanbanTab(REPO);

    await wrapper.find(".kanban-view-toggle-github").trigger("click");
    await flushPromises();

    const select = wrapper.findComponent({ name: "TSelect" });
    expect(select.props("modelValue")).toBe("PVT_1");
    expect(fetchGithubProjectBoardMock).toHaveBeenCalledWith("tok_1", "zouhanhai/athena-agent", "PVT_1");
    expect(wrapper.find(".kanban-project-board").exists()).toBe(true);
    wrapper.unmount();
  });

  it("switching the selector loads the chosen project's board (G4.S5.T12)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    fetchGithubProjectsMock.mockResolvedValue(PROJECTS_TWO);
    const wrapper = await mountKanbanTab(REPO);

    await wrapper.find(".kanban-view-toggle-github").trigger("click");
    await flushPromises();

    // User picks the second open project in the selector.
    const select = wrapper.findComponent({ name: "TSelect" });
    await select.vm.$emit("update:modelValue", "PVT_2");
    await select.vm.$emit("change", "PVT_2");
    await flushPromises();

    expect(fetchGithubProjectBoardMock).toHaveBeenLastCalledWith(
      "tok_1",
      "zouhanhai/athena-agent",
      "PVT_2",
    );
    // The choice is remembered for the next visit.
    expect(localStorage.getItem("athena.kanban.project_id")).toBe("PVT_2");
    wrapper.unmount();
  });

  it("remembers the last-chosen project across visits (G4.S5.T12)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    localStorage.setItem("athena.kanban.project_id", "PVT_2");
    fetchGithubProjectsMock.mockResolvedValue(PROJECTS_TWO);
    const wrapper = await mountKanbanTab(REPO);

    await wrapper.find(".kanban-view-toggle-github").trigger("click");
    await flushPromises();

    // The remembered project is restored instead of always the first.
    expect(wrapper.findComponent({ name: "TSelect" }).props("modelValue")).toBe("PVT_2");
    expect(fetchGithubProjectBoardMock).toHaveBeenCalledWith("tok_1", "zouhanhai/athena-agent", "PVT_2");
    wrapper.unmount();
  });

  it("shows a no-open-project hint when the repo has no open linked Project (G4.S5.T12)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    fetchGithubProjectsMock.mockResolvedValue([]);
    const wrapper = await mountKanbanTab(REPO);

    await wrapper.find(".kanban-view-toggle-github").trigger("click");
    await flushPromises();

    expect(wrapper.find(".kanban-project-empty-title").text()).toContain("No open linked Project");
    expect(fetchGithubProjectBoardMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("renders Spec cards (brand-orange accent + segmented progress) AND ticket sub-issue cards (plain) (G4.S5.T9)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab(REPO);

    await wrapper.find(".kanban-view-toggle-github").trigger("click");
    await flushPromises();

    // Both the Spec cards and the ticket sub-issue cards render, spread across
    // their Status columns (GitHub-native, T9 reverts T6).
    const cards = wrapper.findAll(".kanban-project-card");
    expect(cards.length).toBe(5);
    expect(cards.map((c) => c.find(".kanban-project-card-ref").text())).toEqual([
      "G4.S5",
      "G4.S5.T3",
      "G4.S5.T2",
      "G4.S6",
      "G4.S5.T1",
    ]);

    // Spec cards carry the brand-accent class; ticket cards stay plain.
    const specCards = cards.filter((c) => c.classes().includes("kanban-project-card-spec"));
    expect(specCards.length).toBe(2);
    expect(specCards.map((c) => c.find(".kanban-project-card-ref").text())).toEqual(["G4.S5", "G4.S6"]);
    const ticketCards = cards.filter((c) => !c.classes().includes("kanban-project-card-spec"));
    expect(ticketCards.map((c) => c.find(".kanban-project-card-ref").text())).toEqual([
      "G4.S5.T3",
      "G4.S5.T2",
      "G4.S5.T1",
    ]);

    // Header shows repo + Spec ref + issue id (ABAPlorer-style `owner/repo #id`).
    const card = specCards[0];
    expect(card.find(".kanban-project-card-repo").text()).toBe("zouhanhai/athena-agent");
    expect(card.find(".kanban-project-card-issue").text()).toBe("#1");

    // Spec card keeps its segmented progress bar: N blocks = N sub-issues; done fills a block.
    const blocks = card.findAll(".kanban-spec-progress-block");
    expect(blocks.length).toBe(5);
    const filled = card.findAll(".kanban-spec-progress-block-filled");
    expect(filled.length).toBe(4);

    // Brand palette: filled blocks use --caleo-primary, empty use the theme-muted border.
    expect(filled[0].attributes("style")).toContain("--caleo-primary");
    const empty = blocks.filter((b) => !b.classes().includes("kanban-spec-progress-block-filled"));
    expect(empty.length).toBe(1);
    expect(empty[0].attributes("style")).toContain("--caleo-border");
    expect(empty[0].attributes("style")).not.toContain("--caleo-primary");

    // done / total · percent (like ABAPlorer's `4 / 5 · 80%`).
    expect(card.find(".kanban-spec-progress-text").text()).toBe("4 / 5 · 80%");
    expect(specCards[1].find(".kanban-spec-progress-text").text()).toBe("1 / 2 · 50%");

    // Ticket cards are plain: no progress bar, no accent.
    for (const ticketCard of ticketCards) {
      expect(ticketCard.find(".kanban-spec-progress").exists()).toBe(false);
      expect(ticketCard.classes()).not.toContain("kanban-project-card-spec");
    }
    wrapper.unmount();
  });

  it("gives Spec cards a theme-adaptive brand-orange accent that stays legible in dark AND light (G4.S5.T9)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab(REPO);

    await wrapper.find(".kanban-view-toggle-github").trigger("click");
    await flushPromises();

    // The Spec card gets the accent class; a ticket sub-issue card does not.
    const specCard = wrapper.find(".kanban-project-card-spec");
    expect(specCard.exists()).toBe(true);
    const ticketCard = wrapper.find(".kanban-project-card:not(.kanban-project-card-spec)");
    expect(ticketCard.exists()).toBe(true);
    expect(ticketCard.classes()).not.toContain("kanban-project-card-spec");
    expect(ticketCard.find(".kanban-project-card-ref").text()).toMatch(/T\d+$/);

    // The accent tint CSS variable adapts to the active theme: a subtle tint in
    // light mode, a brighter one in dark mode (theme CSS-variable system).
    applyTheme("dark");
    const darkTint = document.documentElement.style.getPropertyValue("--caleo-primary-tint");
    expect(darkTint).toBeTruthy();
    applyTheme("light");
    const lightTint = document.documentElement.style.getPropertyValue("--caleo-primary-tint");
    expect(lightTint).toBeTruthy();
    expect(darkTint).not.toBe(lightTint);
    expect(specCard.element.className).toContain("kanban-project-card-spec");
    wrapper.unmount();
  });

  it("clicking a card opens a LOCAL detail panel with the GitHub issue body + GitHub comments (no redirect) (G4.S5.T16)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab(REPO);

    await wrapper.find(".kanban-view-toggle-github").trigger("click");
    await flushPromises();

    const specCard = wrapper.findAll(".kanban-project-card-spec")[1];
    await specCard.trigger("click");
    await flushPromises();

    // No navigation happened; a local panel is open instead.
    expect(wrapper.find(".kanban-detail-panel").exists()).toBe(true);
    expect(wrapper.find(".kanban-detail-ref").text()).toBe("G4.S6");

    // G4.S5.T16: the detail reads the GITHUB ISSUE BODY (same as the Issues
    // panel) — NOT the local md. The local md is never fetched for the panel.
    expect(fetchGithubIssueBodyMock).toHaveBeenCalledWith("tok_1", "zouhanhai/athena-agent", 2);
    expect(wrapper.find(".kanban-detail-description").text()).toContain("KB lifecycle is a GitHub issue body.");
    // No Progress Log anywhere in the detail.
    expect(wrapper.find(".kanban-detail-progress").exists()).toBe(false);
    expect(wrapper.find(".kanban-detail-progress-row").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Progress Log");

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

  it("shows the Spec's sub-issues list (ref/title/status/number) in the detail panel (G4.S5.T8)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab(REPO);

    await wrapper.find(".kanban-view-toggle-github").trigger("click");
    await flushPromises();
    await wrapper.find(".kanban-project-card").trigger("click");
    await flushPromises();

    const rows = wrapper.findAll(".kanban-detail-subissue");
    expect(rows.length).toBe(5);
    expect(rows[0].text()).toContain("G4.S5.T1");
    expect(rows[0].text()).toContain("done");
    expect(rows[0].text()).toContain("#11");
    expect(rows[1].text()).toContain("G4.S5.T2");
    expect(rows[1].text()).toContain("open");
    expect(rows[1].text()).toContain("#12");
    wrapper.unmount();
  });

  it("clicking a sub-issue opens its own detail (GitHub issue body + comments) (G4.S5.T8)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab(REPO);

    await wrapper.find(".kanban-view-toggle-github").trigger("click");
    await flushPromises();
    await wrapper.find(".kanban-project-card").trigger("click");
    await flushPromises();

    await wrapper.find(".kanban-detail-subissue-main").trigger("click");
    await flushPromises();

    expect(wrapper.find(".kanban-detail-ref").text()).toBe("G4.S5.T1");
    expect(fetchGithubIssueBodyMock).toHaveBeenCalledWith("tok_1", "zouhanhai/athena-agent", 11);
    expect(fetchGithubIssueCommentsMock).toHaveBeenCalledWith("tok_1", "zouhanhai/athena-agent", 11);
    // A sub-issue has no nested sub-issues of its own.
    expect(wrapper.findAll(".kanban-detail-subissue").length).toBe(0);
    wrapper.unmount();
  });

  it("embeds the detail panel inside the Kanban area (not a full-screen overlay) (G4.S5.T8)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab(REPO);

    await wrapper.find(".kanban-view-toggle-github").trigger("click");
    await flushPromises();
    await wrapper.find(".kanban-project-card").trigger("click");
    await flushPromises();

    const overlay = wrapper.find(".kanban-detail-overlay");
    expect(overlay.exists()).toBe(true);
    // Embedded non-modal panel — never the old full-screen modal overlay.
    expect(overlay.classes()).toContain("kanban-detail-embedded");
    expect(wrapper.find(".kanban-detail-panel").attributes("aria-modal")).not.toBe("true");
    wrapper.unmount();
  });

  it("the 'view in Issues' action emits open-issue (local nav, not a GitHub redirect) (G4.S5.T8)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab(REPO);

    await wrapper.find(".kanban-view-toggle-github").trigger("click");
    await flushPromises();
    await wrapper.find(".kanban-project-card").trigger("click");
    await flushPromises();

    // Header action locates the Spec issue.
    await wrapper.find(".kanban-detail-locate").trigger("click");
    expect(wrapper.emitted("open-issue")).toHaveLength(1);
    expect(wrapper.emitted("open-issue")![0]).toEqual([{ issueNumber: 1 }]);

    // A sub-issue row's action locates that sub-issue's issue.
    await wrapper.find(".kanban-detail-subissue-locate").trigger("click");
    expect(wrapper.emitted("open-issue")).toHaveLength(2);
    expect(wrapper.emitted("open-issue")![1]).toEqual([{ issueNumber: 11 }]);
    wrapper.unmount();
  });

  it("posts a new GitHub comment from the panel and shows it (G4.S5.T8)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab(REPO);

    await wrapper.find(".kanban-view-toggle-github").trigger("click");
    await flushPromises();
    await wrapper.find(".kanban-project-card").trigger("click");
    await flushPromises();

    await wrapper.find(".kanban-detail-comment-input").setValue("Posted from the panel");
    await wrapper.find(".kanban-detail-comment-submit").trigger("click");
    await flushPromises();

    expect(postGithubIssueCommentMock).toHaveBeenCalledWith(
      "tok_1",
      "zouhanhai/athena-agent",
      1,
      "Posted from the panel",
    );
    const comments = wrapper.findAll(".kanban-detail-comment");
    expect(comments.length).toBe(2);
    expect(comments.at(-1)?.find(".kanban-detail-comment-body").text()).toContain("Posted from the panel");
    expect((wrapper.find(".kanban-detail-comment-input").element as HTMLTextAreaElement).value).toBe("");
    wrapper.unmount();
  });

  it("renders the GitHub issue body — even a body with no Progress Log is shown as-is, no local md (G4.S5.T16)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    fetchGithubIssueBodyMock.mockResolvedValue({
      number: 2,
      title: "KB lifecycle",
      state: "open",
      html_url: "https://github.com/zouhanhai/athena-agent/issues/2",
      user_login: "alice",
      body: "# Body\n\nDecomposed into tickets.\n",
      labels: [],
      assignees: [],
    });
    const wrapper = await mountKanbanTab(REPO);

    await wrapper.find(".kanban-view-toggle-github").trigger("click");
    await flushPromises();
    await wrapper.find(".kanban-project-card").trigger("click");
    await flushPromises();

    // The GitHub issue body renders; nothing from the local md / Progress Log.
    expect(wrapper.find(".kanban-detail-description").text()).toContain("Decomposed into tickets.");
    expect(wrapper.find(".kanban-detail-progress-row").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Progress Log");
    wrapper.unmount();
  });
});
