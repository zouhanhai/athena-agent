import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import IssuesTab from "@/components/IssuesTab.vue";
import {
  addIssueComment,
  fetchIssueDetail,
  fetchIssues,
  fetchLabels,
  fetchRepos,
  updateIssue,
} from "@/api/github";
import type { GithubIssue, GithubIssueComment, GithubRepo, GithubIssueState } from "@/api/github";

vi.mock("@/api/github", () => ({
  fetchRepos: vi.fn(),
  fetchIssues: vi.fn(),
  fetchIssueDetail: vi.fn(),
  fetchLabels: vi.fn(),
  updateIssue: vi.fn(),
  addIssueComment: vi.fn(),
}));

const fetchReposMock = fetchRepos as unknown as ReturnType<typeof vi.fn>;
const fetchIssuesMock = fetchIssues as unknown as ReturnType<typeof vi.fn>;
const fetchIssueDetailMock = fetchIssueDetail as unknown as ReturnType<typeof vi.fn>;
const fetchLabelsMock = fetchLabels as unknown as ReturnType<typeof vi.fn>;
const updateIssueMock = updateIssue as unknown as ReturnType<typeof vi.fn>;
const addIssueCommentMock = addIssueComment as unknown as ReturnType<typeof vi.fn>;

const DETAIL: { issue: GithubIssue; comments: GithubIssueComment[] } = {
  issue: {
    number: 2,
    title: "Bug on login",
    state: "open",
    html_url: "https://github.com/zouhanhai/athena-agent/issues/2",
    user_login: "bob",
    body: "**Repro** steps",
    labels: ["bug", "p1"],
    assignees: ["alice"],
  },
  comments: [
    {
      id: 100,
      user_login: "bob",
      body: "I'll take a look",
      created_at: "2026-08-01T10:00:00Z",
      html_url: "https://github.com/zouhanhai/athena-agent/issues/2#issuecomment-100",
    },
  ],
};

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

async function mountIssuesTab(repo: GithubRepo | null = REPOS[0]) {
  const wrapper = mount(IssuesTab, {
    props: { repo },
    global: { plugins: [createPinia(), TDesign] },
  });
  await flushPromises();
  return wrapper;
}

