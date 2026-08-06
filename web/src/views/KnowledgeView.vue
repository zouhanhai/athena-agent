<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { VNetworkGraph } from "v-network-graph";
import { ForceLayout } from "v-network-graph/lib/force-layout";
import type { UserConfigs } from "v-network-graph";
import "v-network-graph/lib/style.css";

import { getGraph } from "@/api/kb";
import type { KnowledgeGraph } from "@/api/kb";
import { buildTypeColors, mapKnowledgeGraph, nodeRelations } from "@/kb/graph";
import { caleoPalette } from "@/theme";
import { useThemeStore } from "@/stores/theme";

const theme = useThemeStore();
const { mode } = storeToRefs(theme);

const graph = ref<KnowledgeGraph>({ nodes: [], edges: [] });
const loading = ref(true);
const error = ref("");
const selectedNodeId = ref<string | null>(null);

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
      color: (node) => typeColors.value[node.type ?? ""] ?? colors.value.primary,
      radius: 14,
    },
    selected: { color: colors.value.sky },
    focusring: { color: colors.value.primary, width: 2, padding: 3 },
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
    graph.value = await getGraph();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
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

onMounted(loadGraph);
</script>

<template>
  <section class="knowledge-panel">
    <header class="knowledge-header">
      <h2 class="knowledge-title">Knowledge Graph</h2>
      <div class="knowledge-controls">
        <span class="knowledge-meta">
          {{ graph.nodes.length }} entities · {{ graph.edges.length }} links
        </span>
        <t-button size="small" variant="outline" :loading="loading" @click="loadGraph">
          Refresh
        </t-button>
      </div>
    </header>

    <div class="knowledge-body">
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
