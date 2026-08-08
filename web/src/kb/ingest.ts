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
  dedup?: IngestTask["dedup"];
  nearDuplicate?: string;
  stages: IngestTask["stages"];
}

/** Optimistic per-system stages with pending sub-steps (G3.S5.T2), shown while
 *  the first poll replaces them with the live backend state. */
export function initialStages(): IngestTask["stages"] {
  return {
    parsing: {
      name: "parsing",
      status: "pending",
      steps: [
        { name: "read_file", status: "pending" },
        { name: "parse_ocr_image_desc", status: "pending" },
      ],
    },
    ingesting_lightrag: {
      name: "ingesting_lightrag",
      status: "pending",
      steps: [
        { name: "chunking", status: "pending" },
        { name: "entity_extraction", status: "pending" },
        { name: "graph_build", status: "pending" },
        { name: "embedding", status: "pending" },
      ],
    },
    ingesting_llmwiki: {
      name: "ingesting_llmwiki",
      status: "pending",
      steps: [
        { name: "classify", status: "pending" },
        { name: "write_page", status: "pending" },
        { name: "rebuild_index", status: "pending" },
      ],
    },
  };
}

export interface UseIngestTasksOptions {
  /** Poll interval in ms. Injectable for tests. Default: 1500. */
  pollIntervalMs?: number;
}

/** localStorage key for persisting active task ids so the task list survives
 *  page reloads (F5). Only task ids + source labels are persisted; the live
 *  status is re-fetched from GET /api/kb/task/:id on load. */
const STORAGE_KEY = "athena:kb-tasks";

interface StoredTaskMeta {
  id: string;
  source: string;
  kind: "file" | "url";
}

function loadStoredTasks(): StoredTaskMeta[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredTaskMeta[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistStoredTasks(metas: StoredTaskMeta[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(metas));
  } catch {
    /* storage unavailable — task list is session-only */
  }
}

export function useIngestTasks(options: UseIngestTasksOptions = {}) {
  const pollIntervalMs = options.pollIntervalMs ?? 1500;
  const tasks = ref<IngestTaskItem[]>([]);
  const submitting = ref(false);
  const submitError = ref("");
  const timers = new Map<string, ReturnType<typeof setInterval>>();
  /** Metadata of persisted tasks, mirroring `tasks` for localStorage recovery. */
  const storedMetas = ref<StoredTaskMeta[]>(loadStoredTasks());

  function persist(): void {
    persistStoredTasks(storedMetas.value);
  }

  function rememberTask(meta: StoredTaskMeta): void {
    if (storedMetas.value.some((m) => m.id === meta.id)) return;
    storedMetas.value.push(meta);
    persist();
  }

  function forgetTask(taskId: string): void {
    storedMetas.value = storedMetas.value.filter((m) => m.id !== taskId);
    persist();
  }

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
      dedup: updated.dedup,
      nearDuplicate: updated.nearDuplicate,
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
      const meta: StoredTaskMeta = { id: taskId, source: file.name, kind: "file" };
      rememberTask(meta);
      tasks.value.push({
        id: taskId,
        source: file.name,
        kind: "file",
        status: "pending",
        progress: 0,
        stages: initialStages(),
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
      const meta: StoredTaskMeta = { id: taskId, source: url, kind: "url" };
      rememberTask(meta);
      tasks.value.push({
        id: taskId,
        source: url,
        kind: "url",
        status: "pending",
        progress: 0,
        stages: initialStages(),
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
    forgetTask(taskId);
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

  /**
   * Restore persisted tasks from localStorage on (re)mount so progress bars
   * survive a page reload (F5). Re-creates a minimal task entry for each stored
   * id and starts polling; the first poll replaces it with the live backend state.
   */
  function restorePersisted(): void {
    for (const meta of storedMetas.value) {
      if (tasks.value.some((t) => t.id === meta.id)) continue;
      tasks.value.push({
        id: meta.id,
        source: meta.source,
        kind: meta.kind,
        status: "pending",
        progress: 0,
        stages: initialStages(),
      });
      startPolling(meta.id);
      void poll(meta.id);
    }
  }

  restorePersisted();

  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      for (const timer of timers.values()) clearInterval(timer);
      timers.clear();
    });
  }

  return { tasks, submitting, submitError, addFile, addUrl, removeTask, retryTask };
}
