<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { useRouter } from "vue-router";
import { VNetworkGraph } from "v-network-graph";
import { ForceLayout } from "v-network-graph/lib/force-layout";
import type { UserConfigs } from "v-network-graph";
import "v-network-graph/lib/style.css";

import { getGraph, getGraphTopics, searchKnowledge } from "@/api/kb";
import type { KnowledgeGraph, KnowledgeSearchResult, IngestTaskStage } from "@/api/kb";
import { buildTypeColors, mapKnowledgeGraph, nodeRelations } from "@/kb/graph";
import { useIngestTasks } from "@/kb/ingest";
import type { IngestTaskItem } from "@/kb/ingest";
import { caleoPalette } from "@/theme";
import { useThemeStore } from "@/stores/theme";

const theme = useThemeStore();
const { mode } = storeToRefs(theme);
const router = useRouter();

const graph = ref<KnowledgeGraph>({ nodes: [], edges: [] });
const loading = ref(true);
const error = ref("");
const selectedNodeId = ref<string | null>(null);

const topics = ref<string[]>([]);
const selectedTopic = ref("");
const topicLoading = ref(false);
const totalNodes = ref(0);

const searchQuery = ref("");
const searching = ref(false);
const searchResults = ref<KnowledgeSearchResult[]>([]);
const searchError = ref("");
const searchActive = ref(false);

const showAddData = ref(true);
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

function stageStatus(stage: IngestTaskStage): string {
  return stage.status;
}

function hasFailedStage(task: IngestTaskItem): boolean {
  return (
    task.stages.parsing.status === "failed" ||
    task.stages.ingesting_lightrag.status === "failed" ||
    task.stages.ingesting_llmwiki.status === "failed"
  );
}

/**
 * Map a raw task/stage error to a human-friendly message. Duplicate-name uploads
 * hit a LightRAG 409 ("already contains ..."). Surface that clearly so the user
 * knows to delete the existing document first.
 */
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
  if (task.progress > 0) return "active";
  return "active";
}

async function runSearch() {
  const query = searchQuery.value.trim();
  if (!query) return;
  searchActive.value = true;
  searching.value = true;
  searchError.value = "";
  try {
    searchResults.value = await searchKnowledge(query);
  } catch (err) {
    searchError.value = err instanceof Error ? err.message : String(err);
    searchResults.value = [];
  } finally {
    searching.value = false;
  }
}

function clearSearch() {
  searchActive.value = false;
  searchQuery.value = "";
  searchResults.value = [];
  searchError.value = "";
}

function onResultClick(result: KnowledgeSearchResult) {
  if (result.source === "llmwiki" && result.path) {
    void router.push({ path: "/wiki", query: { path: result.path } });
  }
}

function resolveColor(varName: string, fallback: string): string {
  if (typeof document !== "undefined") {
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue(varName)
      .trim();
    if (value) return value;
  }
  return fallback;
}

const colors = computed(() => {
  void mode.value;
  const palette = [
    resolveColor("--caleo-primary", caleoPalette.primary),
    resolveColor("--caleo-sky", caleoPalette.sky),
    resolveColor("--caleo-dark", caleoPalette.dark),
    resolveColor("--caleo-light-gray", caleoPalette.lightGray),
    resolveColor("--caleo-text", caleoPalette.dark),
  ];
  return { primary: palette[0], sky: palette[1], text: palette[4], palette };
});

const typeColors = computed<Record<string, string>>(() => {
  const types = Array.from(
    new Set(
      graph.value.nodes
        .map((node) => node.type)
        .filter((type): type is string => Boolean(type)),
    ),
  );
  return buildTypeColors(types, colors.value.palette);
});

const forceLayout = new ForceLayout({ positionFixedByDrag: true });

const configs = computed<UserConfigs>(() => ({
  view: {
    layoutHandler: forceLayout,
    autoPanAndZoomOnLoad: "fit-content",
    fitContentMargin: 24,
    panEnabled: true,
    zoomEnabled: true,
    doubleClickZoomEnabled: true,
    mouseWheelZoomEnabled: true,
    grid: {
      visible: false,
      interval: 100,
      line: { color: resolveColor("--caleo-border", "#3a3e48"), width: 1 },
      thick: { color: resolveColor("--caleo-border", "#3a3e48"), width: 1 },
    },
  },
  node: {
    selectable: true,
    draggable: true,
    normal: {
      type: "circle",
      radius: (node) => (node.size as number) ?? 14,
      color: (node) => typeColors.value[node.type ?? ""] ?? colors.value.primary,
    },
    selected: {
      type: "circle",
      radius: (node) => (node.size as number) ?? 14,
      color: colors.value.sky,
    },
    focusring: { color: colors.value.primary, width: 1.5, padding: 3 },
    label: { visible: true, color: colors.value.text, fontSize: 12, fontFamily: "inherit" },
  },
  edge: {
    normal: { color: colors.value.sky, width: 1.5 },
    selected: { color: colors.value.primary },
    gap: 8,
  },
}));

