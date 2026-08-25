import { describe, expect, it, vi, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";
import WikiView from "@/views/WikiView.vue";
import { deleteWikiDoc, getWikiTree, readWikiPage, saveWikiPage } from "@/api/kb";
import { renderMarkdown } from "@/kb/markdown";
import { useAuthStore } from "@/stores/auth";
import type { WikiTreeNode } from "@/api/kb";

vi.mock("@/api/kb", () => ({
  getGraph: vi.fn(),
  getWikiTree: vi.fn(),
  readWikiPage: vi.fn(),
  getWikiCodeMeta: vi.fn(),
  searchKnowledge: vi.fn(),
  deleteWikiDoc: vi.fn(),
  saveWikiPage: vi.fn(),
}));

const getWikiTreeMock = getWikiTree as unknown as ReturnType<typeof vi.fn>;
const readWikiPageMock = readWikiPage as unknown as ReturnType<typeof vi.fn>;
const deleteWikiDocMock = deleteWikiDoc as unknown as ReturnType<typeof vi.fn>;
const saveWikiPageMock = saveWikiPage as unknown as ReturnType<typeof vi.fn>;

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

async function mountView(query: Record<string, string> = {}, mountOptions: Parameters<typeof mount>[1] & { authEmployee?: EmployeeRecordLike } = {}) {
  const { authEmployee, ...rest } = mountOptions;
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/wiki", component: WikiView }],
  });
  await router.push({ path: "/wiki", query });
  await router.isReady();
  const pinia = createPinia();
  if (authEmployee) {
    useAuthStore(pinia).setSession({ session_token: "t", employee: authEmployee });
  }
  const wrapper = mount(WikiView, {
    ...rest,
    global: {
      ...(rest.global ?? {}),
      plugins: [pinia, TDesign, router],
    },
  });
  return { wrapper, router };
}

/** Minimal employee shape for auth-store seeding in tests. */
interface EmployeeRecordLike {
  id: string;
  email: string;
  display_name: string;
  logo_url: string;
  role: "admin" | "member";
  permissions?: string[];
  created_at: string;
  updated_at: string;
}

const adminEmployee: EmployeeRecordLike = {
  id: "a1",
  email: "admin@caleo.com",
  display_name: "Admin",
  logo_url: "",
  role: "admin",
  created_at: "2026-08-08T00:00:00.000Z",
  updated_at: "2026-08-08T00:00:00.000Z",
};

const memberEmployee: EmployeeRecordLike = {
  id: "m1",
  email: "member@caleo.com",
  display_name: "Member",
  logo_url: "",
  role: "member",
  created_at: "2026-08-08T00:00:00.000Z",
  updated_at: "2026-08-08T00:00:00.000Z",
};

const editorEmployee: EmployeeRecordLike = {
  ...memberEmployee,
  permissions: ["kb.edit"],
};

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
  saveWikiPageMock.mockReset();
});

/** Open the "release-notes.md" file node in the Topic view. */
async function openReleaseNotes(wrapper: ReturnType<typeof mount>) {
  await clickView(wrapper, "Topic");
  await flushPromises();
  await expandFolder(wrapper, "Untagged");
  await flushPromises();
  const fileItem = wrapper
    .findAll(".t-tree__item")
    .find((item) => item.text().includes("release-notes.md"));
  await fileItem!.trigger("click");
  await flushPromises();
}

describe("renderMarkdown", () => {
  it("renders markdown to HTML", () => {
    const html = renderMarkdown("# Title\n\nSome **bold** text.");
    expect(html).toContain('<h1 id="title"');
    expect(html).toContain("<strong>bold</strong>");
  });
});

