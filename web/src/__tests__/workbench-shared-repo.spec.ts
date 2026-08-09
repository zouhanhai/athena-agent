import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import WorkbenchView from "@/views/WorkbenchView.vue";
import CodeTab from "@/components/CodeTab.vue";
import IssuesTab from "@/components/IssuesTab.vue";
import KanbanTab from "@/components/KanbanTab.vue";
import { fetchRepos, fetchBranches, fetchTree, fetchFileContent, fetchCommits } from "@/api/github";
import type { GithubRepo } from "@/api/github";

vi.mock("@/api/github", () => ({
  fetchRepos: vi.fn(),
  fetchBranches: vi.fn(),
  fetchTree: vi.fn(),
  fetchFileContent: vi.fn(),
  fetchCommits: vi.fn(),
}));

const fetchReposMock = fetchRepos as unknown as ReturnType<typeof vi.fn>;
const fetchBranchesMock = fetchBranches as unknown as ReturnType<typeof vi.fn>;
const fetchTreeMock = fetchTree as unknown as ReturnType<typeof vi.fn>;
const fetchFileContentMock = fetchFileContent as unknown as ReturnType<typeof vi.fn>;
const fetchCommitsMock = fetchCommits as unknown as ReturnType<typeof vi.fn>;

const REPOS: GithubRepo[] = [
  {
    name: "athena-agent",
    full_name: "zouhanhai/athena-agent",
    html_url: "https://github.com/zouhanhai/athena-agent",
    description: "portal",
    private: false,
    default_branch: "master",
  },
  {
    name: "other",
    full_name: "zouhanhai/other",
    html_url: "https://github.com/zouhanhai/other",
    description: null,
    private: true,
    default_branch: "main",
  },
];

async function mountWorkbench() {
  const wrapper = mount(WorkbenchView, {
    global: { plugins: [createPinia(), TDesign] },
  });
  await flushPromises();
  return wrapper;
}

type Wrapper = Awaited<ReturnType<typeof mountWorkbench>>;

function headerSelect(wrapper: Wrapper) {
  return wrapper.find(".workbench-header").findComponent({ name: "TSelect" });
}

async function openTab(wrapper: Wrapper, label: string) {
  const items = wrapper.findAll(".workbench-tabs .t-tabs__nav-item");
  const target = items.find((item) => item.text().includes(label));
  expect(target).toBeDefined();
  await target!.trigger("click");
  await flushPromises();
}

describe("Workbench shared repo selector", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.clearAllMocks();
    fetchReposMock.mockResolvedValue(REPOS);
    fetchBranchesMock.mockResolvedValue([]);
    fetchTreeMock.mockResolvedValue([]);
    fetchFileContentMock.mockResolvedValue({ path: "a.ts", sha: "s", size: 1, content: "x" });
    fetchCommitsMock.mockResolvedValue([]);
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("renders no repo selector without a session token", async () => {
    const wrapper = await mountWorkbench();
    expect(headerSelect(wrapper).exists()).toBe(false);
    expect(fetchReposMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("fetches repos once and renders ONE repo selector in the header", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountWorkbench();

    expect(fetchReposMock).toHaveBeenCalledTimes(1);
    expect(fetchReposMock).toHaveBeenCalledWith("tok_1");
    expect(headerSelect(wrapper).exists()).toBe(true);
    const options = headerSelect(wrapper).props("options") as { label: string; value: string }[];
    expect(options.map((o) => o.value)).toEqual(["zouhanhai/athena-agent", "zouhanhai/other"]);
    wrapper.unmount();
  });

  it("drives Code, Issues and Kanban from the single selection", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountWorkbench();

    expect(wrapper.findComponent(CodeTab).props("repo")).toBeNull();

    await headerSelect(wrapper)!.vm.$emit("update:modelValue", "zouhanhai/athena-agent");
    await flushPromises();
    expect(wrapper.findComponent(CodeTab).props("repo")).toMatchObject({
      full_name: "zouhanhai/athena-agent",
    });

    await openTab(wrapper, "Issues");
    expect(wrapper.findComponent(IssuesTab).props("repo")).toMatchObject({
      full_name: "zouhanhai/athena-agent",
    });

    await openTab(wrapper, "Kanban");
    expect(wrapper.findComponent(KanbanTab).props("repo")).toMatchObject({
      full_name: "zouhanhai/athena-agent",
    });
    wrapper.unmount();
  });

  it("shows a fetch error in the header when loading repos fails", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    fetchReposMock.mockRejectedValue(new Error("no github credential registered"));
    const wrapper = await mountWorkbench();
    expect(wrapper.find(".workbench-repo-error").text()).toContain("no github credential registered");
    wrapper.unmount();
  });

  it("renders the t-tabs content and active t-tab-panel so the Code pane gets a bounded height", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountWorkbench();
    const content = wrapper.find(".workbench-tabs .t-tabs__content");
    expect(content.exists()).toBe(true);
    expect(content.find(".t-tab-panel").exists()).toBe(true);
    expect(wrapper.find(".tab-panel-code").exists()).toBe(true);
    wrapper.unmount();
  });
});
