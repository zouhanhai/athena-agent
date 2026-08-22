import { describe, expect, it, vi, afterEach } from "vitest";
import { useAuthStore } from "@/stores/auth";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";
import WikiView from "@/views/WikiView.vue";
import {
  getWikiReviewState,
  getWikiTree,
  readWikiPage,
  updateWikiReviewState,
} from "@/api/kb";
import type { WikiReviewIssueView, WikiTreeNode } from "@/api/kb";

vi.mock("@/api/kb", () => ({
  getGraph: vi.fn(),
  getWikiTree: vi.fn(),
  readWikiPage: vi.fn(),
  getWikiCodeMeta: vi.fn(),
  getWikiReviewState: vi.fn(),
  updateWikiReviewState: vi.fn(),
  searchKnowledge: vi.fn(),
  deleteWikiDoc: vi.fn(),
  saveWikiPage: vi.fn(),
}));

const getWikiTreeMock = getWikiTree as unknown as ReturnType<typeof vi.fn>;
const readWikiPageMock = readWikiPage as unknown as ReturnType<typeof vi.fn>;
const getWikiReviewStateMock = getWikiReviewState as unknown as ReturnType<typeof vi.fn>;
const updateWikiReviewStateMock = updateWikiReviewState as unknown as ReturnType<typeof vi.fn>;

/** A Lüsen-shaped review page: frontmatter gate + two anchored-issue quotes in the body. */
const PAGE_PATH = "wiki/hiking/lusen.md";
const PAGE_CONTENT = [
  "---",
  "type: document",
  "title: Lüsen",
  "review: required",
  "review_count: 2",
  "---",
  "",
  "# Lüsen",
  "",
  "Der Zustieg am ????? ist unklar.",
  "",
  "Die Bildunterschrift fehlt hier.",
].join("\n");

function makeIssues(): WikiReviewIssueView[] {
  return [
    {
      id: "qi-1",
      message: "Placeholder 'Zustieg am ?????' left in the source",
      anchor: { quote: "Der Zustieg am ????? ist unklar.", heading_path: "Lüsen" },
      resolved: false,
      anchored: true,
    },
    {
      id: "qi-2",
      message: "Image caption missing",
      anchor: { quote: "Dieser Satz existiert nicht mehr" },
      resolved: false,
      anchored: false,
    },
  ];
}

const tree: WikiTreeNode[] = [
  {
    name: "hiking",
    path: "hiking/",
    isDir: true,
    children: [{ name: "lusen.md", path: PAGE_PATH, isDir: false }],
  },
];

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

async function mountWithPage(
  issues = makeIssues(),
  review: "required" | "clear" = "required",
  authEmployee?: EmployeeRecordLike,
) {
  getWikiTreeMock.mockResolvedValue(tree);
  readWikiPageMock.mockResolvedValue(PAGE_CONTENT);
  getWikiReviewStateMock.mockResolvedValue({
    path: PAGE_PATH,
    review,
    review_count: issues.filter((i) => !i.resolved).length,
    issues,
  });
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/wiki", component: WikiView }],
  });
  await router.push({ path: "/wiki", query: { path: PAGE_PATH } });
  await router.isReady();
  const pinia = createPinia();
  if (authEmployee) {
    useAuthStore(pinia).setSession({ session_token: "t", employee: authEmployee });
  }
  const wrapper = mount(WikiView, {
    global: { plugins: [pinia, TDesign, router] },
  });
  await flushPromises();
  await flushPromises();
  return wrapper;
}

afterEach(() => {
  [getWikiTreeMock, readWikiPageMock, getWikiReviewStateMock, updateWikiReviewStateMock].forEach((m) =>
    m.mockReset(),
  );
});

