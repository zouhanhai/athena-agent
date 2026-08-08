<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { VNetworkGraph } from "v-network-graph";
import { ForceLayout } from "v-network-graph/lib/force-layout";
import type { UserConfigs } from "v-network-graph";
import "v-network-graph/lib/style.css";

import { getGraph, getGraphTopics } from "@/api/kb";
import type { KnowledgeGraph } from "@/api/kb";
import { buildTypeColors, localSubgraph, mapKnowledgeGraph, nodeRelations } from "@/kb/graph";
import { caleoPalette } from "@/theme";
import { useThemeStore } from "@/stores/theme";

const theme = useThemeStore();
const { mode } = storeToRefs(theme);

const graph = ref<KnowledgeGraph>({ nodes: [], edges: [] });
const loading = ref(false);
const error = ref("");
const selectedNodeId = ref<string | null>(null);

const topics = ref<string[]>([]);
const selectedTopic = ref("");
const topicLoading = ref(false);

/** Node-local view: when set, the graph shows the local neighborhood of the
 *  named node (node + 1-2 hop relations) instead of the whole topic graph. */
const nodeMode = ref(false);
const nodeRoot = ref<string | null>(null);
const searchQuery = ref("");
const searching = ref(false);

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

/** Load the topic-scoped subgraph. With no topic selected the graph stays empty
 *  (never auto-loads the full 1000+ node graph). */
async function loadTopicGraph() {
  loading.value = true;
  error.value = "";
  nodeMode.value = false;
  nodeRoot.value = null;
  try {
    const topic = selectedTopic.value || undefined;
    if (!topic) {
      graph.value = { nodes: [], edges: [] };
      return;
    }
    graph.value = await getGraph(undefined, topic);
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
  searchQuery.value = "";
  await loadTopicGraph();
}

/** Look up a node by name and show only its 1-2 hop neighborhood. */
async function loadNodeGraph(query: string) {
  loading.value = true;
  searching.value = true;
  error.value = "";
  try {
    const result = await getGraph(query);
    const root = result.nodes.find(
      (node) => (node.label ?? node.id ?? "").toLowerCase() === query.toLowerCase(),
    );
    if (!root?.id) {
      error.value = `No node named "${query}" found.`;
      graph.value = { nodes: [], edges: [] };
      return;
    }
    nodeMode.value = true;
    nodeRoot.value = root.label ?? query;
    searchQuery.value = root.label ?? query;
    graph.value = localSubgraph(result, root.id, 2);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    graph.value = { nodes: [], edges: [] };
  } finally {
    loading.value = false;
    searching.value = false;
  }
}

function runSearch() {
  const query = searchQuery.value.trim();
  if (!query) return;
  selectedNodeId.value = null;
  void loadNodeGraph(query);
}

function clearSearch() {
  searchQuery.value = "";
  nodeMode.value = false;
  nodeRoot.value = null;
  selectedNodeId.value = null;
  if (selectedTopic.value) {
    void loadTopicGraph();
  } else {
    graph.value = { nodes: [], edges: [] };
    error.value = "";
  }
}

function refresh() {
  if (nodeMode.value) {
    const query = searchQuery.value.trim();
    if (query) void loadNodeGraph(query);
  } else if (selectedTopic.value) {
    void loadTopicGraph();
  }
}

function onNodeClick(nodeId: string) {
  const node = graph.value.nodes.find((n) => n.id === nodeId);
  if (!node) return;
  selectedNodeId.value = nodeId;
  nodeMode.value = true;
  nodeRoot.value = node.label ?? nodeId;
  searchQuery.value = node.label ?? nodeId;
  graph.value = localSubgraph(graph.value, nodeId, 2);
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

const metaText = computed(() => {
  if (nodeMode.value) {
    return `local graph for "${nodeRoot.value ?? searchQuery.value}" · ${graph.value.nodes.length} entities · ${graph.value.edges.length} links`;
  }
  if (selectedTopic.value) {
    return `Showing ${graph.value.nodes.length} entities · ${graph.value.edges.length} links`;
  }
  return "";
});

const hasView = computed(() => nodeMode.value || Boolean(selectedTopic.value));

onMounted(() => {
  void loadTopics();
});
</script>

<template>
  <section class="knowledge-panel">
    <header class="knowledge-header">
      <h2 class="knowledge-title">Knowledge Graph</h2>
      <div class="knowledge-controls">
        <span v-if="metaText" class="knowledge-meta">{{ metaText }}</span>
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
          placeholder="Search a node..."
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
        <t-button size="small" variant="outline" :loading="loading" @click="refresh">
          Refresh
        </t-button>
      </div>
    </header>

    <div class="knowledge-body">
      <template v-if="error">
        <p class="knowledge-error">{{ error }}</p>
      </template>

      <template v-else-if="hasView">
        <p v-if="loading && graph.nodes.length === 0" class="knowledge-status">
          Loading knowledge graph...
        </p>
        <div
          v-else-if="!loading && graph.nodes.length === 0"
          class="knowledge-empty"
        >
          <p class="knowledge-empty-title">No entities in this view</p>
          <p class="knowledge-empty-sub">
            Try a different topic or search for another node.
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

      <div v-else class="knowledge-empty">
        <p class="knowledge-empty-title">Explore the knowledge graph</p>
        <p class="knowledge-empty-sub">
          Choose a topic above or search for an entity to see its local neighborhood.
        </p>
      </div>
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
