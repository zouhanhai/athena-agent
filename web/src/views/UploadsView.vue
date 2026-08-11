<script setup lang="ts">
import { ref } from "vue";
import { useIngestTasks } from "@/kb/ingest";
import type { IngestTaskItem } from "@/kb/ingest";
import type { IngestTaskStage } from "@/api/kb";

const fileInput = ref<HTMLInputElement | null>(null);
const dragging = ref(false);
const urlInput = ref("");
const {
  tasks,
  submitting,
  submitError,
  addFile,
  addUrl,
  removeTask,
  retryTask,
} = useIngestTasks();

const ACCEPT_HINT = "application/pdf,.docx,.xlsx,.pptx,image/*,.html,.epub,.csv,.md,.txt";

function pickFiles(): void {
  fileInput.value?.click();
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  void ingestFiles(files);
}

function onDrop(event: DragEvent): void {
  dragging.value = false;
  const files = Array.from(event.dataTransfer?.files ?? []);
  void ingestFiles(files);
}

async function ingestFiles(files: File[]): Promise<void> {
  for (const file of files) {
    await addFile(file);
  }
}

async function submitUrl(): Promise<void> {
  const url = urlInput.value.trim();
  if (!url) return;
  await addUrl(url);
  urlInput.value = "";
}

function hasFailedStage(task: IngestTaskItem): boolean {
  return (
    task.stages.parsing.status === "failed" ||
    task.stages.refinement.status === "failed" ||
    task.stages.ingesting_llmwiki.status === "failed" ||
    task.stages.ingesting_neo4j.status === "failed"
  );
}

function friendlyError(task: IngestTaskItem): string {
  const raw = task.error ?? "";
  if (/409|already contains|duplicate/i.test(raw)) {
    return "This file already exists in the knowledge base. Delete it in the Wiki panel, then upload again.";
  }
  return raw || "This document could not be fully ingested.";
}

function onRetry(taskId: string): void {
  void retryTask(taskId);
}

function taskProgressStatus(task: IngestTaskItem): "success" | "error" | "active" {
  if (task.status === "failed") return "error";
  if (task.status === "done") return "success";
  return "active";
}

function stageStatus(stage: IngestTaskStage): string {
  return stage.status;
}

function friendlyStep(step: { name: string }): string {
  return step.name.replace(/_/g, " ");
}

/** Refinement summary for a task (G4.S1.T4): "type=topic" + quality action.
 *  Empty when the refinement stage has not produced output yet. */
function refinementText(task: IngestTaskItem): string {
  const fm = task.refinement?.frontmatter;
  const quality = task.refinement?.quality;
  if (!fm) return "";
  const parts = [`${fm.type}${fm.topic ? " / " + fm.topic : ""}`];
  if (quality?.action) parts.push(quality.action === "review_required" ? "review needed" : "accepted");
  return parts.join(" · ");
}

/** Operator-review flag (G4.S1.T5): true when Athena refinement emitted
 *  review_required OR refinement failed and the raw docling output was used. */
function reviewRequired(task: IngestTaskItem): boolean {
  if (task.reviewRequired) return true;
  return task.refinement?.quality?.action === "review_required";
}

/** Human-readable elapsed time since `from` (ms). */
function stepMark(status: string): string {
  switch (status) {
    case "done":
      return "✓";
    case "failed":
      return "✕";
    case "running":
      return "…";
    default:
      return "○";
  }
}
</script>

<template>
  <section class="uploads-view">
    <header class="uploads-header">
      <h2 class="uploads-title">Uploads</h2>
      <span class="uploads-meta">
        Ingest documents for the knowledge base (docling → llm_wiki + Neo4j)
      </span>
    </header>

    <div class="upload-area">
      <div class="upload-area-head">
        <h3 class="upload-area-title">Upload</h3>
        <span class="upload-area-hint">
          PDF · DOCX · XLSX · PPTX · images · HTML · EPUB · CSV · Markdown · URL
        </span>
      </div>

      <div
        class="drop-zone"
        :class="{ dragging }"
        @click="pickFiles"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="onDrop"
      >
        <input
          ref="fileInput"
          type="file"
          multiple
          :accept="ACCEPT_HINT"
          hidden
          @change="onFileChange"
        />
        <span class="drop-zone-main">Drop files here or click to select</span>
        <span class="drop-zone-sub">Every file is parsed by docling → llm_wiki + Neo4j</span>
      </div>

      <div class="url-row">
        <t-input
          v-model="urlInput"
          size="small"
          clearable
          placeholder="https://example.com/page - paste a URL to ingest"
          @enter="submitUrl"
        />
        <t-button
          size="small"
          variant="outline"
          :loading="submitting"
          :disabled="!urlInput.trim()"
          @click="submitUrl"
        >
          Ingest URL
        </t-button>
      </div>

      <p v-if="submitError" class="upload-error">{{ submitError }}</p>
    </div>

    <div class="task-list-wrap">
      <h3 class="task-list-title">Tasks</h3>
      <p v-if="tasks.length === 0" class="task-list-empty">
        No uploads yet. Drop a file or paste a URL above to start ingesting.
      </p>
      <div v-else class="task-list">
        <div v-for="task in tasks" :key="task.id" class="task-item">
          <div class="task-head">
            <span class="task-source" :title="task.source">{{ task.source }}</span>
            <span class="task-badge" :class="task.status">{{ task.status }}</span>
            <span v-if="reviewRequired(task)" class="task-review-badge" title="Athena refinement flagged this document for operator review">
              review required
            </span>
            <div class="task-actions">
              <t-button
                v-if="hasFailedStage(task)"
                size="small"
                variant="outline"
                theme="danger"
                @click="onRetry(task.id)"
              >
                Retry
              </t-button>
              <t-button size="small" variant="text" @click="removeTask(task.id)">
                Remove
              </t-button>
            </div>
          </div>
          <t-progress
            :percentage="task.progress"
            :status="taskProgressStatus(task)"
          />
          <div class="task-stages">
            <div
              v-for="stage in [
                { key: 'parsing' as const, label: 'Parse' },
                { key: 'refinement' as const, label: 'Refine (Athena)' },
                { key: 'ingesting_neo4j' as const, label: 'Neo4j (RAG)' },
                { key: 'ingesting_llmwiki' as const, label: 'llm_wiki' },
              ]"
              :key="stage.key"
              class="task-stage"
              :class="stageStatus(task.stages[stage.key])"
            >
              <span class="task-stage-label">
                {{ stage.label }}: {{ task.stages[stage.key].status }}
              </span>
              <span
                v-if="stage.key === 'refinement' && refinementText(task)"
                class="task-stage-chunk"
              >
                {{ refinementText(task) }}
              </span>
              <ul v-if="task.stages[stage.key].steps?.length" class="task-stage-steps">
                <li
                  v-for="step in task.stages[stage.key].steps"
                  :key="step.name"
                  class="task-step"
                  :class="step.status"
                >
                  <span class="task-step-mark">{{ stepMark(step.status) }}</span>
                  <span class="task-step-name" :title="step.error">{{ friendlyStep(step) }}</span>
                </li>
              </ul>
            </div>
          </div>
          <p v-if="hasFailedStage(task)" class="task-stage-error">{{ friendlyError(task) }}</p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.uploads-view {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 48px);
  height: calc(100dvh - 48px);
  padding: 24px;
  gap: 16px;
  overflow-y: auto;
}

