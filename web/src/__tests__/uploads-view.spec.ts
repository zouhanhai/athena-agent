import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import App from "@/App.vue";
import router from "@/router";
import { useChatStore } from "@/stores/chat";
import {
  getGraph,
  getGraphTopics,
  getTask,
  ingestFile,
  ingestUrl,
  retryTask,
} from "@/api/kb";
import { nextTick } from "vue";

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

beforeEach(() => {
  localStorage.clear();
  getGraphMock.mockResolvedValue({ nodes: [], edges: [] });
  getGraphTopicsMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  getGraphMock.mockReset();
  getGraphTopicsMock.mockReset();
  ingestFileMock.mockReset();
  ingestUrlMock.mockReset();
  getTaskMock.mockReset();
  retryTaskMock.mockReset();
});

async function waitForRoute(path: string) {
  for (let i = 0; i < 100; i++) {
    if (router.currentRoute.value.path === path) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`route did not become "${path}"`);
}

async function mountApp() {
  const wrapper = mount(App, {
    global: {
      plugins: [createPinia(), TDesign, router],
    },
    attachTo: document.body,
  });
  await router.isReady();
  await router.push("/uploads");
  await waitForRoute("/uploads");
  await flushPromises();
  return wrapper;
}

type AppWrapper = Awaited<ReturnType<typeof mountApp>>;

function navItemByText(wrapper: AppWrapper, label: string) {
  return wrapper
    .findAll(".t-menu__item")
    .find((item) => item.text().includes(label));
}

function makeSteps(stage: "parsing" | "refinement" | "ingesting_neo4j" | "ingesting_llmwiki", status: string) {
  const names: Record<string, string[]> = {
    parsing: ["read_file", "parse_ocr_image_desc"],
    refinement: ["refine_document"],
    ingesting_neo4j: ["embed_store"],
    ingesting_llmwiki: ["write_page", "rebuild_index"],
  };
  return (names[stage] ?? []).map((name) => ({ name, status }));
}

function makeTask(overrides: Record<string, unknown> = {}) {
  const base = {
    id: "t-1",
    source: "doc.pdf",
    status: "ingesting",
    progress: 72,
    stages: {
      parsing: { name: "parsing", status: "done", steps: makeSteps("parsing", "done") },
      refinement: { name: "refinement", status: "done", steps: makeSteps("refinement", "done") },
      ingesting_neo4j: { name: "ingesting_neo4j", status: "done", steps: makeSteps("ingesting_neo4j", "done") },
      ingesting_llmwiki: { name: "ingesting_llmwiki", status: "running", steps: makeSteps("ingesting_llmwiki", "pending") },
    },
  };
  return { ...base, ...overrides };
}

async function submitFile(wrapper: AppWrapper, name = "doc.pdf") {
  const file = new File(["# doc"], name, { type: "application/pdf" });
  const input = wrapper.find('input[type="file"]');
  Object.defineProperty(input.element, "files", {
    value: [file],
    configurable: true,
  });
  await input.trigger("change");
  await flushPromises();
  await flushPromises();
}