const viewGraph = computed(() => mapKnowledgeGraph(graph.value));

async function loadGraph() {
  loading.value = true;
  error.value = "";
  try {
    const topic = selectedTopic.value || undefined;
    const result = await getGraph(undefined, topic);
    if (!topic) totalNodes.value = result.nodes.length;
    graph.value = result;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function loadTopics() {
  topicLoading.value = true;
  try {
    const result = await getGraphTopics();
    topics.value = Array.isArray(result) ? result : [];
  } catch {
    topics.value = [];
  } finally {
    topicLoading.value = false;
  }
}

async function onTopicChange() {
  selectedNodeId.value = null;
  await loadGraph();
}

function onNodeClick(nodeId: string) {
  selectedNodeId.value = nodeId;
}

const selectedNode = computed(() => {
  const id = selectedNodeId.value;
  if (!id) return null;
  const node = graph.value.nodes.find((n) => n.id === id);
  if (!node) return null;
  const relations = nodeRelations(graph.value, id);
  const labelFor = (other: string) =>
    graph.value.nodes.find((n) => n.id === other)?.label ?? other;
  return {
    node,
    relations: {
      incoming: relations.incoming.map((r) => ({ ...r, other: labelFor(r.other) })),
      outgoing: relations.outgoing.map((r) => ({ ...r, other: labelFor(r.other) })),
    },
  };
});

const eventHandlers = {
  "node:click": ({ node }: { node: string }) => onNodeClick(node),
};

onMounted(() => {
  void loadGraph();
  void loadTopics();
});
</script>

<template>
  <section class="knowledge-panel">
    <header class="knowledge-header">
      <h2 class="knowledge-title">Knowledge Graph</h2>
      <div class="knowledge-controls">
        <span class="knowledge-meta">
          <template v-if="selectedTopic">
            Showing {{ graph.nodes.length }} of {{ totalNodes }} entities ·
            {{ graph.edges.length }} links
          </template>
          <template v-else>
            {{ graph.nodes.length }} entities · {{ graph.edges.length }} links
          </template>
        </span>
        <t-select
          v-model="selectedTopic"
          class="topic-filter"
          size="small"
          :loading="topicLoading"
          placeholder="All topics"
          clearable
          :options="topics.map((topic) => ({ label: topic, value: topic }))"
          @change="onTopicChange"
          @clear="onTopicChange"
        >
          <template #prefix>
            <span class="topic-filter-label">Topic</span>
          </template>
        </t-select>
        <t-input
          v-model="searchQuery"
          class="knowledge-search-input"
          size="small"
          clearable
          placeholder="Search knowledge..."
          @enter="runSearch"
          @clear="clearSearch"
        >
          <template #suffixIcon>
            <t-button
              size="small"
              variant="text"
              :loading="searching"
              :disabled="!searchQuery.trim()"
              @click="runSearch"
            >
              Search
            </t-button>
          </template>
        </t-input>
        <t-button
          size="small"
          variant="outline"
          :theme="showAddData ? 'primary' : 'default'"
          @click="showAddData = !showAddData"
        >
          {{ showAddData ? "Hide Data Input" : "Add Data" }}
        </t-button>
        <t-button size="small" variant="outline" :loading="loading" @click="loadGraph">
          Refresh
        </t-button>
      </div>
    </header>

    <div v-if="showAddData" class="add-data-panel">
      <div class="add-data-head">
        <h3 class="add-data-title">Add Data</h3>
        <span class="add-data-hint">
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
        <span class="drop-zone-main">Drop files here or click to upload</span>
        <span class="drop-zone-sub">Every file is parsed by docling → LightRAG + llm_wiki</span>
      </div>

      <div class="url-row">
        <t-input
          v-model="urlInput"
          size="small"
          clearable
          placeholder="https://example.com/page — paste a URL to ingest"
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

      <p v-if="submitError" class="add-data-error">{{ submitError }}</p>

      <div v-if="tasks.length" class="task-list">
        <div v-for="task in tasks" :key="task.id" class="task-item">
          <div class="task-head">
            <span class="task-source" :title="task.source">{{ task.source }}</span>
            <span class="task-badge" :class="task.status">{{ task.status }}</span>
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
            <span
              v-for="stage in [
                { key: 'parsing' as const, label: 'Parse' },
                { key: 'ingesting_lightrag' as const, label: 'LightRAG' },
                { key: 'ingesting_llmwiki' as const, label: 'llm_wiki' },
              ]"
              :key="stage.key"
              class="task-stage"
              :class="stageStatus(task.stages[stage.key])"
            >
              {{ stage.label }}: {{ task.stages[stage.key].status }}
            </span>
          </div>
          <p v-if="hasFailedStage(task)" class="task-stage-error">{{ friendlyError(task) }}</p>
        </div>
      </div>
    </div>

    <div class="knowledge-body">
      <template v-if="searchActive">
        <div class="search-results">
          <div class="search-results-head">
            <span class="search-results-title">
              {{ searchResults.length }} result{{ searchResults.length === 1 ? "" : "s" }}
              for "{{ searchQuery }}"
            </span>
            <t-button size="small" variant="text" @click="clearSearch">
              Back to graph
            </t-button>
          </div>
          <p v-if="searchError" class="knowledge-error">{{ searchError }}</p>
          <p v-else-if="searching" class="knowledge-status">Searching...</p>
          <p v-else-if="searchResults.length === 0" class="knowledge-status">
            No results found.
          </p>
          <ul v-else class="search-result-list">
            <li
              v-for="(result, index) in searchResults"
              :key="`${result.source}-${index}`"
              class="search-result-item"
              :class="{ clickable: result.source === 'llmwiki' && result.path }"
              @click="onResultClick(result)"
            >
              <div class="search-result-head">
                <span class="search-result-title">{{ result.title }}</span>
                <span class="search-result-source" :class="result.source">
                  {{ result.source === "lightrag" ? "RAG" : "Wiki" }}
                </span>
              </div>
              <p class="search-result-snippet">{{ result.snippet }}</p>
              <p v-if="result.path" class="search-result-path">{{ result.path }}</p>
            </li>
          </ul>
        </div>
      </template>

      <template v-else>
        <p v-if="error" class="knowledge-error">{{ error }}</p>
        <p v-else-if="loading && graph.nodes.length === 0" class="knowledge-status">
          Loading knowledge graph...
        </p>
        <div
          v-else-if="!loading && graph.nodes.length === 0"
          class="knowledge-empty"
        >
          <p class="knowledge-empty-title">No knowledge graph yet</p>
          <p class="knowledge-empty-sub">
            Ingest a document from the Data input panel to build the entity graph.
          </p>
        </div>

        <template v-else>
          <div class="knowledge-canvas">
            <v-network-graph
              :nodes="viewGraph.nodes"
              :edges="viewGraph.edges"
              :configs="configs"
              :selected-nodes="selectedNodeId ? [selectedNodeId] : []"
              :event-handlers="eventHandlers"
            />
          </div>

          <aside v-if="selectedNode" class="knowledge-detail">
            <div class="detail-head">
              <div class="detail-head-text">
                <h3 class="detail-name">{{ selectedNode.node.label }}</h3>
                <span v-if="selectedNode.node.type" class="detail-type">
                  {{ selectedNode.node.type }}
                </span>
              </div>
              <t-button size="small" variant="text" @click="selectedNodeId = null">
                Close
              </t-button>
            </div>

            <div class="detail-section">
              <h4 class="detail-section-title">Outgoing</h4>
              <ul v-if="selectedNode.relations.outgoing.length" class="relation-list">
                <li v-for="relation in selectedNode.relations.outgoing" :key="relation.other">
                  <span class="relation-node">{{ relation.other }}</span>
                  <span v-if="relation.weight" class="relation-weight">
                    weight {{ relation.weight }}
                  </span>
                </li>
              </ul>
              <p v-else class="relation-empty">None</p>
            </div>

            <div class="detail-section">
              <h4 class="detail-section-title">Incoming</h4>
              <ul v-if="selectedNode.relations.incoming.length" class="relation-list">
                <li v-for="relation in selectedNode.relations.incoming" :key="relation.other">
                  <span class="relation-node">{{ relation.other }}</span>
                  <span v-if="relation.weight" class="relation-weight">
                    weight {{ relation.weight }}
                  </span>
                </li>
              </ul>
              <p v-else class="relation-empty">None</p>
            </div>
          </aside>
        </template>
      </template>
    </div>
  </section>
</template>

<style scoped>
.knowledge-panel {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 48px);
  padding: 24px;
}

