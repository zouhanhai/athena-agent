<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch, watchEffect } from "vue";
import { storeToRefs } from "pinia";
import { useRoute, useRouter } from "vue-router";
import type { TreeNodeModel } from "tdesign-vue-next/es/tree/type";

import { deleteWikiDoc, getWikiCodeMeta, getWikiTree, readWikiPage, saveWikiPage, searchKnowledge } from "@/api/kb";
import type { KnowledgeSearchResult, WikiCodeMeta, WikiTreeNode } from "@/api/kb";
import { extractWikiHeadings, hasWikiHeadings, renderMarkdown } from "@/kb/markdown";
import WikiCodeRenderer from "@/components/wiki/WikiCodeRenderer.vue";
import { detectCodeChannel } from "@/kb/code-links";
import { attachHeadings, buildViewTree, flattenPages } from "@/kb/wiki-tree";
import type { WikiView } from "@/kb/wiki-tree";
import { useThemeStore } from "@/stores/theme";
import { useAuthStore } from "@/stores/auth";

const theme = useThemeStore();
const { mode } = storeToRefs(theme);
void mode;

const auth = useAuthStore();

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

// G4.S8.T11: structured code metadata for type: code pages, resolved from the
// page's stored chunks_ref. When it resolves, WikiView dispatches the matching
// per-DocType renderer; otherwise it falls back to today's markdown rendering.
const structuredMeta = ref<WikiCodeMeta | null>(null);
const structuredLoading = ref(false);
// Cross-link fallback: clicking a FK/chip whose target page does not exist
// triggers a wiki search whose results are surfaced here (no dead links).
const searchResults = ref<KnowledgeSearchResult[]>([]);
const searchResultsFor = ref("");
const searchResultError = ref("");

// G4.S3.T10: wiki editing is permission-gated behind `kb.edit` — admin by
// default, grantable to a member. Everyone else sees the wiki read-only.
const canEdit = computed(
  () =>
    auth.employee !== null &&
    (auth.employee.role === "admin" || auth.employee.permissions?.includes("kb.edit") === true),
);
const editing = ref(false);
const editingContent = ref("");
// G3.S5: preserve the reader's scroll position when entering edit mode. The
// rendered pane and the textarea have different line heights, so we carry over
// the *ratio* (scrollTop / scrollHeight) rather than an absolute pixel offset.
const editorEl = ref<HTMLElement | null>(null);
const editScrollRatio = ref(0);
const saving = ref(false);
const saveError = ref("");
const saveNotice = ref("");

const treeKeys = { value: "path", label: "name", children: "children" };

const contentPane = ref<HTMLElement | null>(null);
// G4.S3.T10: the scroll container is the content *pane* (.wiki-content-pane,
// overflow-y: auto) — NOT .wiki-content (contentPane) which doesn't scroll.
const contentPaneEl = ref<HTMLElement | null>(null);

/** Minimal surface of the TDesign tree used to auto-expand the active file. */
interface WikiTreeHandle {
  setExpanded: (value: string | number, isExpanded: boolean) => void;
  getItem: (value: string | number) => unknown;
}
const treeRef = ref<WikiTreeHandle | null>(null);

const renderedContent = computed(() =>
  renderMarkdown(content.value, {
    pagePath: activePath.value || undefined,
    toc: hasWikiHeadings(content.value),
  }),
);

/** Best-effort parse of the leading `---` frontmatter of the active page. */
interface PageFrontmatter {
  type?: string;
  system?: string;
  devclass?: string;
  transport?: string;
}

const pageFrontmatter = computed<PageFrontmatter>(() => {
  const normalized = content.value.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---/.exec(normalized);
  if (!match) return {};
  const out: PageFrontmatter = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (key && value) out[key as keyof PageFrontmatter] = value;
  }
  return out;
});

/** Code metadata (system / devclass / transport) shown for type: code pages. */
const codeMeta = computed(() => {
  const fm = pageFrontmatter.value;
  if (fm.type !== "code") return null;
  return {
    system: fm.system,
    devclass: fm.devclass,
    transport: fm.transport,
  };
});

/** G4.S8.T11: the detected renderer channel from the loaded code-meta, or null
 *  when the page has no structured metadata (fall back to markdown). */
const codeChannel = computed(() =>
  pageFrontmatter.value.type === "code" ? detectCodeChannel(structuredMeta.value) : null,
);

