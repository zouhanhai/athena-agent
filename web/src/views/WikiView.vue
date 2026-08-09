<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useRoute, useRouter } from "vue-router";
import type { TreeNodeModel } from "tdesign-vue-next/es/tree/type";

import { deleteWikiDoc, getWikiTree, readWikiPage } from "@/api/kb";
import type { WikiTreeNode } from "@/api/kb";
import { hasWikiHeadings, renderMarkdown } from "@/kb/markdown";
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
const deleteVisible = ref(false);
const deleting = ref(false);
const deleteError = ref("");

const treeKeys = { value: "path", label: "name", children: "children" };

const renderedContent = computed(() =>
  renderMarkdown(content.value, {
    pagePath: activePath.value || undefined,
    toc: hasWikiHeadings(content.value),
  }),
);

/**
 * Intercept TOC/permalink anchor clicks and scroll the content pane to the
 * heading. The pane (not the window) is the scroll container, so native
 * `#fragment` navigation would scroll nothing; scrollIntoView handles nested
 * scroll containers correctly (G3.S5.T5).
 */
function onContentClick(event: MouseEvent): void {
  const target = (event.target as HTMLElement | null)?.closest?.("a");
  if (!target) return;
  const href = target.getAttribute("href");
  if (!href || !href.startsWith("#") || href.length < 2) return;
  const el = document.getElementById(href.slice(1));
  if (!el) return;
  event.preventDefault();
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Tree shown in the sidebar for the active view (no file duplication). */
const displayTree = computed(() =>
  buildViewTree(flattenPages(tree.value), view.value),
);

/** The selected wiki page path (only for file nodes). */
const selectedFile = computed(() =>
  activePath.value.endsWith(".md") ? activePath.value : null,
);

function requestDelete(): void {
  deleteError.value = "";
  deleteVisible.value = true;
}

async function confirmDelete(): Promise<void> {
  const path = selectedFile.value;
  if (!path) return;
  deleting.value = true;
  deleteError.value = "";
  try {
    const result = await deleteWikiDoc(path);
    if (!result.ok || result.llmwiki?.error) {
      deleteError.value = result.llmwiki?.error ?? "The document could not be deleted.";
      deleteVisible.value = true;
      return;
    }
    if (activePath.value === path) {
      activePath.value = "";
      content.value = "";
      contentError.value = "";
    }
    // Close the dialog immediately on success (before any async refresh) so it
    // never lingers with an empty selected file name.
    deleteVisible.value = false;
    await loadTree();
  } catch (err) {
    deleteError.value = err instanceof Error ? err.message : String(err);
    deleteVisible.value = true;
  } finally {
    deleting.value = false;
  }
}

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
          variant="primary-filled"
          size="small"
        >
          <t-radio-button value="topic">Topic</t-radio-button>
          <t-radio-button value="type">Type</t-radio-button>
        </t-radio-group>
        <t-button
          v-if="selectedFile"
          size="small"
          variant="outline"
          theme="danger"
          @click="requestDelete"
        >
          Delete
        </t-button>
        <t-button size="small" variant="outline" :loading="treeLoading" @click="loadTree">
          Refresh
        </t-button>
      </div>
    </header>

    <t-dialog
      v-model:visible="deleteVisible"
      header="Delete document"
      :confirm-btn="{ content: 'Delete', theme: 'danger' }"
      :cancel-btn="{ content: 'Cancel' }"
      :confirm-loading="deleting"
      @confirm="confirmDelete"
    >
      <template #body>
        <p class="wiki-delete-hint">
          Delete "<code>{{ selectedFile }}</code>" from both Wiki and Knowledge
          Graph? This cannot be undone.
        </p>
        <p v-if="deleteError" class="wiki-delete-error">{{ deleteError }}</p>
      </template>
    </t-dialog>

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
          @click="onContentClick"
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
  height: calc(100dvh - 48px);
  padding: 24px;
}

.wiki-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  padding: 10px 14px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
}

.wiki-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.2px;
  color: var(--caleo-text);
}

.wiki-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.wiki-meta {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--caleo-text-secondary);
}

.wiki-delete-hint {
  margin: 0 0 8px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--caleo-text);
}

.wiki-delete-hint code {
  padding: 2px 5px;
  border-radius: 4px;
  font-size: 13px;
  background: var(--caleo-surface-hover);
  color: var(--caleo-primary);
}

.wiki-delete-error {
  margin: 0;
  color: var(--caleo-error);
  font-size: 13px;
}

/* Segmented view switcher — themed for BOTH dark and light (G2.S5.T11).
   Selected segment = CALEO brand orange; unselected = surface/text-secondary.
   NOTE: the actual bg-block / checked-color overrides live in the GLOBAL style
   block at the bottom of this file (TDesign renders those nodes deep inside the
   tree, outside the scoped scope). */
