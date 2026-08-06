/**
 * useIngestTasks - manages the Knowledge panel "Add Data" ingestion flows
 * (G2.S5.T3). Submits files/URLs to the backend task queue and polls
 * /api/kb/task/:id until each task reaches a terminal state.
 */
import { getCurrentInstance, onBeforeUnmount, ref } from "vue";
import { getTask, ingestFile, ingestUrl, retryTask as retryTaskApi } from "@/api/kb";
import type { IngestTask, TaskStatus } from "@/api/kb";

export interface IngestTaskItem {
  id: string;
  source: string;
  kind: "file" | "url";
  status: TaskStatus;
  progress: number;
  error?: string;
  stages: IngestTask["stages"];
}

export interface UseIngestTasksOptions {
  /** Poll interval in ms. Injectable for tests. Default: 1500. */
  pollIntervalMs?: number;
}

export function useIngestTasks(options: UseIngestTasksOptions = {}) {
  const pollIntervalMs = options.pollIntervalMs ?? 1500;
  const tasks = ref<IngestTaskItem[]>([]);
  const submitting = ref(false);
  const submitError = ref("");
  const timers = new Map<string, ReturnType<typeof setInterval>>();

  function stopPolling(taskId: string): void {
    const timer = timers.get(taskId);
    if (timer) {
      clearInterval(timer);
      timers.delete(taskId);
    }
  }

  function replaceTask(updated: IngestTask): void {
    const existing = tasks.value.find((task) => task.id === updated.id);
    if (!existing) return;
    const merged: IngestTaskItem = {
      ...existing,
      status: updated.status,
      progress: updated.progress,
      error: updated.error,
      stages: updated.stages,
    };
    const index = tasks.value.indexOf(existing);
    tasks.value.splice(index, 1, merged);
    if (updated.status === "done" || updated.status === "failed") {
      stopPolling(updated.id);
    }
  }

  async function poll(taskId: string): Promise<void> {
    try {
      replaceTask(await getTask(taskId));
    } catch {
      // Stop polling on repeated errors; surface as failed later if terminal.
      stopPolling(taskId);
    }
  }

  function startPolling(taskId: string): void {
    if (timers.has(taskId)) return;
    const timer = setInterval(() => void poll(taskId), pollIntervalMs);
    timers.set(taskId, timer);
  }

  async function addFile(file: File): Promise<void> {
    submitting.value = true;
    submitError.value = "";
    try {
      const taskId = await ingestFile(file);
      tasks.value.push({
        id: taskId,
        source: file.name,
        kind: "file",
        status: "pending",
        progress: 0,
        stages: {
          parsing: { name: "parsing", status: "pending" },
          ingesting_lightrag: { name: "ingesting_lightrag", status: "pending" },
          ingesting_llmwiki: { name: "ingesting_llmwiki", status: "pending" },
        },
      });
      startPolling(taskId);
      await poll(taskId);
    } catch (err) {
      submitError.value = err instanceof Error ? err.message : String(err);
    } finally {
      submitting.value = false;
    }
  }

  async function addUrl(url: string): Promise<void> {
    submitting.value = true;
    submitError.value = "";
    try {
      const taskId = await ingestUrl(url);
      tasks.value.push({
        id: taskId,
        source: url,
        kind: "url",
        status: "pending",
        progress: 0,
        stages: {
          parsing: { name: "parsing", status: "pending" },
          ingesting_lightrag: { name: "ingesting_lightrag", status: "pending" },
          ingesting_llmwiki: { name: "ingesting_llmwiki", status: "pending" },
        },
      });
      startPolling(taskId);
      await poll(taskId);
    } catch (err) {
      submitError.value = err instanceof Error ? err.message : String(err);
    } finally {
      submitting.value = false;
    }
  }

  function removeTask(taskId: string): void {
    stopPolling(taskId);
    const index = tasks.value.findIndex((task) => task.id === taskId);
    if (index !== -1) tasks.value.splice(index, 1);
  }

  /**
   * Re-run a failed task's failed stages only. Successful stages are left
   * untouched by the backend; this restarts polling so the UI shows retry
   * progress and the updated final status.
   */
  async function retryTask(taskId: string): Promise<void> {
    submitError.value = "";
    try {
      const updated = await retryTaskApi(taskId);
      replaceTask(updated);
      startPolling(taskId);
      await poll(taskId);
    } catch (err) {
      submitError.value = err instanceof Error ? err.message : String(err);
    }
  }

  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      for (const timer of timers.values()) clearInterval(timer);
      timers.clear();
    });
  }

  return { tasks, submitting, submitError, addFile, addUrl, removeTask, retryTask };
}