.uploads-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
}

.uploads-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.2px;
  color: var(--caleo-text);
}

.uploads-meta {
  font-size: 13px;
  color: var(--caleo-text-secondary);
}

.upload-area {
  padding: 16px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  box-shadow: var(--caleo-shadow);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.upload-area-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.upload-area-title {
  margin: 0;
  font-size: 15px;
  color: var(--caleo-text);
}

.upload-area-hint {
  font-size: 12px;
  color: var(--caleo-text-secondary);
}

.drop-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 20px;
  border: 1px dashed var(--caleo-border);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.drop-zone:hover,
.drop-zone.dragging {
  border-color: var(--caleo-primary);
  background: var(--caleo-surface-hover);
}

.drop-zone-main {
  font-size: 14px;
  font-weight: 600;
  color: var(--caleo-text);
}

.drop-zone-sub {
  font-size: 12px;
  color: var(--caleo-text-secondary);
}

.url-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.url-row :deep(.t-input) {
  flex: 1;
}

.upload-error {
  margin: 0;
  color: var(--caleo-error);
  font-size: 13px;
}

.task-list-wrap {
  flex: 1;
  min-height: 0;
  padding: 16px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  box-shadow: var(--caleo-shadow);
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
}

.task-list-title {
  margin: 0;
  font-size: 15px;
  color: var(--caleo-text);
}

.task-list-empty {
  margin: 0;
  font-size: 13px;
  color: var(--caleo-text-secondary);
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.task-item {
  padding: 12px;
  border-radius: 8px;
  background: var(--caleo-surface-hover);
  border: 1px solid var(--caleo-border);
}

.task-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.task-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.task-source {
  font-size: 13px;
  color: var(--caleo-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.task-badge {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

.task-badge.pending {
  color: var(--caleo-text-secondary);
  background: var(--caleo-surface-hover);
}

.task-badge.parsing,
.task-badge.refining,
.task-badge.ingesting {
  color: var(--caleo-primary);
  background: var(--caleo-sidebar-active);
}

.task-badge.done {
  color: var(--caleo-success);
  background: rgba(47, 158, 99, 0.14);
}

.task-badge.failed {
  color: var(--caleo-error);
  background: rgba(213, 73, 65, 0.14);
}

.task-review-badge {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--caleo-warning, #b5851d);
  background: rgba(217, 155, 32, 0.14);
  border: 1px solid rgba(217, 155, 32, 0.35);
}

.task-stages {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.task-stage {
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 11px;
  border: 1px solid var(--caleo-border);
  color: var(--caleo-text-secondary);
  background: var(--caleo-surface);
}

.task-stage-label {
  font-weight: 600;
}

.task-stage-chunk {
  margin-left: 6px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: var(--caleo-primary);
}

.task-stage-steps {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.task-step {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
}

.task-step-mark {
  flex-shrink: 0;
  width: 10px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  color: var(--caleo-text-secondary);
}

.task-step-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-step.running .task-step-mark {
  color: var(--caleo-primary);
}

.task-step.done .task-step-mark {
  color: var(--caleo-success);
}

.task-step.failed .task-step-mark {
  color: var(--caleo-error);
}

.task-stage.running {
  color: var(--caleo-primary);
  border-color: var(--caleo-primary);
}

.task-stage.done {
  color: var(--caleo-success);
  border-color: rgba(47, 158, 99, 0.5);
}

.task-stage.failed {
  color: var(--caleo-error);
  border-color: rgba(213, 73, 65, 0.5);
}

.task-stage-error {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--caleo-error);
}
</style>