.wiki-view-switcher :deep(.t-radio-group--primary-filled) {
  background-color: var(--caleo-surface-hover);
  border-color: var(--caleo-border);
}

.wiki-view-switcher :deep(.t-radio-group--primary-filled .t-radio-button) {
  color: var(--caleo-text-secondary);
}

.wiki-view-switcher :deep(.t-radio-group--primary-filled .t-radio-button:hover) {
  color: var(--caleo-text);
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
  color: var(--caleo-error);
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

/* GitHub-style task lists (markdown-it-task-lists): - [ ] / - [x] */
.wiki-content :deep(.task-list-item) {
  list-style: none;
  margin: 0.25em 0;
}
.wiki-content :deep(.task-list-item-checkbox) {
  margin: 0 0.5em 0 0;
  accent-color: var(--caleo-primary);
}
.wiki-content :deep(ul.contains-task-list),
.wiki-content :deep(ol.contains-task-list) {
  padding-left: 0.4em;
}

/* G3.S5.T5: long-document table of contents (rendered at the top of the body) */
.wiki-content :deep(.wiki-toc) {
  margin: 0 0 1.5em;
  padding: 12px 16px;
  background: var(--caleo-surface-hover);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  font-size: 13px;
}

.wiki-content :deep(.wiki-toc ul) {
  margin: 0;
  padding-left: 1.25em;
  list-style: none;
}

.wiki-content :deep(.wiki-toc > ul) {
  padding-left: 0;
}

.wiki-content :deep(.wiki-toc li) {
  margin: 0.2em 0;
}

.wiki-content :deep(.wiki-toc a) {
  color: var(--caleo-sky);
  text-decoration: none;
}

.wiki-content :deep(.wiki-toc a:hover) {
  text-decoration: underline;
  color: var(--caleo-primary);
}

/* G3.S5.T5: subtle heading permalink (anchored #) */
.wiki-content :deep(.wiki-heading-anchor) {
  margin-left: 0.35em;
  color: var(--caleo-text-secondary);
  text-decoration: none;
  font-size: 0.85em;
}

.wiki-content :deep(.wiki-heading-anchor:hover) {
  color: var(--caleo-primary);
}

.wiki-content :deep(h1[id]),
.wiki-content :deep(h2[id]),
.wiki-content :deep(h3[id]) {
  scroll-margin-top: 12px;
}

/* Inline images: responsive + rounded + subtle border */
.wiki-content :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
  border: 1px solid var(--caleo-border);
  margin: 0.5em 0;
}

/* Code highlighting: keyword/string/comment colours follow theme-ish palette */
.wiki-content :deep(.hljs-keyword),
.wiki-content :deep(.hljs-selector-tag),
.wiki-content :deep(.hljs-literal),
.wiki-content :deep(.hljs-built_in) {
  color: var(--caleo-primary);
}
.wiki-content :deep(.hljs-string),
.wiki-content :deep(.hljs-regexp),
.wiki-content :deep(.hljs-addition) {
  color: #86d98a;
}
.wiki-content :deep(.hljs-comment),
.wiki-content :deep(.hljs-quote) {
  color: var(--caleo-text-secondary);
  font-style: italic;
}
.wiki-content :deep(.hljs-number),
.wiki-content :deep(.hljs-symbol) {
  color: #e0c07a;
}
.wiki-content :deep(.hljs-title),
.wiki-content :deep(.hljs-section),
.wiki-content :deep(.hljs-name) {
  color: var(--caleo-sky);
}
.wiki-content :deep(.hljs-attr),
.wiki-content :deep(.hljs-attribute) {
  color: #d7a7e0;
}

/* Definition lists / task label spacing */
.wiki-content :deep(strong) {
  color: var(--caleo-text);
  font-weight: 600;
}
.wiki-content :deep(mark) {
  background: color-mix(in srgb, var(--caleo-primary) 25%, transparent);
  color: var(--caleo-text);
  padding: 0 3px;
  border-radius: 3px;
}
</style>

<!-- G2.S5.T11: non-scoped overrides so the segmented view-switcher selected segment
     shows brand orange in BOTH dark and light themes. Must be global (not scoped)
     because TDesign renders the bg-block deep inside the component tree. -->
<style>
.wiki-view-switcher .t-radio-group--primary-filled .t-radio-group__bg-block {
  background-color: var(--caleo-primary) !important;
}

.wiki-view-switcher .t-radio-group--primary-filled .t-radio-button.t-is-checked {
  color: #ffffff !important;
}
</style>