const codeRendererActive = computed(() => codeChannel.value !== null);

/** All wiki page paths (for cross-link existence checks — no dead links). */
const existingPaths = computed(() => flattenPages(tree.value).map((p) => p.path));

async function loadCodeMeta(path: string): Promise<void> {
  structuredMeta.value = null;
  searchResults.value = [];
  searchResultsFor.value = "";
  if (pageFrontmatter.value.type !== "code") return;
  structuredLoading.value = true;
  try {
    structuredMeta.value = await getWikiCodeMeta(path);
  } catch {
    // code-meta unavailable (404/non-code/network) → markdown fallback
    structuredMeta.value = null;
  } finally {
    structuredLoading.value = false;
  }
}

/** Cross-link navigation: open the resolved page directly. */
function onCodeNavigate(path: string): void {
  void openPage(path);
}

/** Cross-link fallback: the target page does not exist → wiki search. */
async function onCodeSearch(target: string): Promise<void> {
  searchResults.value = [];
  searchResultsFor.value = target;
  searchResultError.value = "";
  try {
    const results = await searchKnowledge(target);
    searchResults.value = Array.isArray(results) ? results : [];
  } catch (err) {
    searchResultError.value = err instanceof Error ? err.message : String(err);
  }
}

function openSearchResult(path: string | undefined): void {
  if (path) void openPage(path);
}

/** The active page's internal heading outline (h1/h2/h3) for the left tree. */
const headings = computed(() => extractWikiHeadings(content.value));

/**
 * Intercept TOC/permalink anchor clicks and scroll the content pane to the
 * heading. The pane (not the window) is the scroll container, so native
 * `#fragment` navigation would scroll nothing; scrollIntoView handles nested
 * scroll containers correctly (G3.S5.T5).
 *
 * Also handles the G3.S5.T6 accordion: clicking a `.wiki-toc-toggle` folds or
 * unfolds that TOC level's child list instead of navigating.
 */
function onContentClick(event: MouseEvent): void {
  const rawTarget = event.target as HTMLElement | null;
  const toggle = rawTarget?.closest?.(".wiki-toc-toggle");
  if (toggle instanceof HTMLButtonElement) {
    const li = toggle.closest("li");
    const childList = li?.querySelector(":scope > ul");
    if (li && childList) {
      event.preventDefault();
      const collapsed = childList.classList.toggle("wiki-toc-collapsed");
      toggle.classList.toggle("is-collapsed", collapsed);
      toggle.textContent = collapsed ? "▸" : "▾";
      toggle.setAttribute("aria-expanded", String(!collapsed));
    }
    return;
  }
  const target = rawTarget?.closest?.("a");
  if (!target) return;
  const href = target.getAttribute("href");
  if (!href || !href.startsWith("#") || href.length < 2) return;
  const el = document.getElementById(href.slice(1));
  if (!el) return;
  event.preventDefault();
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * Walk the nested `.wiki-toc` list and add an accordion toggle to every `li`
 * that has a child list. Default state (G3.S5.T6): the two outermost levels
 * stay expanded; deeper levels (h3 and beyond) start collapsed so long docs
 * are not a wall of text. Re-injected after each content render — `v-html`
 * wipes the injected DOM on every re-render.
 */
function initTocAccordion(): void {
  const toc = contentPane.value?.querySelector(".wiki-toc");
  const rootList = toc?.querySelector(":scope > ul");
  if (!rootList) return;
  walkTocLevel(rootList, 0);
}

function walkTocLevel(ul: Element, depth: number): void {
  for (const child of Array.from(ul.children)) {
    if (!(child instanceof HTMLElement)) continue;
    const childList = child.querySelector(":scope > ul");
    if (!childList) continue;
    // Idempotent: a previous pass (e.g. a re-arm after `contentLoading` flips)
    // may already have injected the toggle into this li.
    if (child.querySelector(":scope > .wiki-toc-toggle")) continue;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "wiki-toc-toggle";
    const collapsed = depth >= 1;
    toggle.classList.toggle("is-collapsed", collapsed);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("aria-label", "Expand or collapse this section");
    toggle.textContent = collapsed ? "▸" : "▾";
    child.insertBefore(toggle, child.firstChild);
    childList.classList.toggle("wiki-toc-collapsed", collapsed);
    walkTocLevel(childList, depth + 1);
  }
}

/**
 * Re-arm the TOC accordion once the freshly-rendered content is in the DOM
 * (G3.S5.T6). Re-reads BOTH the rendered markdown AND the content-loading flag:
 * `content.value` changes while `contentLoading` is still true (openPage sets
 * content, resolves code-meta, THEN flips the flag), and the content pane
 * (`contentPane` ref) is only mounted once `contentLoading` drops. Skipping the
 * arm while loading + re-arming on the flag flip guarantees the walk sees the
 * rendered `.wiki-toc` DOM. Idempotent — v-html wipes injected toggles, and
 * duplicate arms are skipped inside walkTocLevel.
 */
watchEffect(() => {
  void renderedContent.value;
  void contentLoading.value;
  if (contentLoading.value) return;
  void nextTick(initTocAccordion);
});

/** Tree shown in the sidebar for the active view (no file duplication),
 *  extended with the active file's heading outline (G3.S5.T6). */
const displayTree = computed(() =>
  attachHeadings(
    buildViewTree(flattenPages(tree.value), view.value),
    activePath.value,
    headings.value,
  ),
);

/** Auto-expand the selected file node so its heading outline is visible. */
watch(displayTree, async () => {
  await nextTick();
  const path = activePath.value;
  if (!path || headings.value.length === 0) return;
  if (treeRef.value?.getItem?.(path)) {
    treeRef.value.setExpanded(path, true);
  }
});

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
  editing.value = false;
  editingContent.value = "";
  saveError.value = "";
  saveNotice.value = "";
  contentLoading.value = true;
  contentError.value = "";
  searchResults.value = [];
  searchResultsFor.value = "";
  try {
    content.value = await readWikiPage(path);
    if (route.query.path !== path) {
      await router.replace({ query: { ...route.query, path } });
    }
    await loadCodeMeta(path);
  } catch (err) {
    contentError.value = err instanceof Error ? err.message : String(err);
  } finally {
    contentLoading.value = false;
  }
}

