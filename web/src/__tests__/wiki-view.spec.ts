import { describe, expect, it, vi, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import WikiView from "@/views/WikiView.vue";
import { getWikiTree, readWikiPage } from "@/api/kb";
import { renderMarkdown } from "@/kb/markdown";
import type { WikiTreeNode } from "@/api/kb";

vi.mock("@/api/kb", () => ({
  getGraph: vi.fn(),
  getWikiTree: vi.fn(),
  readWikiPage: vi.fn(),
  searchKnowledge: vi.fn(),
}));

const getWikiTreeMock = getWikiTree as unknown as ReturnType<typeof vi.fn>;
const readWikiPageMock = readWikiPage as unknown as ReturnType<typeof vi.fn>;

const sampleTree: WikiTreeNode[] = [
  {
    name: "docs",
    path: "docs/",
    isDir: true,
    children: [
      { name: "runbook.md", path: "docs/runbook.md", isDir: false },
      { name: "architecture.md", path: "docs/architecture.md", isDir: false },
    ],
  },
  { name: "release-notes.md", path: "release-notes.md", isDir: false },
];

async function mountView(query: Record<string, string> = {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/wiki", component: WikiView }],
  });
  await router.push({ path: "/wiki", query });
  await router.isReady();
  const wrapper = mount(WikiView, {
    global: {
      plugins: [createPinia(), TDesign, router],
    },
  });
  return { wrapper, router };
}

afterEach(() => {
  getWikiTreeMock.mockReset();
  readWikiPageMock.mockReset();
});

describe("renderMarkdown", () => {
  it("renders markdown to HTML", () => {
    const html = renderMarkdown("# Title\n\nSome **bold** text.");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
  });
});

describe("WikiView", () => {
  it("loads the wiki tree on mount and renders folder/file names", async () => {
    getWikiTreeMock.mockResolvedValue(sampleTree);
    const { wrapper } = await mountView();
    await flushPromises();

    expect(getWikiTreeMock).toHaveBeenCalledTimes(1);
    expect(wrapper.find(".wiki-title").text()).toBe("Wiki");
    expect(wrapper.text()).toContain("docs");
    expect(wrapper.text()).toContain("release-notes.md");

    const docsItem = wrapper
      .findAll(".t-tree__item")
      .find((item) => item.text().includes("docs"));
    expect(docsItem).toBeDefined();
    await docsItem!.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("runbook.md");
    wrapper.unmount();
  });

  it("shows a friendly empty state when the wiki has no pages", async () => {
    getWikiTreeMock.mockResolvedValue([]);
    const { wrapper } = await mountView();
    await flushPromises();

    expect(wrapper.text()).toContain("No wiki pages yet");
    wrapper.unmount();
  });

  it("shows the error message when the tree fetch fails", async () => {
    getWikiTreeMock.mockRejectedValue(new Error("wiki down"));
    const { wrapper } = await mountView();
    await flushPromises();

    expect(wrapper.find(".wiki-error").text()).toContain("wiki down");
    wrapper.unmount();
  });

  it("opens a page from a deep link query param and renders its markdown", async () => {
    getWikiTreeMock.mockResolvedValue(sampleTree);
    readWikiPageMock.mockResolvedValue("# Runbook\n\nSteps here.");
    const { wrapper } = await mountView({ path: "docs/runbook.md" });
    await flushPromises();

    expect(readWikiPageMock).toHaveBeenCalledWith("docs/runbook.md");
    const content = wrapper.find('[data-testid="wiki-content"]');
    expect(content.exists()).toBe(true);
    expect(content.html()).toContain("<h1>Runbook</h1>");
    expect(content.html()).toContain("Steps here.");
    wrapper.unmount();
  });

  it("opens the content when a file node is clicked", async () => {
    getWikiTreeMock.mockResolvedValue(sampleTree);
    readWikiPageMock.mockResolvedValue("Root page body.");
    const { wrapper } = await mountView();
    await flushPromises();

    const fileItem = wrapper
      .findAll(".t-tree__item")
      .find((item) => item.text().includes("release-notes.md"));
    expect(fileItem).toBeDefined();
    await fileItem!.trigger("click");
    await flushPromises();

    expect(readWikiPageMock).toHaveBeenCalledWith("release-notes.md");
    const content = wrapper.find('[data-testid="wiki-content"]');
    expect(content.exists()).toBe(true);
    expect(content.text()).toContain("Root page body.");
    wrapper.unmount();
  });

  it("shows the error when the page content fetch fails", async () => {
    getWikiTreeMock.mockResolvedValue(sampleTree);
    readWikiPageMock.mockRejectedValue(new Error("page not found"));
    const { wrapper } = await mountView();
    await flushPromises();

    const fileItem = wrapper
      .findAll(".t-tree__item")
      .find((item) => item.text().includes("release-notes.md"));
    await fileItem!.trigger("click");
    await flushPromises();

    expect(wrapper.find(".wiki-error").text()).toContain("page not found");
    wrapper.unmount();
  });
});
