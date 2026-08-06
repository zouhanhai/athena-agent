import { describe, expect, it, vi, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import KnowledgeView from "@/views/KnowledgeView.vue";
import { getGraph, getGraphTopics, getTask, ingestFile, ingestUrl, retryTask } from "@/api/kb";

vi.mock("@/api/kb", () => ({
  getGraph: vi.fn(),
  getGraphTopics: vi.fn(),
  getWikiTree: vi.fn(),
  readWikiPage: vi.fn(),
  searchKnowledge: vi.fn(),
  ingestFile: vi.fn(),
  ingestUrl: vi.fn(),
  getTask: vi.fn(),
  retryTask: vi.fn(),
}));

const getGraphMock = getGraph as unknown as ReturnType<typeof vi.fn>;
const getGraphTopicsMock = getGraphTopics as unknown as ReturnType<typeof vi.fn>;
const ingestFileMock = ingestFile as unknown as ReturnType<typeof vi.fn>;
const ingestUrlMock = ingestUrl as unknown as ReturnType<typeof vi.fn>;
const getTaskMock = getTask as unknown as ReturnType<typeof vi.fn>;
const retryTaskMock = retryTask as unknown as ReturnType<typeof vi.fn>;

async function mountView() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/knowledge", component: KnowledgeView },
      { path: "/wiki", component: { template: "<div />" } },
    ],
  });
  await router.push("/knowledge");
  await router.isReady();
  const wrapper = mount(KnowledgeView, {
    global: {
      plugins: [createPinia(), TDesign, router],
      stubs: { VNetworkGraph: { template: "<div class='graph-stub' />" } },
    },
  });
  await flushPromises();
  return { wrapper, router };
}

type TaskPatch = {
  id?: string;
  source?: string;
  status?: string;
  progress?: number;
  error?: string;
  dedup?: {
    duplicate: boolean;
    method?: "hash" | "chunks";
    existingSource?: string;
  };
  nearDuplicate?: string;
  stages?: Record<string, unknown>;
};

function makeTask(overrides: TaskPatch = {}) {
  const base = {
    id: "t-1",
    source: "doc.pdf",
    status: "ingesting",
    progress: 72,
    error: undefined,
    stages: {
      parsing: { name: "parsing", status: "done" },
      ingesting_lightrag: { name: "ingesting_lightrag", status: "done" },
      ingesting_llmwiki: { name: "ingesting_llmwiki", status: "running" },
    },
  };
  return { ...base, ...overrides };
}

afterEach(() => {
  getGraphMock.mockReset();
  getGraphTopicsMock.mockReset();
  ingestFileMock.mockReset();
  ingestUrlMock.mockReset();
  getTaskMock.mockReset();
  retryTaskMock.mockReset();
});

beforeEach(() => {
  localStorage.clear();
});