/** Enter edit mode for the selected page (G4.S3.T10). */
function startEdit(): void {
  if (!selectedFile.value) return;
  editingContent.value = content.value;
  saveError.value = "";
  saveNotice.value = "";
  // Capture the reader's scroll ratio so the editor can open at the same place.
  const pane = contentPaneEl.value; // the .wiki-content-pane scroll container
  editScrollRatio.value =
    pane && pane.scrollHeight > pane.clientHeight
      ? pane.scrollTop / (pane.scrollHeight - pane.clientHeight)
      : 0;
  editing.value = true;
  // Restore the scroll position once the textarea is mounted.
  requestAnimationFrame(() => {
    const el = editorEl.value;
    if (el && editScrollRatio.value > 0) {
      el.scrollTop = editScrollRatio.value * (el.scrollHeight - el.clientHeight);
    }
  });
}

function cancelEdit(): void {
  editing.value = false;
  editingContent.value = "";
  saveError.value = "";
  saveNotice.value = "";
}

/** Save the corrected markdown to the wiki + trigger the Athena diff-refine /
 *  RAG re-ingest background task (G4.S3.T10). */
async function confirmSave(): Promise<void> {
  const path = selectedFile.value;
  if (!path) return;
  saving.value = true;
  saveError.value = "";
  saveNotice.value = "";
  try {
    const result = await saveWikiPage(path, editingContent.value);
    if (!result.saved) {
      saveError.value = "The document could not be saved.";
      return;
    }
    content.value = editingContent.value;
    editing.value = false;
    saveNotice.value = "Saved. Athena is re-ingesting the corrected page into retrieval...";
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}

function isFileNode(node: WikiTreeNode): boolean {
  return !node.isDir;
}

/** Scroll the content pane to the section a left-tree heading node targets. */
function scrollToHeading(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function onTreeClick(context: { node: TreeNodeModel<WikiTreeNode> }) {
  const node = context.node.data;
  if (node.isHeading && node.anchorId) {
    scrollToHeading(node.anchorId);
    return;
  }
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
          v-if="canEdit && selectedFile && !editing"
          size="small"
          variant="outline"
          data-testid="wiki-edit-button"
          @click="startEdit"
        >
          Edit
        </t-button>
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
          ref="treeRef"
          :data="displayTree"
          :keys="treeKeys"
          :activable="true"
          :actived="activePath ? [activePath] : []"
          :expand-on-click-node="true"
          :default-expand-all="false"
          :hover="true"
          class="wiki-tree"
          @click="onTreeClick"
        >
          <template #label="{ node }">
            <span
              v-if="node.data.isHeading"
              :class="`wiki-heading-node wiki-heading-node-${node.data.level ?? 1}`"
            >
              {{ node.data.name }}
            </span>
            <span v-else>{{ node.data.name }}</span>
          </template>
        </t-tree>
      </aside>

      <div ref="contentPaneEl" class="wiki-content-pane">
        <p v-if="contentError" class="wiki-error">{{ contentError }}</p>
        <p v-else-if="contentLoading" class="wiki-status">Loading page...</p>
        <p v-else-if="!activePath" class="wiki-status wiki-empty-hint">
          Select a wiki page from the tree to read its content.
        </p>
        <div v-else-if="editing" class="wiki-editor-pane" data-testid="wiki-editor-pane">
          <textarea
            v-model="editingContent"
            ref="editorEl"
            class="wiki-editor"
            data-testid="wiki-editor"
            aria-label="Wiki page markdown"
            :disabled="saving"
          />
          <p v-if="saveError" class="wiki-error">{{ saveError }}</p>
          <p v-else-if="saveNotice" class="wiki-save-notice">{{ saveNotice }}</p>
          <div class="wiki-editor-actions">
            <t-button
              size="small"
              variant="outline"
              data-testid="wiki-cancel-button"
              :disabled="saving"
              @click="cancelEdit"
            >
              Cancel
            </t-button>
            <t-button
              size="small"
              theme="primary"
              data-testid="wiki-save-button"
              :loading="saving"
              @click="confirmSave"
            >
              Save
            </t-button>
          </div>
        </div>
        <div v-else class="wiki-view-content">
          <div v-if="codeMeta" class="wiki-code-meta" data-testid="wiki-code-meta">
            <span class="wiki-code-meta-title">Code</span>
            <span v-if="codeMeta.system" class="wiki-code-tag">
              <span class="wiki-code-tag-label">system</span>
              <code>{{ codeMeta.system }}</code>
            </span>
            <span v-if="codeMeta.devclass" class="wiki-code-tag">
              <span class="wiki-code-tag-label">devclass</span>
              <code>{{ codeMeta.devclass }}</code>
            </span>
            <span v-if="codeMeta.transport" class="wiki-code-tag">
              <span class="wiki-code-tag-label">transport</span>
              <code>{{ codeMeta.transport }}</code>
            </span>
          </div>
          <p v-if="structuredLoading" class="wiki-status">Loading structured code metadata...</p>
            <!-- G4.S8.T11: per-DocType renderer when code-meta resolves; the
                 markdown rendering is the fallback for everything else. The
                 markdown node stays ALWAYS-MOUNTED (v-show, hidden behind an
                 active renderer) so the TOC-accordion watcher finds
                 `contentPane` no matter the branch. -->
            <WikiCodeRenderer
              v-if="codeRendererActive"
              :meta="structuredMeta!"
              :system="codeMeta?.system"
              :existing-paths="existingPaths"
              data-testid="wiki-code-renderer"
              @navigate="onCodeNavigate"
              @search="onCodeSearch"
            />
            <div
              v-show="!codeRendererActive && !structuredLoading"
              ref="contentPane"
              class="wiki-content"
              data-testid="wiki-content"
              v-html="renderedContent"
              @click="onContentClick"
            />
          <div v-if="searchResultsFor" class="wiki-search-results" data-testid="wiki-search-results">
            <div class="wiki-search-results-header">
              <span class="wiki-search-results-title">
                Wiki search for <code>{{ searchResultsFor }}</code>
              </span>
              <button
                type="button"
                class="wiki-search-results-close"
                aria-label="Close search results"
                @click="searchResultsFor = ''; searchResults = []; searchResultError = ''"
              >
                ×
              </button>
            </div>
            <p v-if="searchResultError" class="wiki-error">{{ searchResultError }}</p>
            <ul v-else-if="searchResults.length" class="wiki-search-result-list">
              <li v-for="(r, i) in searchResults" :key="i">
                <button
                  type="button"
                  class="wiki-search-result"
                  data-testid="wiki-search-result"
                  @click="openSearchResult(r.path ?? r.wikiPath)"
                >
                  <span class="wiki-search-result-title">{{ r.title }}</span>
                  <code v-if="r.path ?? r.wikiPath" class="wiki-search-result-path">
                    {{ r.path ?? r.wikiPath }}
                  </code>
                  <span class="wiki-search-result-snippet">{{ r.snippet }}</span>
                </button>
              </li>
            </ul>
            <p v-else class="wiki-status">
              No wiki page named "{{ searchResultsFor }}" exists; the wiki search returned no
              matches either.
            </p>
          </div>
        </div>
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

/* G3.S5.T6: heading-outline entries under the active file in the left tree —
   indented by heading level so the outline reads like the doc structure. */
.wiki-tree :deep(.wiki-heading-node) {
  color: var(--caleo-text-secondary);
  font-size: 12px;
}

.wiki-tree :deep(.wiki-heading-node:hover) {
  color: var(--caleo-primary);
}

.wiki-tree :deep(.wiki-heading-node-1) {
  padding-left: 0;
}

.wiki-tree :deep(.wiki-heading-node-2) {
  padding-left: 12px;
}

.wiki-tree :deep(.wiki-heading-node-3) {
  padding-left: 24px;
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

/* G4.S8.T7: code-metadata panel for type: code pages (system/devclass/transport) */
.wiki-view-content {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.wiki-code-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
  padding: 8px 12px;
  background: var(--caleo-surface-hover);
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
}

.wiki-code-meta-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--caleo-primary);
  margin-right: 4px;
}

.wiki-code-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--caleo-text-secondary);
}