describe("WikiView review workflow (G4.S8.T17)", () => {
  it("renders a banner with the unresolved issue count for review-required pages", async () => {
    const wrapper = await mountWithPage();
    const banner = wrapper.find('[data-testid="wiki-review-banner"]');
    expect(banner.exists()).toBe(true);
    expect(banner.text()).toContain("本页有 2 处需要复核");
    wrapper.unmount();
  });

  it("highlights anchored issues inline at their recorded position", async () => {
    const wrapper = await mountWithPage();
    const content = wrapper.find('[data-testid="wiki-content"]');
    const highlights = content.findAll('mark[data-testid="wiki-review-highlight"]');
    expect(highlights).toHaveLength(1);
    expect(highlights[0].attributes("data-issue-id")).toBe("qi-1");
    expect(highlights[0].text()).toContain("Der Zustieg am ????? ist unklar.");
    wrapper.unmount();
  });

  it("lists unanchored issues in the banner (never dropped) without an inline highlight", async () => {
    const wrapper = await mountWithPage();
    const items = wrapper.findAll('[data-testid="wiki-review-issue-item"]');
    expect(items).toHaveLength(2);
    // the stale-anchor issue is flagged, not dropped
    const unanchored = items.find((i) => i.text().includes("Image caption missing"))!;
    expect(unanchored.text()).toContain("位置已变化");
    expect(unanchored.find(".wiki-review-issue-jump").exists()).toBe(false);
    // and no second highlight was injected for it
    expect(wrapper.find('[data-testid="wiki-content"]').findAll("mark.wiki-review-highlight")).toHaveLength(1);
    wrapper.unmount();
  });

  it("shows each issue's message and heading path in the banner list", async () => {
    const wrapper = await mountWithPage();
    const items = wrapper.findAll('[data-testid="wiki-review-issue-item"]');
    expect(items[0].text()).toContain("Placeholder 'Zustieg am ?????' left in the source");
    expect(items[0].text()).toContain("Lüsen");
    wrapper.unmount();
  });

  it("clicking 确认无误 on a highlight resolves the issue and decrements the count", async () => {
    updateWikiReviewStateMock.mockResolvedValue({
      path: PAGE_PATH,
      review: "required",
      review_count: 1,
      issues: [{ ...makeIssues()[0], resolved: true }, makeIssues()[1]],
    });
    const wrapper = await mountWithPage(makeIssues(), "required", adminEmployee);
    const highlight = wrapper.find('mark[data-testid="wiki-review-highlight"]');
    await highlight.trigger("click");
    await flushPromises();

    // popover content (TDesign teleports to body)
    const popover = document.querySelector('[data-testid="wiki-review-popover"]');
    expect(popover).not.toBeNull();
    expect(popover!.textContent).toContain("Zustieg");

    const resolveBtn = document.querySelector('[data-testid="wiki-review-resolve"]') as HTMLButtonElement | null;
    expect(resolveBtn).not.toBeNull();
    resolveBtn!.click();
    await flushPromises();
    await flushPromises();

    expect(updateWikiReviewStateMock).toHaveBeenCalledWith(PAGE_PATH, "qi-1", "resolve", undefined);
    expect(wrapper.find('[data-testid="wiki-review-banner"]').text()).toContain("本页有 1 处需要复核");
    wrapper.unmount();
  });

  it("需要修改 keeps the issue open and persists the operator note", async () => {
    updateWikiReviewStateMock.mockImplementation(async (_p: string, _id: string, _action: string, note?: string) => ({
      path: PAGE_PATH,
      review: "required",
      review_count: 2,
      issues: [{ ...makeIssues()[0], note }],
    }));
    const wrapper = await mountWithPage(makeIssues(), "required", adminEmployee);
    await wrapper.find('mark[data-testid="wiki-review-highlight"]').trigger("click");
    await flushPromises();

    const noteInput = document.querySelector('[data-testid="wiki-review-note-input"]') as HTMLTextAreaElement | null;
    expect(noteInput).not.toBeNull();
    noteInput!.value = "Aufstieg wurde korrigiert, bitte neu prüfen";
    noteInput!.dispatchEvent(new Event("input"));
    await flushPromises();

    const reopenBtn = document.querySelector('[data-testid="wiki-review-reopen"]') as HTMLButtonElement | null;
    reopenBtn!.click();
    await flushPromises();
    await flushPromises();

    expect(updateWikiReviewStateMock).toHaveBeenCalledWith(
      PAGE_PATH,
      "qi-1",
      "reopen",
      "Aufstieg wurde korrigiert, bitte neu prüfen",
    );
    wrapper.unmount();
  });

  it("clears the banner once every issue is resolved", async () => {
    updateWikiReviewStateMock.mockResolvedValue({
      path: PAGE_PATH,
      review: "clear",
      review_count: 0,
      issues: [],
    });
    const wrapper = await mountWithPage(makeIssues(), "required", adminEmployee);
    await wrapper.find('mark[data-testid="wiki-review-highlight"]').trigger("click");
    await flushPromises();
    (document.querySelector('[data-testid="wiki-review-resolve"]') as HTMLButtonElement)!.click();
    await flushPromises();
    await flushPromises();

    expect(updateWikiReviewStateMock).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="wiki-review-banner"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="wiki-content"]').findAll("mark.wiki-review-highlight")).toHaveLength(0);
    wrapper.unmount();
  });

  it("renders neither banner nor annotations when the page has no review data", async () => {
    getWikiTreeMock.mockResolvedValue(tree);
    readWikiPageMock.mockResolvedValue("# Clean page\n\nAll good here.");
    getWikiReviewStateMock.mockRejectedValue(new Error("404"));
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/wiki", component: WikiView }],
    });
    await router.push({ path: "/wiki", query: { path: "wiki/hiking/clean.md" } });
    await router.isReady();
    const wrapper = mount(WikiView, { global: { plugins: [createPinia(), TDesign, router] } });
    await flushPromises();
    await flushPromises();

    expect(wrapper.find('[data-testid="wiki-review-banner"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="wiki-content"]').findAll("mark.wiki-review-highlight")).toHaveLength(0);
    wrapper.unmount();
  });
});
