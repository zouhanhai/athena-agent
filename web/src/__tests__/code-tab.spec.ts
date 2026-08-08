import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import CodeTab from "@/components/CodeTab.vue";
import {
  fetchBranches,
  fetchFileContent,
  fetchRepos,
  fetchTree,
} from "@/api/github";
import type { GithubBranch, GithubRepo, GithubTreeEntry } from "@/api/github";

vi.mock("@/api/github", () => ({
  fetchRepos: vi.fn(),
  fetchBranches: vi.fn(),
  fetchTree: vi.fn(),
  fetchFileContent: vi.fn(),
}));

const fetchReposMock = fetchRepos as unknown as ReturnType<typeof vi.fn>;
const fetchBranchesMock = fetchBranches as unknown as ReturnType<typeof vi.fn>;
const fetchTreeMock = fetchTree as unknown as ReturnType<typeof vi.fn>;
const fetchFileContentMock = fetchFileContent as unknown as ReturnType<typeof vi.fn>;

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

async function mountCodeTab() {
  const wrapper = mount(CodeTab, {
    global: { plugins: [createPinia(), TDesign] },
  });
  await flushPromises();
  return wrapper;
}

type Wrapper = Awaited<ReturnType<typeof mountCodeTab>>;

function selects(wrapper: Wrapper) {
  return wrapper.findAllComponents({ name: "TSelect" });
}

function repoSelect(wrapper: Wrapper) {
  return selects(wrapper)[0];
}

function branchSelect(wrapper: Wrapper) {
  return selects(wrapper)[1];
}

async function selectRepo(wrapper: Wrapper, fullName = "zouhanhai/athena-agent") {
  await repoSelect(wrapper)!.vm.$emit("update:modelValue", fullName);
  await flushPromises();
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
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("shows an empty state without a session token and makes no API calls", async () => {
    const wrapper = await mountCodeTab();
    expect(wrapper.find(".code-empty").exists()).toBe(true);
    expect(fetchReposMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("loads repos on mount and renders the repo selector", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountCodeTab();
    expect(fetchReposMock).toHaveBeenCalledWith("tok_1");
    expect(repoSelect(wrapper).exists()).toBe(true);
    const options = repoSelect(wrapper).props("options") as { label: string; value: string }[];
    expect(options.map((o) => o.value)).toContain("zouhanhai/athena-agent");
    wrapper.unmount();
  });

  it("selecting a repo loads branches and the file tree at the default branch", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountCodeTab();
    await selectRepo(wrapper);

    expect(fetchBranchesMock).toHaveBeenCalledWith("tok_1", "zouhanhai", "athena-agent");
    expect(fetchTreeMock).toHaveBeenCalledTimes(1);
    expect(fetchTreeMock).toHaveBeenCalledWith("tok_1", "zouhanhai", "athena-agent", "master");
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
    await selectRepo(wrapper);

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
    await selectRepo(wrapper);

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

  it("changing the branch reloads the tree for that branch", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    const wrapper = await mountCodeTab();
    await selectRepo(wrapper);
    await selectBranch(wrapper, "feature");
    expect(fetchTreeMock).toHaveBeenLastCalledWith("tok_1", "zouhanhai", "athena-agent", "feature");
    wrapper.unmount();
  });

  it("shows an error message when the GitHub API fails", async () => {
    localStorage.setItem("athena.session_token", "tok_1");
    fetchReposMock.mockRejectedValue(new Error("no github credential registered"));
    const wrapper = await mountCodeTab();
    expect(wrapper.find(".code-error").text()).toContain("no github credential registered");
    wrapper.unmount();
  });
});