.wiki-code-tag-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--caleo-text-secondary);
}

.wiki-code-tag code {
  padding: 2px 7px;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  color: var(--caleo-text);
}

/* G4.S8.T11: cross-link search results panel (no-dead-link fallback). */
.wiki-search-results {
  margin-top: 16px;
  padding: 10px 12px;
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  background: var(--caleo-surface-hover);
}

.wiki-search-results-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.wiki-search-results-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--caleo-text);
}

.wiki-search-results-title code {
  padding: 1px 5px;
  border-radius: 4px;
  font-family: monospace;
  font-size: 12px;
  background: var(--caleo-surface);
  color: var(--caleo-primary);
}

.wiki-search-results-close {
  padding: 0 6px;
  border: none;
  background: none;
  color: var(--caleo-text-secondary);
  font-size: 16px;
  cursor: pointer;
}

.wiki-search-results-close:hover {
  color: var(--caleo-primary);
}

.wiki-search-result-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.wiki-search-result {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  background: var(--caleo-surface);
  text-align: left;
  cursor: pointer;
}

.wiki-search-result:hover {
  border-color: var(--caleo-primary);
}

.wiki-search-result-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--caleo-text);
}

.wiki-search-result-path {
  font-size: 11px;
  color: var(--caleo-text-secondary);
}

