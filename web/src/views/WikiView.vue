<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useRoute, useRouter } from "vue-router";
import type { TreeNodeModel } from "tdesign-vue-next/es/tree/type";

import { getWikiTree, readWikiPage } from "@/api/kb";
import type { WikiTreeNode } from "@/api/kb";
import { renderMarkdown } from "@/kb/markdown";
import { buildViewTree, flattenPages } from "@/kb/wiki-tree";
import type { WikiView } from "@/kb/wiki-tree";
import { useThemeStore } from "@/stores/theme";

const theme = useThemeStore();
const { mode } = storeToRefs(theme);
void mode;

const route = useRoute();
const router = useRouter();

const tree = ref<WikiTreeNode[]>([]);
const view = ref<WikiView>("topic");
const treeLoading = ref(true);
const treeError = ref("");
const activePath = ref("");
const content = ref("");
const contentLoading = ref(false);
const contentError = ref("");

const treeKeys = { value: "path", label: "name", children: "children" };

const renderedContent = computed(() => renderMarkdown(content.value));

/** Tree shown in the sidebar for the active view (no file duplication). */
const displayTree = computed(() => {
  if (view.value === "all") return tree.value;
  return buildViewTree(flattenPages(tree.value), view.value);
});

async function loadTree() {
  treeLoading.value = true;
  treeError.value = "";
  try {
    tree.value = await getWikiTree();
  } catch (err) {
    treeError.value = err instanceof Error ? err.message : String(err);
  } finally {
    treeLoading.value = false;
  }
}

async function openPage(path: string) {
  activePath.value = path;
  contentLoading.value = true;
  contentError.value = "";
  try {
    content.value = await readWikiPage(path);
    if (route.query.path !== path) {
      await router.replace({ query: { ...route.query, path } });
    }
  } catch (err) {
    contentError.value = err instanceof Error ? err.message : String(err);
  } finally {
    contentLoading.value = false;
  }
}

function isFileNode(node: WikiTreeNode): boolean {
  return !node.isDir;
}

function onTreeClick(context: { node: TreeNodeModel<WikiTreeNode> }) {
  const node = context.node.data;
  if (isFileNode(node)) void openPage(node.path);
}

const initialPath = typeof route.query.path === "string" ? route.query.path : "";

onMounted(async () => {
  await loadTree();
  if (initialPath) await openPage(initialPath);
});

watch(
  () => route.query.path,
  (path) => {
    if (typeof path === "string" && path && path !== activePath.value) {
      void openPage(path);
    }
  },
);
</script>

<template>
  <section class="wiki-panel">
    <header class="wiki-header">
      <h2 class="wiki-title">Wiki</h2>
      <div class="wiki-controls">
        <span v-if="tree.length" class="wiki-meta">{{ tree.length }} top-level folders</span>
        <t-radio-group
          v-model="view"
          class="wiki-view-switcher"
          variant="default-filled"
          size="small"
        >
          <t-radio-button value="topic">Topic</t-radio-button>
          <t-radio-button value="type">Type</t-radio-button>
          <t-radio-button value="all">All</t-radio-button>
        </t-radio-group>
        <t-button size="small" variant="outline" :loading="treeLoading" @click="loadTree">
          Refresh
        </t-button>
      </div>
    </header>

    <div class="wiki-body">
      <aside class="wiki-tree-pane">
        <p v-if="treeError" class="wiki-error">{{ treeError }}</p>
        <p v-else-if="treeLoading" class="wiki-status">Loading wiki tree...</p>
        <p v-else-if="tree.length === 0" class="wiki-status">
          No wiki pages yet. Ingest a document to build wiki content.
        </p>
        <t-tree
          v-else
          :data="displayTree"
          :keys="treeKeys"
          :activable="true"
          :actived="activePath ? [activePath] : []"
          :expand-on-click-node="true"
          :default-expand-all="false"
          :hover="true"
          class="wiki-tree"
          @click="onTreeClick"
        />
      </aside>

      <div class="wiki-content-pane">
        <p v-if="contentError" class="wiki-error">{{ contentError }}</p>
        <p v-else-if="contentLoading" class="wiki-status">Loading page...</p>
        <p v-else-if="!activePath" class="wiki-status wiki-empty-hint">
          Select a wiki page from the tree to read its content.
        </p>
        <div
          v-else
          class="wiki-content"
          data-testid="wiki-content"
          v-html="renderedContent"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.wiki-panel {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 48px);
  padding: 24px;
}