.knowledge-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
  padding: 16px 20px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  box-shadow: var(--caleo-shadow);
}

.knowledge-title {
  margin: 0;
  font-size: 20px;
  color: var(--caleo-text);
}

.knowledge-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

.knowledge-search-input {
  width: 240px;
}

.topic-filter {
  width: 180px;
}

.topic-filter-label {
  font-size: 12px;
  color: var(--caleo-text-secondary);
  padding-right: 4px;
}

.knowledge-search-input :deep(.t-input__inner) {
  font-size: 13px;
}

.knowledge-search-input :deep(.t-input__suffix) {
  padding-right: 4px;
}

.knowledge-meta {
  font-size: 13px;
  color: var(--caleo-text-secondary);
}

.search-results {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  box-shadow: var(--caleo-shadow);
  padding: 16px;
  overflow-y: auto;
}

.search-results-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.search-results-title {
  font-size: 13px;
  color: var(--caleo-text-secondary);
}

.search-result-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.search-result-item {
  padding: 12px;
  border-radius: 8px;
  background: var(--caleo-surface-hover);
  border: 1px solid var(--caleo-border);
}

.search-result-item.clickable {
  cursor: pointer;
}

.search-result-item.clickable:hover {
  border-color: var(--caleo-primary);
}

.search-result-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.search-result-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--caleo-text);
}