.wiki-search-result-snippet {
  font-size: 12px;
  color: var(--caleo-text-secondary);
}

/* G4.S3.T10: inline markdown editor for a corrected wiki page. */
.wiki-editor-pane {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.wiki-editor {
  flex: 1;
  min-height: 55vh;
  padding: 12px;
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  background: var(--caleo-body-bg);
  color: var(--caleo-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 13px;
  line-height: 1.6;
  resize: vertical;
  box-sizing: border-box;
}

.wiki-editor:focus {
  outline: none;
  border-color: var(--caleo-primary);
}

.wiki-editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}

.wiki-save-notice {
  margin: 8px 0 0;
  color: var(--caleo-text-secondary);
  font-size: 13px;
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

/* G3.S5.T6: collapsed TOC sub-levels are hidden; the toggle reveals them. */
.wiki-content :deep(.wiki-toc ul.wiki-toc-collapsed) {
  display: none;
}

.wiki-content :deep(.wiki-toc a) {
  color: var(--caleo-sky);
  text-decoration: none;
}

.wiki-content :deep(.wiki-toc a:hover) {
  text-decoration: underline;
  color: var(--caleo-primary);
}

/* Accordion caret injected by initTocAccordion (G3.S5.T6). */
.wiki-content :deep(.wiki-toc-toggle) {
  margin-right: 6px;
  padding: 0 5px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--caleo-text-secondary);
  font-size: 11px;
  line-height: 1.6;
  cursor: pointer;
}

.wiki-content :deep(.wiki-toc-toggle:hover) {
  background: var(--caleo-surface-hover);
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