type Wrapper = Awaited<ReturnType<typeof mountIssuesTab>>;

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
    fetchIssueDetailMock.mockResolvedValue(DETAIL);
    fetchLabelsMock.mockResolvedValue(["bug", "p1"]);
    updateIssueMock.mockImplementation(
      async (_token: string, _owner: string, _repo: string, _number: number, input: Record<string, unknown>) =>
        ({ ...DETAIL.issue, ...input }),
    );
    addIssueCommentMock.mockImplementation(
      async (_token: string, _owner: string, _repo: string, _number: number, body: string) => ({
        id: 101,
        user_login: "alice",
        body,
        created_at: "2026-08-02T10:00:00Z",
        html_url: "https://github.com/zouhanhai/athena-agent/issues/2#issuecomment-101",
      }),
    );
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("shows an empty state without a session token and makes no API calls", async () => {
    const wrapper = await mountIssuesTab();
    expect(wrapper.find(".issues-empty").exists()).toBe(true);
    expect(fetchIssuesMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("shows a placeholder when no repo is selected", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountIssuesTab(null);
    expect(wrapper.find(".issues-empty-title").text()).toContain("Select a repository");
    expect(fetchIssuesMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("loads issues for the selected repo with the default open state", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountIssuesTab();

    expect(fetchIssuesMock).toHaveBeenCalledWith("tok_1", "zouhanhai", "athena-agent", "open");
    expect(wrapper.findAll(".issue-row").length).toBe(1);
    expect(wrapper.find(".issue-row").text()).toContain("Bug on login");
    wrapper.unmount();
  });

  it("renders labels and assignees per issue", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountIssuesTab();

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
    expect(wrapper.find(".issues-none").exists()).toBe(true);
    wrapper.unmount();
  });

  it("re-fetches issues when the selected repo prop changes", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountIssuesTab(REPOS[0]);
    await wrapper.setProps({ repo: { ...REPOS[0], full_name: "zouhanhai/other" } });
    await flushPromises();
    expect(fetchIssuesMock).toHaveBeenLastCalledWith("tok_1", "zouhanhai", "other", "open");
    wrapper.unmount();
  });

  it("shows an error message when the GitHub API fails", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    fetchIssuesMock.mockRejectedValue(new Error("no github credential registered"));
    const wrapper = await mountIssuesTab();
    expect(wrapper.find(".issues-error").text()).toContain("no github credential registered");
    wrapper.unmount();
  });

  it("opens a local detail panel when clicking an issue instead of navigating", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountIssuesTab();
    await wrapper.find(".issue-row").trigger("click");
    await flushPromises();

    expect(fetchIssueDetailMock).toHaveBeenCalledWith("tok_1", "zouhanhai", "athena-agent", 2);
    expect(wrapper.find(".issue-detail").exists()).toBe(true);
    expect(wrapper.find(".issue-view-title").text()).toContain("Bug on login");
    expect(wrapper.find(".issue-body").text()).toContain("Repro steps");
    expect(wrapper.find(".issue-detail").text()).toContain("open");
    expect(wrapper.find(".issue-detail").text()).toContain("alice");
    wrapper.unmount();
  });

  it("renders the comment thread with author, body and date in the detail panel", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountIssuesTab();
    await wrapper.find(".issue-row").trigger("click");
    await flushPromises();

    const comment = wrapper.find(".issue-comment");
    expect(comment.exists()).toBe(true);
    expect(comment.find(".issue-comment-head").text()).toContain("bob");
    expect(comment.find(".issue-comment-head").text()).toContain("2026");
    expect(comment.find(".issue-comment-body").text()).toContain("I'll take a look");
    wrapper.unmount();
  });

  it("edit mode saves title, body, state and labels via the update API", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountIssuesTab();
    await wrapper.find(".issue-row").trigger("click");
    await flushPromises();

    await wrapper.find(".issue-edit-btn").trigger("click");
    await flushPromises();

    const form = wrapper.find(".issue-edit-form");
    expect(form.exists()).toBe(true);
    const titleInput = wrapper.find("#issue-edit-title");
    expect((titleInput.element as HTMLInputElement).value).toBe("Bug on login");
    await titleInput.setValue("Bug fixed");
    await wrapper.find("#issue-edit-state").setValue("closed");
    const labelBox = wrapper.findAll('.issue-edit-label-check input[type="checkbox"]');
    const bugBox = labelBox.find((box) => (box.element as HTMLInputElement).value === "bug");
    expect(bugBox?.exists()).toBe(true);
    await form.trigger("submit");
    await flushPromises();

    expect(updateIssueMock).toHaveBeenCalledWith(
      "tok_1",
      "zouhanhai",
      "athena-agent",
      2,
      expect.objectContaining({ title: "Bug fixed", state: "closed" }),
    );
    expect(wrapper.find(".issue-view-title").text()).toContain("Bug fixed");
    expect(wrapper.find(".issue-edit-form").exists()).toBe(false);
    wrapper.unmount();
  });

  it("posts a comment from the comment box and appends it to the thread", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountIssuesTab();
    await wrapper.find(".issue-row").trigger("click");
    await flushPromises();

    await wrapper.find(".issue-comment-input").setValue("Looks good to me");
    await wrapper.find(".issue-comment-submit").trigger("click");
    await flushPromises();

    expect(addIssueCommentMock).toHaveBeenCalledWith("tok_1", "zouhanhai", "athena-agent", 2, "Looks good to me");
    expect((wrapper.find(".issue-comment-input").element as HTMLTextAreaElement).value).toBe("");
    const comments = wrapper.findAll(".issue-comment");
    expect(comments.length).toBe(2);
    expect(comments.at(-1)?.find(".issue-comment-body").text()).toContain("Looks good to me");
    wrapper.unmount();
  });

  it("closes the detail panel via the close button", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountIssuesTab();
    await wrapper.find(".issue-row").trigger("click");
    await flushPromises();
    expect(wrapper.find(".issue-detail").exists()).toBe(true);

    await wrapper.find(".issue-detail-close").trigger("click");
    expect(wrapper.find(".issue-detail").exists()).toBe(false);
    wrapper.unmount();
  });
});
