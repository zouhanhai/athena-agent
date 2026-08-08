import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import IssuesTab from "@/components/IssuesTab.vue";
import { fetchIssues, fetchRepos } from "@/api/github";
import type { GithubIssue, GithubRepo, GithubIssueState } from "@/api/github";

vi.mock("@/api/github", () => ({
  fetchRepos: vi.fn(),
  fetchIssues: vi.fn(),
}));

const fetchReposMock = fetchRepos as unknown as ReturnType<typeof vi.fn>;
const fetchIssuesMock = fetchIssues as unknown as ReturnType<typeof vi.fn>;

const REPOS: GithubRepo[] = [
  {
    name: "athena-agent",
    full_name: "zouhanhai/athena-agent",
    html_url: "https://github.com/zouhanhai/athena-agent",
    description: "portal",
    private: false,
    default_branch: "master",
  },
];

const ISSUES: GithubIssue[] = [
  {
    number: 2,
    title: "Bug on login",
    state: "open",
    html_url: "https://github.com/zouhanhai/athena-agent/issues/2",
    user_login: "bob",
    body: "Repro steps",
    labels: ["bug", "p1"],
    assignees: ["alice"],
  },
  {
    number: 3,
    title: "Stale cache",
    state: "closed",
    html_url: "https://github.com/zouhanhai/athena-agent/issues/3",
    user_login: "carol",
    body: null,
    labels: ["p2"],
    assignees: [],
  },
];

async function mountIssuesTab() {
  const wrapper = mount(IssuesTab, {
    global: { plugins: [createPinia(), TDesign] },
  });
  await flushPromises();
  return wrapper;
}

type Wrapper = Awaited<ReturnType<typeof mountIssuesTab>>;

function selects(wrapper: Wrapper) {
  return wrapper.findAllComponents({ name: "TSelect" });
}

function repoSelect(wrapper: Wrapper) {
  return selects(wrapper)[0];
}

async function selectRepo(wrapper: Wrapper, fullName = "zouhanhai/athena-agent") {
  await repoSelect(wrapper)!.vm.$emit("update:modelValue", fullName);
  await flushPromises();
}

async function setState(wrapper: Wrapper, state: "open" | "closed") {
  const buttons = wrapper.findAll(".issues-state-filter button");
  const target = buttons.find((b) => b.text().toLowerCase().includes(state));
  if (!target) {
    throw new Error(`no state filter button for ${state}`);
  }
  await target.trigger("click");
  await flushPromises();
}

describe("IssuesTab", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.clearAllMocks();
    fetchReposMock.mockResolvedValue(REPOS);
    fetchIssuesMock.mockImplementation(
      (_token: string, _owner: string, _repo: string, state: GithubIssueState = "open") =>
        Promise.resolve(state === "all" ? ISSUES : ISSUES.filter((issue) => issue.state === state)),
    );
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("shows an empty state without a session token and makes no API calls", async () => {
    const wrapper = await mountIssuesTab();
    expect(wrapper.find(".issues-empty").exists()).toBe(true);
    expect(fetchReposMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("loads repos on mount and renders the repo selector", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountIssuesTab();
    expect(fetchReposMock).toHaveBeenCalledWith("tok_1");
    expect(repoSelect(wrapper).exists()).toBe(true);
    const options = repoSelect(wrapper).props("options") as { label: string; value: string }[];
    expect(options.map((o) => o.value)).toContain("zouhanhai/athena-agent");
    wrapper.unmount();
  });

  it("selecting a repo loads issues with the default open state", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountIssuesTab();
    await selectRepo(wrapper);

    expect(fetchIssuesMock).toHaveBeenCalledWith("tok_1", "zouhanhai", "athena-agent", "open");
    expect(wrapper.findAll(".issue-row").length).toBe(1);
    expect(wrapper.find(".issue-row").text()).toContain("Bug on login");
    wrapper.unmount();
  });

  it("renders labels and assignees per issue", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountIssuesTab();
    await selectRepo(wrapper);

    const row = wrapper.find(".issue-row");
    expect(row.text()).toContain("bug");
    expect(row.text()).toContain("p1");
    expect(row.text()).toContain("alice");
    expect(row.text()).toContain("#2");
    wrapper.unmount();
  });

  it("switching the state filter to closed reloads issues", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountIssuesTab();
    await selectRepo(wrapper);

    await setState(wrapper, "closed");
    expect(fetchIssuesMock).toHaveBeenLastCalledWith("tok_1", "zouhanhai", "athena-agent", "closed");
    expect(wrapper.findAll(".issue-row").length).toBe(1);
    expect(wrapper.find(".issue-row").text()).toContain("Stale cache");
    wrapper.unmount();
  });

  it("shows a placeholder when the selected repo has no issues", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    fetchIssuesMock.mockResolvedValue([]);
    const wrapper = await mountIssuesTab();
    await selectRepo(wrapper);
    expect(wrapper.find(".issues-none").exists()).toBe(true);
    wrapper.unmount();
  });

  it("shows an error message when the GitHub API fails", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    fetchReposMock.mockRejectedValue(new Error("no github credential registered"));
    const wrapper = await mountIssuesTab();
    expect(wrapper.find(".issues-error").text()).toContain("no github credential registered");
    wrapper.unmount();
  });
});
