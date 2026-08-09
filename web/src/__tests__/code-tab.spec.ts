import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import CodeTab from "@/components/CodeTab.vue";
import {
  fetchBranches,
  fetchCommits,
  fetchFileContent,
  fetchRepos,
  fetchTree,
} from "@/api/github";
import { renderMarkdown } from "@/kb/markdown";
import type { GithubBranch, GithubCommit, GithubRepo, GithubTreeEntry } from "@/api/github";

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

const BRANCHES: GithubBranch[] = [
  { name: "master", sha: "b000000000000000000000000000000000000000", protected: true },
  { name: "feature", sha: "f000000000000000000000000000000000000000", protected: false },
];

const TREE: GithubTreeEntry[] = [
  { path: "README.md", type: "blob", mode: "100644", sha: "a1", size: 12 },
  { path: "src", type: "tree", mode: "040000", sha: "t1", size: null },
  { path: "src/index.ts", type: "blob", mode: "100644", sha: "c1", size: 120 },
];

const FILE_CONTENT = "const x = 1;\nconsole.log(x);\n";

const COMMITS: GithubCommit[] = [
  {
    sha: "c111111111111111111111111111111111111111",
    message: "Fix login bug",
    author_name: "Alice",
    author_email: "alice@acme.com",
    date: "2026-08-01T10:00:00Z",
    html_url: "https://github.com/zouhanhai/athena-agent/commit/c111",
  },
  {
    sha: "c222222222222222222222222222222222222222",
    message: "Add docs",
    author_name: "Bob",
    author_email: "bob@acme.com",
    date: "2026-07-30T09:00:00Z",
    html_url: "https://github.com/zouhanhai/athena-agent/commit/c222",
  },
];

async function mountCodeTab(repo: GithubRepo | null = REPOS[0]) {
  const wrapper = mount(CodeTab, {
    props: { repo },
    global: { plugins: [createPinia(), TDesign] },
  });
  await flushPromises();
  return wrapper;
}

type Wrapper = Awaited<ReturnType<typeof mountCodeTab>>;

function branchSelect(wrapper: Wrapper) {
  return wrapper.findAllComponents({ name: "TSelect" })[0];
}

async function selectBranch(wrapper: Wrapper, name = "feature") {
  await branchSelect(wrapper)!.vm.$emit("update:modelValue", name);
  await flushPromises();
}

