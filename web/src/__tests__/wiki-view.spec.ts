import { describe, expect, it, vi, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";
import WikiView from "@/views/WikiView.vue";
import { deleteWikiDoc, getWikiTree, readWikiPage } from "@/api/kb";
import { renderMarkdown } from "@/kb/markdown";
import type { WikiTreeNode } from "@/api/kb";

vi.mock("@/api/kb", () => ({
  getGraph: vi.fn(),
  getWikiTree: vi.fn(),
  readWikiPage: vi.fn(),
  searchKnowledge: vi.fn(),
  deleteWikiDoc: vi.fn(),
}));

const getWikiTreeMock = getWikiTree as unknown as ReturnType<typeof vi.fn>;
const readWikiPageMock = readWikiPage as unknown as ReturnType<typeof vi.fn>;
const deleteWikiDocMock = deleteWikiDoc as unknown as ReturnType<typeof vi.fn>;

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

/** Tree with frontmatter type/topic metadata for view-switcher tests. */
const metaTree: WikiTreeNode[] = [
  {
    name: "sommerseminar",
    path: "sommerseminar",
    isDir: true,
    children: [
      { name: "s1.md", path: "sommerseminar/s1.md", isDir: false, type: "concept", topic: "sommerseminar" },
    ],
  },
  {
    name: "sap",
    path: "sap",
    isDir: true,
    children: [
      { name: "f1.md", path: "sap/f1.md", isDir: false, type: "concept", topic: "sap/fiori" },
    ],
  },
  {
    name: "concepts",
    path: "concepts",
    isDir: true,
    children: [
      { name: "e1.md", path: "concepts/e1.md", isDir: false, type: "entity" },
    ],
  },
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

async function clickView(wrapper: ReturnType<typeof mount>, label: string) {
  const btn = wrapper.findAll(".t-radio-button").find((b) => b.text().includes(label));
  await btn!.trigger("click");
  await flushPromises();
}

async function expandFolder(wrapper: ReturnType<typeof mount>, name: string) {
  const item = wrapper.findAll(".t-tree__item").find((i) => i.text().includes(name));
  await item!.trigger("click");
  await flushPromises();
}

afterEach(() => {
  getWikiTreeMock.mockReset();
  readWikiPageMock.mockReset();
  deleteWikiDocMock.mockReset();
});

describe("renderMarkdown", () => {
  it("renders markdown to HTML", () => {
    const html = renderMarkdown("# Title\n\nSome **bold** text.");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
  });
});

describe("WikiView", () => {
  it("loads the wiki tree on mount and renders folder/file names in All view", async () => {
    getWikiTreeMock.mockResolvedValue(sampleTree);
    const { wrapper } = await mountView();
    await flushPromises();

    expect(getWikiTreeMock).toHaveBeenCalledTimes(1);
    expect(wrapper.find(".wiki-title").text()).toBe("Wiki");
    await clickView(wrapper, "All");
    await flushPromises();

    expect(wrapper.text()).toContain("docs");
    expect(wrapper.text()).toContain("release-notes.md");

    await expandFolder(wrapper, "docs");
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
    await clickView(wrapper, "All");
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
    await clickView(wrapper, "All");
    await flushPromises();

    const fileItem = wrapper
      .findAll(".t-tree__item")
      .find((item) => item.text().includes("release-notes.md"));
    await fileItem!.trigger("click");
    await flushPromises();

    expect(wrapper.find(".wiki-error").text()).toContain("page not found");
    wrapper.unmount();
  });

  it("shows a segmented control with Topic / Type / All views", async () => {
    getWikiTreeMock.mockResolvedValue(sampleTree);
    const { wrapper } = await mountView();
    await flushPromises();

    const buttons = wrapper.findAll(".t-radio-button");
    const labels = buttons.map((b) => b.text().trim());
    expect(labels).toContain("Topic");
    expect(labels).toContain("Type");
    expect(labels).toContain("All");
    wrapper.unmount();
  });

  it("defaults to the Topic view and groups pages by topic", async () => {
    getWikiTreeMock.mockResolvedValue(metaTree);
    const { wrapper } = await mountView();
    await flushPromises();

    expect(wrapper.text()).toContain("sommerseminar");
    expect(wrapper.text()).toContain("Untagged");
    await expandFolder(wrapper, "sommerseminar");
    await flushPromises();
    expect(wrapper.text()).toContain("s1.md");
    wrapper.unmount();
  });

  it("switches to the Type view and groups pages by frontmatter type", async () => {
    getWikiTreeMock.mockResolvedValue(metaTree);
    const { wrapper } = await mountView();
    await flushPromises();

    await clickView(wrapper, "Type");
    await flushPromises();

    expect(wrapper.text()).toContain("concept");
    expect(wrapper.text()).toContain("entity");
    await expandFolder(wrapper, "concept");
    await flushPromises();
    expect(wrapper.text()).toContain("s1.md");
    wrapper.unmount();
  });

  it("switches to the All view and shows the raw physical tree", async () => {
    getWikiTreeMock.mockResolvedValue(metaTree);
    const { wrapper } = await mountView();
    await flushPromises();

    await clickView(wrapper, "All");
    await flushPromises();

    // physical folders, not metadata groups
    expect(wrapper.text()).toContain("sommerseminar");
    expect(wrapper.text()).toContain("concepts");
    expect(wrapper.text()).not.toContain("Untagged");
    wrapper.unmount();
  });

  it("shows a Delete button only when a file is selected", async () => {
    getWikiTreeMock.mockResolvedValue(sampleTree);
    readWikiPageMock.mockResolvedValue("body");
    const { wrapper } = await mountView();
    await flushPromises();
    await clickView(wrapper, "All");
    await flushPromises();

    const headerControls = wrapper.find(".wiki-controls");
    expect(
      headerControls.findAll("button").some((b) => b.text().includes("Delete")),
    ).toBe(false);

    const fileItem = wrapper
      .findAll(".t-tree__item")
      .find((i) => i.text().includes("release-notes.md"));
    await fileItem!.trigger("click");
    await flushPromises();

    const deleteBtn = headerControls
      .findAll("button")
      .find((b) => b.text().includes("Delete"));
    expect(deleteBtn).toBeDefined();
    wrapper.unmount();
  });

  it("deletes the selected file after confirmation and refreshes the tree", async () => {
    getWikiTreeMock.mockResolvedValue(sampleTree);
    readWikiPageMock.mockResolvedValue("body");
    deleteWikiDocMock.mockResolvedValue({
      ok: true,
      lightrag: { deleted: ["doc-1"] },
      llmwiki: { path: "release-notes.md" },
    });
    const { wrapper } = await mountView();
    await flushPromises();
    await clickView(wrapper, "All");
    await flushPromises();

    const fileItem = wrapper
      .findAll(".t-tree__item")
      .find((i) => i.text().includes("release-notes.md"));
    await fileItem!.trigger("click");
    await flushPromises();

    await wrapper
      .find(".wiki-controls")
      .findAll("button")
      .find((b) => b.text().includes("Delete"))!.trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Delete document");

    const confirmBtn = wrapper
      .find(".t-dialog__footer")
      .findAll("button")
      .find((b) => b.text().includes("Delete"));
    expect(confirmBtn).toBeDefined();
    await confirmBtn!.trigger("click");
    await flushPromises();
    await flushPromises();

    expect(deleteWikiDocMock).toHaveBeenCalledWith("release-notes.md");
    expect(getWikiTreeMock).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });
});