.search-result-source {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

.search-result-source.lightrag {
  color: var(--caleo-primary);
  background: var(--caleo-sidebar-active);
}

.search-result-source.llmwiki {
  color: var(--caleo-sky);
  background: var(--caleo-surface-hover);
}

.search-result-snippet {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--caleo-text-secondary);
}

.search-result-path {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--caleo-sky);
  word-break: break-all;
}

.add-data-panel {
  margin-bottom: 16px;
  padding: 16px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  box-shadow: var(--caleo-shadow);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.add-data-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.add-data-title {
  margin: 0;
  font-size: 15px;
  color: var(--caleo-text);
}

.add-data-hint {
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

.add-data-error {
  margin: 0;
  color: #d54941;
  font-size: 13px;
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-top: 1px solid var(--caleo-border);
  padding-top: 12px;
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
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

.task-badge.pending {
  color: var(--caleo-text-secondary);
  background: var(--caleo-surface-hover);
}

.task-badge.parsing,
.task-badge.ingesting {
  color: var(--caleo-primary);
  background: var(--caleo-sidebar-active);
}

.task-badge.done {
  color: #2f9e63;
  background: rgba(47, 158, 99, 0.14);
}

.task-badge.failed {
  color: #d54941;
  background: rgba(213, 73, 65, 0.14);
}

.task-stages {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.task-stage {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  border: 1px solid var(--caleo-border);
  color: var(--caleo-text-secondary);
}

.task-stage.running {
  color: var(--caleo-primary);
  border-color: var(--caleo-primary);
}

.task-stage.done {
  color: #2f9e63;
  border-color: rgba(47, 158, 99, 0.5);
}

.task-stage.failed {
  color: #d54941;
  border-color: rgba(213, 73, 65, 0.5);
}

.task-stage-error {
  margin: 8px 0 0;
  font-size: 12px;
  color: #d54941;
}

.knowledge-body {
  flex: 1;
  display: flex;
  gap: 16px;
  min-height: 0;
}

.knowledge-canvas {
  flex: 1;
  min-width: 0;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  box-shadow: var(--caleo-shadow);
  overflow: hidden;
}

.knowledge-canvas :deep(svg) {
  display: block;
}

.knowledge-error {
  margin: 0;
  padding: 16px;
  color: #d54941;
  font-size: 13px;
}

.knowledge-status {
  margin: 0;
  padding: 16px;
  color: var(--caleo-text-secondary);
  font-size: 13px;
}

.knowledge-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  box-shadow: var(--caleo-shadow);
}

.knowledge-empty-title {
  margin: 0;
  font-size: 16px;
  color: var(--caleo-text);
}

.knowledge-empty-sub {
  margin: 0;
  font-size: 13px;
  color: var(--caleo-text-secondary);
}

.knowledge-detail {
  width: 280px;
  flex-shrink: 0;
  padding: 16px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  box-shadow: var(--caleo-shadow);
  overflow-y: auto;
}

.detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--caleo-border);
}

.detail-head-text {
  min-width: 0;
}

.detail-name {
  margin: 0;
  font-size: 16px;
  color: var(--caleo-text);
  word-break: break-word;
}

.detail-type {
  display: inline-block;
  margin-top: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  color: var(--caleo-text-secondary);
  background: var(--caleo-surface-hover);
}

.detail-section {
  margin-top: 16px;
}

.detail-section-title {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--caleo-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

.relation-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.relation-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--caleo-surface-hover);
}

.relation-node {
  font-size: 13px;
  color: var(--caleo-text);
  word-break: break-word;
}

.relation-weight {
  font-size: 11px;
  color: var(--caleo-text-secondary);
  flex-shrink: 0;
}

.relation-empty {
  margin: 0;
  font-size: 13px;
  color: var(--caleo-text-secondary);
}
</style>