describe("KnowledgeView Add Data", () => {
  it("submits a selected file and shows a task entry with progress", async () => {
    getGraphMock.mockResolvedValue({ nodes: [], edges: [] });
    getTaskMock.mockResolvedValue(makeTask({ status: "done", progress: 100 }));
    ingestFileMock.mockResolvedValue("t-1");
    const { wrapper } = await mountView();

    const file = new File(["# doc"], "doc.pdf", { type: "application/pdf" });
    const input = wrapper.find('input[type="file"]');
    Object.defineProperty(input.element, "files", {
      value: [file],
      configurable: true,
    });
    await input.trigger("change");
    await flushPromises();
    await flushPromises();

    expect(ingestFileMock).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain("doc.pdf");
    expect(wrapper.find(".task-badge.done").exists()).toBe(true);
    const progress = wrapper.findComponent({ name: "TProgress" });
    expect(progress.exists()).toBe(true);
    expect(progress.props("percentage")).toBe(100);
    expect(wrapper.text()).toContain("Parse: done");
    expect(wrapper.text()).toContain("LightRAG: done");
    wrapper.unmount();
  });

  it("submits a URL and shows a task entry", async () => {
    getGraphMock.mockResolvedValue({ nodes: [], edges: [] });
    getTaskMock.mockResolvedValue(makeTask({ id: "t-url" }));
    ingestUrlMock.mockResolvedValue("t-url");
    const { wrapper } = await mountView();

    const urlInput = wrapper.find(".url-row input");
    await urlInput.setValue("https://example.com/page");
    const buttons = wrapper.findAll("button");
    const ingestBtn = buttons.find((b) => b.text().includes("Ingest URL"));
    await ingestBtn!.trigger("click");
    await flushPromises();

    expect(ingestUrlMock).toHaveBeenCalledWith("https://example.com/page");
    expect(wrapper.text()).toContain("example.com/page");
    expect(wrapper.text()).toContain("Parse: done");
    expect(wrapper.text()).toContain("LightRAG: done");
    wrapper.unmount();
  });

  it("disables the Ingest URL button until a URL is entered", async () => {
    getGraphMock.mockResolvedValue({ nodes: [], edges: [] });
    const { wrapper } = await mountView();

    const buttons = wrapper.findAll("button");
    const ingestBtn = buttons.find((b) => b.text().includes("Ingest URL"));
    expect(ingestBtn!.attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("shows the drop-zone format hints", async () => {
    getGraphMock.mockResolvedValue({ nodes: [], edges: [] });
    const { wrapper } = await mountView();

    expect(wrapper.find(".add-data-panel").exists()).toBe(true);
    expect(wrapper.text()).toContain("PDF · DOCX · XLSX");
    expect(wrapper.find(".drop-zone").exists()).toBe(true);
    wrapper.unmount();
  });

  it("shows a friendly dedup notice when the task was skipped as duplicate content", async () => {
    getGraphMock.mockResolvedValue({ nodes: [], edges: [] });
    getTaskMock.mockResolvedValue(
      makeTask({
        id: "t-dup",
        status: "done",
        progress: 100,
        dedup: {
          duplicate: true,
          method: "hash",
          existingSource: "wiki/sommerseminar/a.md",
        },
      }),
    );
    ingestFileMock.mockResolvedValue("t-dup");
    const { wrapper } = await mountView();

    const file = new File(["# doc"], "same.pdf", { type: "application/pdf" });
    const input = wrapper.find('input[type="file"]');
    Object.defineProperty(input.element, "files", {
      value: [file],
      configurable: true,
    });
    await input.trigger("change");
    await flushPromises();
    await flushPromises();

    const notice = wrapper.find(".task-dedup");
    expect(notice.exists()).toBe(true);
    expect(notice.text()).toContain("Duplicate content");
    expect(notice.text()).toContain("wiki/sommerseminar/a.md");
    wrapper.unmount();
  });

  it("shows a semantic near-duplicate notice when LightRAG flags a similar doc", async () => {
    getGraphMock.mockResolvedValue({ nodes: [], edges: [] });
    getTaskMock.mockResolvedValue(
      makeTask({
        id: "t-near",
        status: "done",
        progress: 100,
        nearDuplicate: "wiki/sommerseminar/sommerseminar-l-sen.md",
      }),
    );
    ingestFileMock.mockResolvedValue("t-near");
    const { wrapper } = await mountView();

    const file = new File(["# doc"], "near.pdf", { type: "application/pdf" });
    const input = wrapper.find('input[type="file"]');
    Object.defineProperty(input.element, "files", {
      value: [file],
      configurable: true,
    });
    await input.trigger("change");
    await flushPromises();
    await flushPromises();

    const notice = wrapper.find(".task-near-dup");
    expect(notice.exists()).toBe(true);
    expect(notice.text()).toContain("may be similar to");
    expect(notice.text()).toContain("sommerseminar-l-sen.md");
    wrapper.unmount();
  });

  it("hides the Add Data panel when toggled off", async () => {
    getGraphMock.mockResolvedValue({ nodes: [], edges: [] });
    const { wrapper } = await mountView();

    const toggleBtn = wrapper
      .findAll("button")
      .find((b) => b.text().includes("Hide Data Input"));
    await toggleBtn!.trigger("click");
    await flushPromises();

    expect(wrapper.find(".add-data-panel").exists()).toBe(false);
    expect(wrapper.text()).toContain("Add Data");
    wrapper.unmount();
  });

  it("shows a Retry button next to Remove when a stage failed and re-runs it", async () => {
    getGraphMock.mockResolvedValue({ nodes: [], edges: [] });
    const failed = makeTask({
      status: "done",
      progress: 100,
      stages: {
        parsing: { name: "parsing", status: "done" },
        ingesting_lightrag: { name: "ingesting_lightrag", status: "failed", error: "timeout" },
        ingesting_llmwiki: { name: "ingesting_llmwiki", status: "done" },
      },
    });
    const running = makeTask({
      status: "ingesting",
      progress: 50,
      stages: {
        parsing: { name: "parsing", status: "done" },
        ingesting_lightrag: { name: "ingesting_lightrag", status: "running" },
        ingesting_llmwiki: { name: "ingesting_llmwiki", status: "done" },
      },
    });
    getTaskMock
      .mockResolvedValueOnce(failed)
      .mockResolvedValue(running);
    ingestFileMock.mockResolvedValue("t-1");
    retryTaskMock.mockResolvedValue(running);
    const { wrapper } = await mountView();

    const file = new File(["# doc"], "doc.pdf", { type: "application/pdf" });
    const input = wrapper.find('input[type="file"]');
    Object.defineProperty(input.element, "files", {
      value: [file],
      configurable: true,
    });
    await input.trigger("change");
    await flushPromises();
    await flushPromises();

    const buttons = wrapper.findAll("button");
    const retryBtn = buttons.find((b) => b.text().includes("Retry"));
    expect(retryBtn).toBeDefined();
    expect(wrapper.text()).toContain("LightRAG: failed");

    await retryBtn!.trigger("click");
    await flushPromises();
    await flushPromises();

    expect(retryTaskMock).toHaveBeenCalledWith("t-1");
    expect(wrapper.text()).toContain("LightRAG: running");
    wrapper.unmount();
  });

  it("does not show a Retry button when all stages are done", async () => {
    getGraphMock.mockResolvedValue({ nodes: [], edges: [] });
    getTaskMock.mockResolvedValue(makeTask({ status: "done", progress: 100 }));
    ingestFileMock.mockResolvedValue("t-1");
    const { wrapper } = await mountView();

    const file = new File(["# doc"], "doc.pdf", { type: "application/pdf" });
    const input = wrapper.find('input[type="file"]');
    Object.defineProperty(input.element, "files", {
      value: [file],
      configurable: true,
    });
    await input.trigger("change");
    await flushPromises();
    await flushPromises();

    const buttons = wrapper.findAll("button");
    expect(buttons.find((b) => b.text().includes("Retry"))).toBeUndefined();
    wrapper.unmount();
  });
});