describe("WikiView", () => {
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
    expect(content.html()).toContain('<h1 id="runbook"');
    expect(content.html()).toContain("Steps here.");
    wrapper.unmount();
  });

  it("opens the content when a file node is clicked", async () => {
    getWikiTreeMock.mockResolvedValue(sampleTree);
    readWikiPageMock.mockResolvedValue("Root page body.");
    const { wrapper } = await mountView();
    await flushPromises();
    await clickView(wrapper, "Topic");
    await flushPromises();
    await expandFolder(wrapper, "Untagged");
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
    await clickView(wrapper, "Topic");
    await flushPromises();
    await expandFolder(wrapper, "Untagged");
    await flushPromises();

    const fileItem = wrapper
      .findAll(".t-tree__item")
      .find((item) => item.text().includes("release-notes.md"));
    await fileItem!.trigger("click");
    await flushPromises();

    expect(wrapper.find(".wiki-error").text()).toContain("page not found");
    wrapper.unmount();
  });

  it("shows a segmented control with Topic / Type views", async () => {
    getWikiTreeMock.mockResolvedValue(sampleTree);
    const { wrapper } = await mountView();
    await flushPromises();

    const buttons = wrapper.findAll(".t-radio-button");
    const labels = buttons.map((b) => b.text().trim());
    expect(labels).toContain("Topic");
    expect(labels).toContain("Type");
    expect(labels).not.toContain("All");
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

  it("shows a Delete button only when a file is selected", async () => {
    getWikiTreeMock.mockResolvedValue(sampleTree);
    readWikiPageMock.mockResolvedValue("body");
    const { wrapper } = await mountView();
    await flushPromises();
    await clickView(wrapper, "Topic");
    await flushPromises();
    await expandFolder(wrapper, "Untagged");
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
      llmwiki: { path: "release-notes.md" },
    });
    const { wrapper } = await mountView();
    await flushPromises();
    await clickView(wrapper, "Topic");
    await flushPromises();
    await expandFolder(wrapper, "Untagged");
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

  it("renders a TOC and serves source images for a long page (G3.S5.T5)", async () => {
    getWikiTreeMock.mockResolvedValue(sampleTree);
    readWikiPageMock.mockResolvedValue(
      "# Runbook\n\n## Setup\n\n![Diagram](images/runbook.pdf/diagram_001.png)\n\n## Recovery",
    );
    const { wrapper } = await mountView({ path: "docs/runbook.md" });
    await flushPromises();

    const content = wrapper.find('[data-testid="wiki-content"]');
    expect(content.html()).toContain("wiki-toc");
    expect(content.html()).toContain('href="#setup"');
    expect(content.html()).toContain('href="#recovery"');
    // image ref rewritten to the served wiki-image URL, resolved to the page dir
    expect(content.html()).toContain(
      'src="/api/kb/wiki/image?path=docs%2Fimages%2Frunbook.pdf%2Fdiagram_001.png"',
    );
    wrapper.unmount();
  });

  it("does not render a TOC when the page has no headings", async () => {
    getWikiTreeMock.mockResolvedValue(sampleTree);
    readWikiPageMock.mockResolvedValue("Plain body without headings.");
    const { wrapper } = await mountView({ path: "docs/runbook.md" });
    await flushPromises();

    const content = wrapper.find('[data-testid="wiki-content"]');
    expect(content.html()).not.toContain("wiki-toc");
    wrapper.unmount();
  });

  it("adds collapsible toggles to TOC items with children; leaves still link to anchors (G3.S5.T6)", async () => {
    getWikiTreeMock.mockResolvedValue(sampleTree);
    readWikiPageMock.mockResolvedValue("# Title\n\n## Setup\n\n### Sub\n\n## Recovery");
    const { wrapper } = await mountView({ path: "docs/runbook.md" });
    await flushPromises();

    const content = wrapper.find('[data-testid="wiki-content"]');

    // "Title" and "Setup" have children → get a toggle; "Recovery" is a leaf → none.
    const toggles = content.findAll(".wiki-toc-toggle");
    expect(toggles.length).toBe(2);

    // Default: top levels expanded, deeper levels collapsed (h3 list hidden).
    expect(toggles[0].classes()).not.toContain("is-collapsed");
    expect(toggles[1].classes()).toContain("is-collapsed");
    expect(content.find("ul.wiki-toc-collapsed a[href='#sub']").exists()).toBe(true);

    // Click the collapsed "Setup" toggle → its child <ul> (Sub) is revealed.
    await toggles[1].trigger("click");
    await flushPromises();
    expect(content.find("ul.wiki-toc-collapsed").exists()).toBe(false);
    expect(toggles[1].classes()).not.toContain("is-collapsed");
    expect(toggles[1].attributes("aria-expanded")).toBe("true");

    // Click again → re-collapses.
    await toggles[1].trigger("click");
    expect(content.find("ul.wiki-toc-collapsed a[href='#sub']").exists()).toBe(true);

    // Click the expanded "Title" toggle → its h2 list collapses too.
    await toggles[0].trigger("click");
    expect(content.find("ul.wiki-toc-collapsed a[href='#setup']").exists()).toBe(true);

    // A leaf TOC entry remains a working anchor link.
    expect(content.find('a[href="#recovery"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("shows the selected file's headings in the left tree and scrolls on click (G3.S5.T6)", async () => {
    getWikiTreeMock.mockResolvedValue(sampleTree);
    readWikiPageMock.mockResolvedValue("# Title\n\n## Setup\n\n### Sub");
    const scrollSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      value: scrollSpy,
      writable: true,
      configurable: true,
    });
    try {
      const { wrapper } = await mountView({ path: "docs/runbook.md" }, { attachTo: document.body });
      await flushPromises();
      await expandFolder(wrapper, "Untagged");
      await flushPromises();

      // Nested headings: expand the top-level "Title" node first so its h2
      // children (Setup) are in the DOM (large-doc tree collapse behavior).
      const titleItem = wrapper
        .findAll(".t-tree__item")
        .find((i) => i.text().includes("Title"));
      expect(titleItem).toBeDefined();
      await titleItem!.trigger("click");
      await flushPromises();
      const headingItem = wrapper
        .findAll(".t-tree__item")
        .find((i) => i.text().includes("Setup"));
      expect(headingItem).toBeDefined();
      await headingItem!.trigger("click");
      await flushPromises();
      expect(scrollSpy).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
      wrapper.unmount();
    } finally {
      if (original) {
        Object.defineProperty(Element.prototype, "scrollIntoView", { value: original, writable: true });
      } else {
        delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      }
    }
  });

  it("scrolls to a heading when a TOC entry is clicked (G3.S5.T5)", async () => {
    getWikiTreeMock.mockResolvedValue(sampleTree);
    readWikiPageMock.mockResolvedValue("# Title\n\n## Setup\n\nBody.");
    const scrollSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      value: scrollSpy,
      writable: true,
      configurable: true,
    });
    try {
      const { wrapper } = await mountView({ path: "docs/runbook.md" }, { attachTo: document.body });
      await flushPromises();
      const tocLink = wrapper.find('[data-testid="wiki-content"] a[href="#setup"]');
      expect(tocLink.exists()).toBe(true);
      await tocLink.trigger("click");
      expect(scrollSpy).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
      wrapper.unmount();
    } finally {
      if (original) {
        Object.defineProperty(Element.prototype, "scrollIntoView", { value: original, writable: true });
      } else {
        delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      }
    }
  });
});

