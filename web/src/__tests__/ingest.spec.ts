import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { nextTick } from "vue";

import { useIngestTasks } from "@/kb/ingest";
import { ingestFile, ingestUrl, getTask } from "@/api/kb";

vi.mock("@/api/kb", () => ({
  ingestFile: vi.fn(),
  ingestUrl: vi.fn(),
  getTask: vi.fn(),
}));

const ingestFileMock = ingestFile as unknown as ReturnType<typeof vi.fn>;
const ingestUrlMock = ingestUrl as unknown as ReturnType<typeof vi.fn>;
const getTaskMock = getTask as unknown as ReturnType<typeof vi.fn>;

function task(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    source: "doc.pdf",
    status: "pending",
    progress: 0,
    stages: {
      parsing: { name: "parsing", status: "pending" },
      ingesting_lightrag: { name: "ingesting_lightrag", status: "pending" },
      ingesting_llmwiki: { name: "ingesting_llmwiki", status: "pending" },
    },
    ...patch,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  ingestFileMock.mockReset();
  ingestUrlMock.mockReset();
  getTaskMock.mockReset();
});

describe("useIngestTasks", () => {
  it("tracks a submitted file and applies the first poll result", async () => {
    ingestFileMock.mockResolvedValue("t-1");
    getTaskMock.mockResolvedValue(task("t-1", { status: "done", progress: 100 }));

    const { tasks, addFile } = useIngestTasks();
    await addFile(new File(["x"], "a.pdf"));

    expect(ingestFileMock).toHaveBeenCalledTimes(1);
    expect(tasks.value).toHaveLength(1);
    expect(tasks.value[0]!.source).toBe("a.pdf");
    expect(tasks.value[0]!.status).toBe("done");
    expect(tasks.value[0]!.progress).toBe(100);
  });

  it("polls until the task reaches a terminal state", async () => {
    ingestUrlMock.mockResolvedValue("t-2");
    getTaskMock
      .mockResolvedValueOnce(task("t-2", { status: "ingesting", progress: 50 }))
      .mockResolvedValueOnce(task("t-2", { status: "done", progress: 100 }));

    const { tasks, addUrl } = useIngestTasks();
    await addUrl("https://example.com");

    expect(tasks.value[0]!.status).toBe("ingesting");

    await vi.advanceTimersByTimeAsync(3000);
    await nextTick();

    expect(getTaskMock.mock.calls.length).toBeGreaterThan(1);
    expect(tasks.value[0]!.status).toBe("done");
  });

  it("keeps per-system stage failure visible on the task", async () => {
    ingestFileMock.mockResolvedValue("t-3");
    getTaskMock.mockResolvedValue(
      task("t-3", {
        status: "done",
        progress: 100,
        stages: {
          parsing: { name: "parsing", status: "done" },
          ingesting_lightrag: { name: "ingesting_lightrag", status: "failed", error: "timeout" },
          ingesting_llmwiki: { name: "ingesting_llmwiki", status: "done" },
        },
      }),
    );

    const { tasks, addFile } = useIngestTasks();
    await addFile(new File(["x"], "b.pdf"));

    expect(tasks.value[0]!.stages.ingesting_lightrag.status).toBe("failed");
    expect(tasks.value[0]!.stages.ingesting_lightrag.error).toBe("timeout");
  });

  it("records the submit error when the ingest request fails", async () => {
    ingestFileMock.mockRejectedValue(new Error("upload rejected"));

    const { tasks, submitError, addFile } = useIngestTasks();
    await addFile(new File(["x"], "c.pdf"));

    expect(submitError.value).toContain("upload rejected");
    expect(tasks.value).toHaveLength(0);
  });

  it("removes a task and stops polling it", async () => {
    ingestFileMock.mockResolvedValue("t-4");
    getTaskMock.mockResolvedValue(task("t-4", { status: "ingesting" }));

    const { tasks, addFile, removeTask } = useIngestTasks();
    await addFile(new File(["x"], "d.pdf"));

    removeTask("t-4");
    expect(tasks.value).toHaveLength(0);
  });
});