.wiki-header {
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

.wiki-title {
  margin: 0;
  font-size: 20px;
  color: var(--caleo-text);
}

.wiki-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

.wiki-meta {
  font-size: 13px;
  color: var(--caleo-text-secondary);
}

/* Segmented view switcher — themed for BOTH dark and light (G2.S5.T11).
   Selected segment = CALEO brand orange; unselected = surface/text-secondary. */
.wiki-view-switcher :deep(.t-radio-group--filled) {
  background-color: var(--caleo-surface-hover);
  border-color: var(--caleo-border);
}

.wiki-view-switcher :deep(.t-radio-group--filled .t-radio-button) {
  color: var(--caleo-text-secondary);
}

.wiki-view-switcher :deep(.t-radio-group--filled .t-radio-button:hover) {
  color: var(--caleo-text);
}

.wiki-view-switcher :deep(.t-radio-group--filled .t-radio-group__bg-block) {
  background-color: var(--caleo-primary);
}

.wiki-view-switcher :deep(.t-radio-group--filled .t-radio-button.t-is-checked) {
  color: #ffffff;
}

.wiki-body {
  flex: 1;
  display: flex;
  gap: 16px;
  min-height: 0;
}

.wiki-tree-pane {
  width: 280px;
  flex-shrink: 0;
  padding: 12px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  box-shadow: var(--caleo-shadow);
  overflow-y: auto;
}

.wiki-content-pane {
  flex: 1;
  min-width: 0;
  padding: 20px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  box-shadow: var(--caleo-shadow);
  overflow-y: auto;
}

.wiki-tree :deep(.t-tree__item) {
  color: var(--caleo-text);
}

.wiki-tree :deep(.t-tree__item--active) {
  color: var(--caleo-primary);
  background: var(--caleo-sidebar-active);
}

.wiki-tree :deep(.t-tree__label) {
  font-size: 13px;
}

.wiki-error {
  margin: 0;
  padding: 16px;
  color: #d54941;
  font-size: 13px;
}

.wiki-status {
  margin: 0;
  padding: 16px;
  color: var(--caleo-text-secondary);
  font-size: 13px;
}

.wiki-empty-hint {
  text-align: center;
}

.wiki-content {
  color: var(--caleo-text);
  font-size: 14px;
  line-height: 1.7;
  word-break: break-word;
}

.wiki-content :deep(h1),
.wiki-content :deep(h2),
.wiki-content :deep(h3),
.wiki-content :deep(h4) {
  margin: 1.2em 0 0.5em;
  color: var(--caleo-text);
  font-weight: 600;
  border-bottom: 1px solid var(--caleo-border);
  padding-bottom: 0.3em;
}

.wiki-content :deep(h1) {
  font-size: 22px;
}

.wiki-content :deep(h2) {
  font-size: 19px;
}

.wiki-content :deep(h3) {
  font-size: 16px;
}

.wiki-content :deep(a) {
  color: var(--caleo-sky);
  text-decoration: none;
}

.wiki-content :deep(a:hover) {
  text-decoration: underline;
}

.wiki-content :deep(code) {
  padding: 2px 5px;
  border-radius: 4px;
  font-family: monospace;
  font-size: 13px;
  background: var(--caleo-surface-hover);
  color: var(--caleo-primary);
}

.wiki-content :deep(pre) {
  padding: 12px;
  border-radius: 6px;
  overflow-x: auto;
  background: var(--caleo-body-bg);
  border: 1px solid var(--caleo-border);
}

.wiki-content :deep(pre code) {
  padding: 0;
  background: transparent;
  color: var(--caleo-text);
}

.wiki-content :deep(blockquote) {
  margin: 1em 0;
  padding: 4px 12px;
  border-left: 3px solid var(--caleo-primary);
  background: var(--caleo-surface-hover);
  color: var(--caleo-text-secondary);
}

.wiki-content :deep(ul),
.wiki-content :deep(ol) {
  padding-left: 1.5em;
  margin: 0.5em 0;
}

.wiki-content :deep(li) {
  margin: 0.2em 0;
}

.wiki-content :deep(table) {
  border-collapse: collapse;
  margin: 1em 0;
  width: 100%;
}

.wiki-content :deep(th),
.wiki-content :deep(td) {
  padding: 6px 10px;
  border: 1px solid var(--caleo-border);
  text-align: left;
}

.wiki-content :deep(th) {
  background: var(--caleo-surface-hover);
  font-weight: 600;
}

.wiki-content :deep(hr) {
  border: none;
  border-top: 1px solid var(--caleo-border);
  margin: 1.5em 0;
}
</style>