describe("uploads page", () => {
  it("renders an Uploads nav item in the sidebar", async () => {
    const wrapper = await mountApp();
    expect(navItemByText(wrapper, "Uploads")).toBeDefined();
    wrapper.unmount();
  });

  it("navigates to /uploads when the Uploads item is clicked", async () => {
    const wrapper = await mountApp();
    await router.push("/knowledge");
    await waitForRoute("/knowledge");
    await flushPromises();
    await navItemByText(wrapper, "Uploads")!.trigger("click");
    await waitForRoute("/uploads");
    await flushPromises();
    expect(wrapper.find(".uploads-view").exists()).toBe(true);
    wrapper.unmount();
  });

  it("renders the upload area (drop zone, file select and URL row)", async () => {
    const wrapper = await mountApp();
    expect(wrapper.find(".uploads-view").exists()).toBe(true);
    expect(wrapper.find(".drop-zone").exists()).toBe(true);
    expect(wrapper.find('input[type="file"]').exists()).toBe(true);
    expect(wrapper.find(".url-row").exists()).toBe(true);
    wrapper.unmount();
  });

  it("uses a hyphen, not an em-dash, in the URL placeholder (anti-slop §9.G)", async () => {
    const wrapper = await mountApp();
    const placeholder = wrapper.find(".url-row input").attributes("placeholder") ?? "";
    expect(placeholder).not.toContain("—");
    expect(placeholder).toContain("paste a URL to ingest");
    wrapper.unmount();
  });

  it("submits a selected file and shows a task entry with progress", async () => {
    ingestFileMock.mockResolvedValue("t-1");
    getTaskMock.mockResolvedValue(makeTask({ status: "done", progress: 100 }));
    const wrapper = await mountApp();

    await submitFile(wrapper);

    expect(ingestFileMock).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain("doc.pdf");
    expect(wrapper.find(".task-badge.done").exists()).toBe(true);
    const progress = wrapper.findComponent({ name: "TProgress" });
    expect(progress.exists()).toBe(true);
    expect(progress.props("percentage")).toBe(100);
    wrapper.unmount();
  });

  it("submits a URL and shows a task entry", async () => {
    ingestUrlMock.mockResolvedValue("t-url");
    getTaskMock.mockResolvedValue(makeTask({ id: "t-url" }));
    const wrapper = await mountApp();

    const urlInput = wrapper.find(".url-row input");
    await urlInput.setValue("https://example.com/page");
    const buttons = wrapper.findAll("button");
    const ingestBtn = buttons.find((b) => b.text().includes("Ingest URL"));
    await ingestBtn!.trigger("click");
    await flushPromises();

    expect(ingestUrlMock).toHaveBeenCalledWith("https://example.com/page");
    expect(wrapper.text()).toContain("example.com/page");
    wrapper.unmount();
  });

  it("shows the per-system stages (Parse / Neo4j / llm_wiki) on the task card", async () => {
    ingestFileMock.mockResolvedValue("t-1");
    getTaskMock.mockResolvedValue(makeTask());
    const wrapper = await mountApp();

    await submitFile(wrapper);

    expect(wrapper.text()).toContain("Parse: done");
    expect(wrapper.text()).toContain("Neo4j (RAG): done");
    expect(wrapper.text()).toContain("llm_wiki: running");
    wrapper.unmount();
  });

  it("renders the per-system sub-steps (docling/refinement/neo4j/llm_wiki) with statuses", async () => {
    ingestFileMock.mockResolvedValue("t-1");
    getTaskMock.mockResolvedValue(
      makeTask({
        stages: {
          parsing: {
            name: "parsing",
            status: "running",
            steps: [
              { name: "read_file", status: "done" },
              { name: "parse_ocr_image_desc", status: "running" },
            ],
          },
          refinement: {
            name: "refinement",
            status: "running",
            steps: [{ name: "refine_document", status: "running" }],
          },
          ingesting_neo4j: {
            name: "ingesting_neo4j",
            status: "failed",
            error: "timeout",
            steps: [
              { name: "embed_store", status: "failed", error: "timeout" },
            ],
          },
          ingesting_llmwiki: {
            name: "ingesting_llmwiki",
            status: "pending",
            steps: [
              { name: "write_page", status: "pending" },
              { name: "rebuild_index", status: "pending" },
            ],
          },
        },
      }),
    );
    const wrapper = await mountApp();

    await submitFile(wrapper);

    // docling sub-steps
    expect(wrapper.text()).toContain("read file");
    expect(wrapper.text()).toContain("parse ocr image desc");
    // refinement sub-step (G4.S1.T4)
    expect(wrapper.text()).toContain("Refine (Athena): running");
    expect(wrapper.text()).toContain("refine document");
    // Neo4j sub-step
    expect(wrapper.text()).toContain("embed store");
    // llm_wiki sub-steps (classify folded into refinement)
    expect(wrapper.text()).not.toContain("classify");
    expect(wrapper.text()).toContain("write page");
    expect(wrapper.text()).toContain("rebuild index");
    // failed step error is surfaced as a tooltip title on the step name
    const failedStep = wrapper.find(".task-step.failed .task-step-name");
    expect(failedStep.exists()).toBe(true);
    expect(failedStep.attributes("title")).toBe("timeout");
    wrapper.unmount();
  });

  it("flags a task with quality.action=review_required for operator review (G4.S1.T5)", async () => {
    ingestFileMock.mockResolvedValue("t-1");
    getTaskMock.mockResolvedValue(
      makeTask({
        status: "done",
        progress: 100,
        reviewRequired: true,
        refinement: {
          md_ref: "storage/doc.md",
          frontmatter: { type: "report", topic: "sap/consolidation/group-reporting" },
          quality: {
            complete: false,
            confidence: 0.4,
            issues: ["table on p3 split"],
            action: "review_required",
          },
        },
      }),
    );
    const wrapper = await mountApp();

    await submitFile(wrapper);

    expect(wrapper.find(".task-review-badge").exists()).toBe(true);
    expect(wrapper.text()).toContain("review required");
    wrapper.unmount();
  });

  it("does NOT show the review badge for a clean auto_accept refinement (G4.S1.T5)", async () => {
    ingestFileMock.mockResolvedValue("t-1");
    getTaskMock.mockResolvedValue(
      makeTask({
        status: "done",
        progress: 100,
        refinement: {
          md_ref: "storage/doc.md",
          frontmatter: { type: "event", topic: "internal/events" },
          quality: { complete: true, confidence: 0.95, issues: [], action: "auto_accept" },
        },
      }),
    );
    const wrapper = await mountApp();

    await submitFile(wrapper);

    expect(wrapper.find(".task-review-badge").exists()).toBe(false);
    expect(wrapper.text()).toContain("Accepted");
    wrapper.unmount();
  });

  it("shows a Retry button when a stage failed and re-runs it", async () => {
    ingestFileMock.mockResolvedValue("t-1");
    getTaskMock
      .mockResolvedValueOnce(
        makeTask({
          status: "done",
          progress: 100,
          stages: {
            parsing: { name: "parsing", status: "done" },
            refinement: { name: "refinement", status: "done" },
            ingesting_neo4j: { name: "ingesting_neo4j", status: "failed", error: "timeout" },
            ingesting_llmwiki: { name: "ingesting_llmwiki", status: "done" },
          },
        }),
      )
      .mockResolvedValue(
        makeTask({
          status: "ingesting",
          progress: 50,
          stages: {
            parsing: { name: "parsing", status: "done" },
            refinement: { name: "refinement", status: "done" },
            ingesting_neo4j: { name: "ingesting_neo4j", status: "running" },
            ingesting_llmwiki: { name: "ingesting_llmwiki", status: "done" },
          },
        }),
      );
    retryTaskMock.mockResolvedValue(
      makeTask({
        status: "ingesting",
        progress: 50,
        stages: {
          parsing: { name: "parsing", status: "done" },
          refinement: { name: "refinement", status: "done" },
          ingesting_neo4j: { name: "ingesting_neo4j", status: "running" },
          ingesting_llmwiki: { name: "ingesting_llmwiki", status: "done" },
        },
      }),
    );
    const wrapper = await mountApp();

    await submitFile(wrapper);

    const buttons = wrapper.findAll("button");
    const retryBtn = buttons.find((b) => b.text().includes("Retry"));
    expect(retryBtn).toBeDefined();
    expect(wrapper.text()).toContain("Neo4j (RAG): failed");

    await retryBtn!.trigger("click");
    await flushPromises();
    await flushPromises();

    expect(retryTaskMock).toHaveBeenCalledWith("t-1");
    expect(wrapper.text()).toContain("Neo4j (RAG): running");
    wrapper.unmount();
  });

  it("shows Neo4j chunk progress X / Y chunks with an ETA while running (G4.S3.T8)", async () => {
    vi.useFakeTimers();
    ingestFileMock.mockResolvedValue("t-1");
    const runningStage = (stored: number) => ({
      name: "ingesting_neo4j",
      status: "running",
      chunksStored: stored,
      chunksTotal: 20,
    });
    getTaskMock
      .mockResolvedValueOnce(
        makeTask({
          status: "ingesting",
          progress: 50,
          stages: {
            parsing: { name: "parsing", status: "done" },
            refinement: { name: "refinement", status: "done" },
            ingesting_neo4j: runningStage(2),
            ingesting_llmwiki: { name: "ingesting_llmwiki", status: "pending" },
          },
        }),
      )
      .mockResolvedValue(
        makeTask({
          status: "ingesting",
          progress: 50,
          stages: {
            parsing: { name: "parsing", status: "done" },
            refinement: { name: "refinement", status: "done" },
            ingesting_neo4j: runningStage(6),
            ingesting_llmwiki: { name: "ingesting_llmwiki", status: "pending" },
          },
        }),
      );
    const wrapper = await mountApp();
    await submitFile(wrapper);

    // second poll (interval) → rate sample → ETA
    await vi.advanceTimersByTimeAsync(1500);
    await flushPromises();
    await nextTick();

    expect(wrapper.text()).toContain("6 / 20 chunks");
    expect(wrapper.text()).toContain("ETA");
    wrapper.unmount();
  });

  it("shows the total chunk count once the Neo4j (RAG) stage completes (G4.S3.T8)", async () => {
    ingestFileMock.mockResolvedValue("t-1");
    getTaskMock.mockResolvedValue(
      makeTask({
        status: "done",
        progress: 100,
        stages: {
          parsing: { name: "parsing", status: "done" },
          refinement: { name: "refinement", status: "done" },
          ingesting_neo4j: {
            name: "ingesting_neo4j",
            status: "done",
            chunksStored: 20,
            chunksTotal: 20,
          },
          ingesting_llmwiki: { name: "ingesting_llmwiki", status: "done" },
        },
      }),
    );
    const wrapper = await mountApp();
    await submitFile(wrapper);

    expect(wrapper.text()).toContain("Neo4j (RAG): done");
    expect(wrapper.text()).toContain("20 chunks");
    wrapper.unmount();
  });

  it("keeps the global chat panel mounted on the uploads page", async () => {
    const wrapper = await mountApp();
    expect(wrapper.find(".global-chat-panel").exists()).toBe(true);
    expect(wrapper.find(".global-chat-panel .chat-composer").exists()).toBe(true);
    wrapper.unmount();
  });

  it("tracks /uploads as the chat page context", async () => {
    const wrapper = await mountApp();
    const chat = useChatStore();
    expect(chat.page).toBe("/uploads");
    expect(wrapper.find(".global-chat-panel").exists()).toBe(true);
    wrapper.unmount();
  });
});
