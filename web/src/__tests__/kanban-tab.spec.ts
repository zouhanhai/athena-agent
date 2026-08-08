import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import KanbanTab from "@/components/KanbanTab.vue";
import { fetchBoard } from "@/api/kanban";
import type { KanbanBoard } from "@/api/kanban";

vi.mock("@/api/kanban", () => ({
  fetchBoard: vi.fn(),
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

const BOARD: KanbanBoard = {
  goals: [
    {
      ref: "G1",
      goal: {
        id: "g1",
        title: "G1: Foundation",
        layer: "G",
        owner: "consultant",
        status: "active",
        milestone: "M1",
        acceptance_criteria: ["done"],
      },
      specs: [
        {
          ref: "G1.S1",
          spec: {
            id: "g1_s1",
            title: "G1.S1: Auth",
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
                title: "G1.S1.T1: Login flow",
                layer: "T",
                parent: "G1.S1",
                owner: "eng-director",
                status: "done",
                assignee: "opencode",
                blocked_by: [],
                acceptance_criteria: ["works"],
              },
            },
            {
              ref: "G1.S1.T2",
              ticket: {
                id: "t2",
                title: "G1.S1.T2: Session expiry",
                layer: "T",
                parent: "G1.S1",
                owner: "eng-director",
                status: "in_progress",
                assignee: "opencode",
                session_id: "ses_1",
                started_at: "2026-08-01",
                blocked_by: [],
                acceptance_criteria: ["expires"],
              },
            },
          ],
        },
      ],
    },
  ],
  errors: [],
};

async function mountKanbanTab() {
  const wrapper = mount(KanbanTab, {
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

  it("loads the board on mount and renders one column per ticket status", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab();

    expect(fetchBoardMock).toHaveBeenCalledWith("tok_1");
    expect(columns(wrapper).length).toBeGreaterThan(0);
    const labels = columns(wrapper).map((c) => c.find(".kanban-column-title").text());
    for (const status of ["backlog", "in_progress", "done", "in_review", "approved", "rejected"]) {
      expect(labels.some((l) => l.includes(status.replace("_", " ")))).toBe(true);
    }
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

  it("renders the G.S.T ref and assignee on each ticket card", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab();

    const done = columnByStatus(wrapper, "done");
    const card = done!.find(".kanban-card");
    expect(card!.text()).toContain("G1.S1.T1");
    expect(card!.text()).toContain("Login flow");
    expect(card!.text()).toContain("opencode");
    wrapper.unmount();
  });

  it("shows the goal and spec refs on the board", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountKanbanTab();

    const text = wrapper.text();
    expect(text).toContain("G1");
    expect(text).toContain("G1.S1");
    expect(text).toContain("G1: Foundation");
    expect(text).toContain("G1.S1: Auth");
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

  it("shows an error message when the kanban API fails", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    fetchBoardMock.mockRejectedValue(new Error("disk read failed"));
    const wrapper = await mountKanbanTab();
    expect(wrapper.find(".kanban-error").text()).toContain("disk read failed");
    wrapper.unmount();
  });
});