describe("CodeTab", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.clearAllMocks();
    fetchReposMock.mockResolvedValue(REPOS);
    fetchBranchesMock.mockResolvedValue(BRANCHES);
    fetchTreeMock.mockResolvedValue(TREE);
    fetchFileContentMock.mockResolvedValue({ path: "src/index.ts", sha: "c1", size: 120, content: FILE_CONTENT });
    fetchCommitsMock.mockResolvedValue(COMMITS);
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("shows an empty state without a session token and makes no API calls", async () => {
    const wrapper = await mountCodeTab();
    expect(wrapper.find(".code-empty").exists()).toBe(true);
    expect(fetchBranchesMock).not.toHaveBeenCalled();
    expect(fetchCommitsMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("shows a placeholder when no repo is selected", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountCodeTab(null);
    expect(wrapper.find(".code-empty-title").text()).toContain("Select a repository");
    expect(fetchBranchesMock).not.toHaveBeenCalled();
    expect(fetchCommitsMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("loads branches, the file tree and commits for the selected repo on mount", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountCodeTab();

    expect(fetchBranchesMock).toHaveBeenCalledWith("tok_1", "zouhanhai", "athena-agent");
    expect(fetchTreeMock).toHaveBeenCalledTimes(1);
    expect(fetchTreeMock).toHaveBeenCalledWith("tok_1", "zouhanhai", "athena-agent", "master");
    expect(fetchCommitsMock).toHaveBeenCalledWith("tok_1", "zouhanhai", "athena-agent", "master");
    expect(wrapper.findAll(".tree-node-tree").length).toBeGreaterThan(0);
    expect(wrapper.findAll(".tree-node-blob").length).toBeGreaterThan(0);
    expect(branchSelect(wrapper).exists()).toBe(true);
    const options = branchSelect(wrapper).props("options") as { label: string; value: string }[];
    expect(options.map((o) => o.value)).toEqual(["master", "feature"]);
    wrapper.unmount();
  });

  it("expanding a folder reveals its children and collapses on a second click", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountCodeTab();

    const folder = wrapper.findAll(".tree-node-tree > .tree-row").at(-1)!;
    await folder.trigger("click");
    await flushPromises();
    expect(wrapper.find(".tree-children").classes()).not.toContain("tree-children-hidden");
    expect(wrapper.find(".tree-node-blob").text()).toContain("index.ts");

    await folder.trigger("click");
    await flushPromises();
    expect(wrapper.find(".tree-children").classes()).toContain("tree-children-hidden");
    wrapper.unmount();
  });

  it("clicking a file fetches content and renders line numbers with highlighted code", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountCodeTab();

    await wrapper.findAll(".tree-node-tree > .tree-row").at(-1)!.trigger("click");
    await flushPromises();
    await wrapper.find(".tree-node-blob .tree-row").trigger("click");
    await flushPromises();

    expect(fetchFileContentMock).toHaveBeenCalledWith("tok_1", "zouhanhai", "athena-agent", "src/index.ts", "master");
    const rows = wrapper.findAll(".code-line-row");
    expect(rows.length).toBe(3);
    expect(rows[0]!.find(".code-line-number").text()).toBe("1");
    expect(rows[1]!.find(".code-line-number").text()).toBe("2");
    expect(rows[0]!.find(".code-line-content").html()).toContain('class="tok-keyword"');
    expect(wrapper.find(".code-file-path").text()).toBe("src/index.ts");
    expect(wrapper.find(".code-file-lang").text()).toBe("typescript");
    wrapper.unmount();
  });

  it("changing the branch reloads the tree and commits for that branch", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountCodeTab();
    await selectBranch(wrapper, "feature");
    expect(fetchTreeMock).toHaveBeenLastCalledWith("tok_1", "zouhanhai", "athena-agent", "feature");
    expect(fetchCommitsMock).toHaveBeenLastCalledWith("tok_1", "zouhanhai", "athena-agent", "feature");
    wrapper.unmount();
  });

  it("shows the branch HEAD commit in the code header", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountCodeTab();
    const head = wrapper.find(".code-head");
    expect(head.exists()).toBe(true);
    expect(head.find(".code-head-sha").text()).toBe("c111111");
    expect(head.find(".code-head-message").text()).toBe("Fix login bug");
    wrapper.unmount();
  });

  it("renders the commit list with sha, message, author and date", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountCodeTab();
    const rows = wrapper.findAll(".commit-row");
    expect(rows.length).toBe(2);
    expect(rows[0]!.text()).toContain("c111111");
    expect(rows[0]!.text()).toContain("Fix login bug");
    expect(rows[0]!.text()).toContain("Alice");
    expect(rows[0]!.text()).toContain("2026-08-01");
    wrapper.unmount();
  });

  it("refresh re-fetches commits on demand (manual, no polling)", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountCodeTab();
    const callsAfterMount = fetchCommitsMock.mock.calls.length;
    await wrapper.find(".commits-refresh").trigger("click");
    await flushPromises();
    expect(fetchCommitsMock.mock.calls.length).toBe(callsAfterMount + 1);
    expect(fetchCommitsMock).toHaveBeenLastCalledWith("tok_1", "zouhanhai", "athena-agent", "master");
    wrapper.unmount();
  });

  it("collapses the commit list to the HEAD commit and expands it back", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountCodeTab();

    expect(wrapper.findAll(".commit-row").length).toBe(2);
    const toggle = wrapper.find(".commits-toggle");
    expect(toggle.exists()).toBe(true);
    expect(toggle.attributes("aria-expanded")).toBe("true");

    await toggle.trigger("click");
    await flushPromises();
    const rows = wrapper.findAll(".commit-row");
    expect(rows.length).toBe(1);
    expect(rows[0]!.text()).toContain("Fix login bug");
    expect(rows[0]!.text()).not.toContain("Add docs");
    expect(toggle.attributes("aria-expanded")).toBe("false");

    await toggle.trigger("click");
    await flushPromises();
    expect(wrapper.findAll(".commit-row").length).toBe(2);
    wrapper.unmount();
  });

  it("shows a Code/Preview toggle for .md files and renders the markdown preview", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    fetchFileContentMock.mockResolvedValue({
      path: "README.md",
      sha: "a1",
      size: 12,
      content: "# Readme\n\nSome **bold** text.",
    });
    const wrapper = await mountCodeTab();

    const readme = wrapper
      .findAll(".tree-node-blob")
      .find((item) => item.text().includes("README.md"));
    await readme!.find(".tree-row").trigger("click");
    await flushPromises();

    const toggle = wrapper.find(".md-toggle");
    expect(toggle.exists()).toBe(true);
    expect(wrapper.find(".code-lines").exists()).toBe(true);
    expect(wrapper.find(".md-preview").exists()).toBe(false);

    await toggle
      .findAll("button")
      .find((b) => b.text().includes("Preview"))!
      .trigger("click");
    await flushPromises();

    expect(wrapper.find(".code-lines").exists()).toBe(false);
    const preview = wrapper.find(".md-preview");
    expect(preview.exists()).toBe(true);
    expect(preview.html()).toContain("<h1");
    expect(preview.text()).toContain("Some bold text.");

    await toggle
      .findAll("button")
      .find((b) => b.text().includes("Code"))!
      .trigger("click");
    await flushPromises();
    expect(wrapper.find(".code-lines").exists()).toBe(true);
    expect(wrapper.find(".md-preview").exists()).toBe(false);
    wrapper.unmount();
  });

  it("renders the .md preview via the wiki renderMarkdown helper", async () => {
    const html = renderMarkdown("# Readme\n\nSome **bold** text.");
    expect(html).toContain("<h1");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("does not show a markdown toggle for non-markdown files", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountCodeTab();

    await wrapper.findAll(".tree-node-tree > .tree-row").at(-1)!.trigger("click");
    await flushPromises();
    await wrapper.find(".tree-node-blob .tree-row").trigger("click");
    await flushPromises();

    expect(wrapper.find(".code-file-path").text()).toBe("src/index.ts");
    expect(wrapper.find(".md-toggle").exists()).toBe(false);
    wrapper.unmount();
  });

  it("re-fetches tree and commits when the selected repo prop changes", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    fetchBranchesMock.mockResolvedValue([{ name: "main", sha: "m000", protected: true }]);
    const wrapper = await mountCodeTab(REPOS[0]);
    await wrapper.setProps({ repo: REPOS[1] });
    await flushPromises();
    expect(fetchBranchesMock).toHaveBeenLastCalledWith("tok_1", "zouhanhai", "other");
    expect(fetchTreeMock).toHaveBeenLastCalledWith("tok_1", "zouhanhai", "other", "main");
    expect(fetchCommitsMock).toHaveBeenLastCalledWith("tok_1", "zouhanhai", "other", "main");
    wrapper.unmount();
  });

  it("shows an error message when the GitHub API fails", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    fetchBranchesMock.mockRejectedValue(new Error("no github credential registered"));
    const wrapper = await mountCodeTab();
    expect(wrapper.find(".code-error").text()).toContain("no github credential registered");
    wrapper.unmount();
  });
});