// --- G4.S3.T10: permission-gated wiki editing ---

describe("WikiView editing (G4.S3.T10)", () => {
  it("shows the Edit button for an admin after a file is selected", async () => {
    getWikiTreeMock.mockResolvedValue(sampleTree);
    readWikiPageMock.mockResolvedValue("# Runbook\n\nBody.");
    const { wrapper } = await mountView({}, { authEmployee: adminEmployee });
    await flushPromises();
    await openReleaseNotes(wrapper);

    const editBtn = wrapper.find('[data-testid="wiki-edit-button"]');
    expect(editBtn.exists()).toBe(true);
    wrapper.unmount();
  });

  it("shows the Edit button for a member granted kb.edit", async () => {
    getWikiTreeMock.mockResolvedValue(sampleTree);
    readWikiPageMock.mockResolvedValue("# Runbook\n\nBody.");
    const { wrapper } = await mountView({}, { authEmployee: editorEmployee });
    await flushPromises();
    await openReleaseNotes(wrapper);

    expect(wrapper.find('[data-testid="wiki-edit-button"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("keeps the wiki read-only for a plain member (no Edit affordance)", async () => {
    getWikiTreeMock.mockResolvedValue(sampleTree);
    readWikiPageMock.mockResolvedValue("# Runbook\n\nBody.");
    const { wrapper } = await mountView({}, { authEmployee: memberEmployee });
    await flushPromises();
    await openReleaseNotes(wrapper);

    expect(wrapper.find('[data-testid="wiki-edit-button"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="wiki-editor-pane"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="wiki-content"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("keeps the wiki read-only when no employee is signed in", async () => {
    getWikiTreeMock.mockResolvedValue(sampleTree);
    readWikiPageMock.mockResolvedValue("# Runbook\n\nBody.");
    const { wrapper } = await mountView();
    await flushPromises();
    await openReleaseNotes(wrapper);

    expect(wrapper.find('[data-testid="wiki-edit-button"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("edit mode swaps the rendered page for a markdown editor with Save + Cancel", async () => {
    getWikiTreeMock.mockResolvedValue(sampleTree);
    readWikiPageMock.mockResolvedValue("# Runbook\n\nThe image shows a bright sky.");
    const { wrapper } = await mountView({}, { authEmployee: adminEmployee });
    await flushPromises();
    await openReleaseNotes(wrapper);

    await wrapper.find('[data-testid="wiki-edit-button"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="wiki-content"]').exists()).toBe(false);
    const editor = wrapper.find('[data-testid="wiki-editor"]');
    expect(editor.exists()).toBe(true);
    expect((editor.element as HTMLTextAreaElement).value).toContain("bright sky");
    expect(wrapper.text()).toContain("Save");
    expect(wrapper.text()).toContain("Cancel");
    wrapper.unmount();
  });

  it("Save sends the corrected markdown to saveWikiPage and switches back to the rendered page", async () => {
    getWikiTreeMock.mockResolvedValue(sampleTree);
    readWikiPageMock.mockResolvedValue("# Runbook\n\nThe image shows a bright sky.");
    saveWikiPageMock.mockResolvedValue({ taskId: "t1", saved: true, diff: { changed: true, structural: false } });
    const { wrapper } = await mountView({}, { authEmployee: adminEmployee });
    await flushPromises();
    await openReleaseNotes(wrapper);

    await wrapper.find('[data-testid="wiki-edit-button"]').trigger("click");
    await flushPromises();
    const editor = wrapper.find('[data-testid="wiki-editor"]');
    (editor.element as HTMLTextAreaElement).value = "# Runbook\n\nThe image shows a dark sky.";
    await editor.trigger("input");
    await flushPromises();

    await wrapper.find('[data-testid="wiki-save-button"]').trigger("click");
    await flushPromises();

    expect(saveWikiPageMock).toHaveBeenCalledWith("release-notes.md", "# Runbook\n\nThe image shows a dark sky.");
    // Back to the rendered page, now showing the corrected text.
    expect(wrapper.find('[data-testid="wiki-content"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("dark sky");
    wrapper.unmount();
  });

  it("surfaces a save failure without leaving edit mode", async () => {
    getWikiTreeMock.mockResolvedValue(sampleTree);
    readWikiPageMock.mockResolvedValue("# Runbook\n\nBody.");
    saveWikiPageMock.mockRejectedValue(new Error("forbidden: requires permission kb.edit"));
    const { wrapper } = await mountView({}, { authEmployee: adminEmployee });
    await flushPromises();
    await openReleaseNotes(wrapper);

    await wrapper.find('[data-testid="wiki-edit-button"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-testid="wiki-save-button"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="wiki-editor-pane"]').exists()).toBe(true);
    expect(wrapper.find(".wiki-error").text()).toContain("forbidden");
    wrapper.unmount();
  });

  it("Cancel exits edit mode and discards the draft", async () => {
    getWikiTreeMock.mockResolvedValue(sampleTree);
    readWikiPageMock.mockResolvedValue("# Runbook\n\nBody.");
    const { wrapper } = await mountView({}, { authEmployee: adminEmployee });
    await flushPromises();
    await openReleaseNotes(wrapper);

    await wrapper.find('[data-testid="wiki-edit-button"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-testid="wiki-cancel-button"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="wiki-content"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="wiki-editor-pane"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("preserves the reader's scroll position when entering edit mode", async () => {
    // Capture the rAF callback so we can run it AFTER the editor is sized.
    const rafHolder: { cb: ((time: number) => void) | null } = { cb: null };
    const origRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      rafHolder.cb = cb as (t: number) => void;
      return 0;
    };
    try {
      getWikiTreeMock.mockResolvedValue(sampleTree);
      readWikiPageMock.mockResolvedValue("# Runbook\n\n# A very long section\n\n" + "# X\n\n".repeat(200));
      const { wrapper } = await mountView({}, { authEmployee: adminEmployee });
      await flushPromises();
      await openReleaseNotes(wrapper);

      const content = wrapper.find('[data-testid="wiki-content"]');
      // Scroll the .wiki-content-pane container (the real scroll container).
      const pane = content.element.closest(".wiki-content-pane");
      Object.defineProperty(pane, "scrollHeight", { value: 2000, configurable: true });
      Object.defineProperty(pane, "clientHeight", { value: 500, configurable: true });
      Object.defineProperty(pane, "scrollTop", { value: 750, configurable: true }); // ratio 0.5

      await wrapper.find('[data-testid="wiki-edit-button"]').trigger("click");
      await flushPromises();

      const editor = wrapper.find('[data-testid="wiki-editor"]');
      expect(editor.exists()).toBe(true);
      // Size the editor, then run the captured rAF (which restores the ratio).
      Object.defineProperty(editor.element, "scrollHeight", { value: 3000, configurable: true });
      Object.defineProperty(editor.element, "clientHeight", { value: 500, configurable: true });
      if (rafHolder.cb) rafHolder.cb(0);
      expect((editor.element as HTMLTextAreaElement).scrollTop).toBeCloseTo(0.5 * 2500, -1);
      wrapper.unmount();
    } finally {
      window.requestAnimationFrame = origRaf;
    }
  });
});

