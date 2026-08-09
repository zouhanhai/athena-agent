<script setup lang="ts">
import { computed, ref, watch } from "vue";
import CodeTreeNode from "./CodeTreeNode.vue";
import { useAuthStore } from "@/stores/auth";
import {
  fetchBranches,
  fetchCommits,
  fetchFileContent,
  fetchTree,
  type GithubCommit,
  type GithubRepo,
} from "@/api/github";
import { buildTree, type TreeNode } from "@/github/tree";
import { detectLanguage, renderCodeLines } from "@/github/highlight";
import { renderMarkdown } from "@/kb/markdown";

const props = defineProps<{ repo: GithubRepo | null }>();

const auth = useAuthStore();

const branches = ref<string[]>([]);
const branch = ref("");
const tree = ref<TreeNode[]>([]);
const selectedFile = ref<TreeNode | null>(null);
const contentLines = ref<string[]>([]);
const content = ref("");
const language = ref("plaintext");
const loading = ref(false);
const error = ref("");

const commits = ref<GithubCommit[]>([]);
const commitsLoading = ref(false);
const commitsError = ref("");
const commitsCollapsed = ref(false);

const hasSession = computed(() => !!auth.sessionToken);

const branchOptions = computed(() => branches.value.map((name) => ({ label: name, value: name })));

/** The selected branch's HEAD commit (commits[0]); shown prominently in the code header. */
const headCommit = computed(() => commits.value[0] ?? null);

/** True when the open file is markdown, so the Code/Preview toggle shows. */
const isMarkdownFile = computed(
  () => selectedFile.value?.type === "blob" && /\.md$/i.test(selectedFile.value.path),
);

const renderedMarkdown = computed(() => renderMarkdown(content.value));

const viewMode = ref<"code" | "preview">("code");

/** Commits rendered in the side panel: the full history, or just HEAD when collapsed. */
const visibleCommits = computed(() =>
  commitsCollapsed.value ? commits.value.slice(0, 1) : commits.value,
);

/** True while onRepoChange sets the branch programmatically (skip the branch watcher). */
let syncingBranch = false;

function splitRepo(repo: GithubRepo): [string, string] {
  const [owner, name] = repo.full_name.split("/");
  return [owner ?? "", name ?? repo.name];
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function fail(err: unknown): void {
  error.value = err instanceof Error ? err.message : String(err);
}

async function loadRepo(repo: GithubRepo, ref: string): Promise<void> {
  if (!auth.sessionToken) {
    return;
  }
  const [owner, name] = splitRepo(repo);
  loading.value = true;
  error.value = "";
  try {
    const [branchList, treeEntries] = await Promise.all([
      fetchBranches(auth.sessionToken, owner, name),
      fetchTree(auth.sessionToken, owner, name, ref),
    ]);
    branches.value = branchList.map((item) => item.name);
    tree.value = buildTree(treeEntries);
  } catch (err) {
    fail(err);
  } finally {
    loading.value = false;
  }
}

async function loadCommits(repo: GithubRepo, ref: string): Promise<void> {
  if (!auth.sessionToken) {
    return;
  }
  const [owner, name] = splitRepo(repo);
  commitsLoading.value = true;
  commitsError.value = "";
  try {
    commits.value = await fetchCommits(auth.sessionToken, owner, name, ref);
  } catch (err) {
    commitsError.value = err instanceof Error ? err.message : String(err);
  } finally {
    commitsLoading.value = false;
  }
}

async function onRepoChange(): Promise<void> {
  selectedFile.value = null;
  contentLines.value = [];
  content.value = "";
  viewMode.value = "code";
  branches.value = [];
  tree.value = [];
  commits.value = [];
  const repo = props.repo;
  if (!repo) {
    return;
  }
  syncingBranch = true;
  branch.value = repo.default_branch;
  syncingBranch = false;
  await Promise.all([loadRepo(repo, branch.value), loadCommits(repo, branch.value)]);
  if (branches.value.length && !branches.value.includes(branch.value)) {
    branch.value = branches.value[0]!;
  }
}

async function onBranchChange(ref: string): Promise<void> {
  const repo = props.repo;
  if (!repo || !ref) {
    return;
  }
  selectedFile.value = null;
  contentLines.value = [];
  content.value = "";
  viewMode.value = "code";
  await Promise.all([loadRepo(repo, ref), loadCommits(repo, ref)]);
}

/** Manual refresh only — never poll, to avoid GitHub API cost/rate-limits. */
async function refreshCommits(): Promise<void> {
  if (!props.repo) {
    return;
  }
  await loadCommits(props.repo, branch.value);
}

async function openFile(node: TreeNode): Promise<void> {
  const repo = props.repo;
  if (!auth.sessionToken || !repo || node.type !== "blob") {
    return;
  }
  selectedFile.value = node;
  language.value = detectLanguage(node.path);
  contentLines.value = [];
  content.value = "";
  viewMode.value = "code";
  loading.value = true;
  error.value = "";
  const [owner, name] = splitRepo(repo);
  try {
    const file = await fetchFileContent(auth.sessionToken, owner, name, node.path, branch.value || undefined);
    content.value = file.content;
    contentLines.value = renderCodeLines(file.content, language.value);
  } catch (err) {
    fail(err);
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.repo,
  () => {
    void onRepoChange();
  },
  { immediate: true },
);

watch(
  branch,
  (next, prev) => {
    if (syncingBranch || next === prev) {
      return;
    }
    void onBranchChange(next);
  },
  { flush: "sync" },
);
</script>

<template>
  <div class="code-tab">
    <div v-if="!hasSession" class="code-empty">
      <p class="code-empty-title">Sign in to browse GitHub</p>
      <p class="code-empty-hint">Log in and register a GitHub credential to see your repositories.</p>
    </div>

    <div v-else-if="!repo" class="code-empty">
      <p class="code-empty-title">Select a repository</p>
      <p class="code-empty-hint">Choose a repository from the Workbench header to browse its code.</p>
    </div>

    <template v-else>
      <div v-if="error" class="code-error">{{ error }}</div>

      <div class="code-layout">
        <aside class="code-sidebar">
          <div v-if="branches.length" class="branch-row">
            <span class="branch-label">Branch</span>
            <t-select
              class="branch-select"
              v-model="branch"
              :options="branchOptions"
              size="small"
            />
          </div>
          <nav class="code-tree" aria-label="Repository file tree">
            <p v-if="!tree.length && !loading" class="tree-empty">No files loaded.</p>
            <CodeTreeNode
              v-for="node in tree"
              :key="node.path"
              :node="node"
              @open="openFile"
            />
          </nav>
        </aside>

        <section class="code-view">
          <header class="code-view-header">
            <span class="code-file-path">{{ selectedFile?.path ?? "Select a file" }}</span>
            <span v-if="headCommit" class="code-head">
              <a
                class="code-head-sha"
                :href="headCommit.html_url"
                target="_blank"
                rel="noopener noreferrer"
              >{{ shortSha(headCommit.sha) }}</a>
              <span class="code-head-message" :title="headCommit.message">{{ headCommit.message }}</span>
            </span>
            <span v-if="selectedFile && isMarkdownFile" class="md-toggle">
              <button
                type="button"
                class="md-toggle-btn"
                :class="{ 'is-active': viewMode === 'code' }"
                @click="viewMode = 'code'"
              >Code</button>
              <button
                type="button"
                class="md-toggle-btn"
                :class="{ 'is-active': viewMode === 'preview' }"
                @click="viewMode = 'preview'"
              >Preview</button>
            </span>
            <button
              type="button"
              class="commits-toggle"
              :aria-expanded="commitsCollapsed ? 'false' : 'true'"
              :title="commitsCollapsed ? 'Show commit history' : 'Hide commit history'"
              @click="commitsCollapsed = !commitsCollapsed"
            >
              <span v-if="commitsCollapsed" class="commits-caret">▸</span>
              <span v-else class="commits-caret">▾</span>
              {{ commitsCollapsed ? "Commits" : "Hide Commits" }}
            </button>
            <span v-if="selectedFile" class="code-file-lang">{{ language }}</span>
          </header>

          <div v-if="!selectedFile" class="code-placeholder">Select a file to view its contents</div>

          <div v-else-if="isMarkdownFile && viewMode === 'preview'" class="md-preview" :aria-label="selectedFile.path">
            <div class="md-preview-body" v-html="renderedMarkdown" />
          </div>

          <div v-else class="code-lines" :aria-label="selectedFile.path">
            <div v-for="(line, index) in contentLines" :key="index" class="code-line-row">
              <span class="code-line-number">{{ index + 1 }}</span>
              <code class="code-line-content" v-html="line" />
            </div>
          </div>
        </section>

        <aside class="commits-panel" :class="{ 'is-collapsed': commitsCollapsed }" aria-label="Recent commits">
          <header class="commits-panel-header">
            <span class="commits-panel-title">Commits</span>
            <div class="commits-panel-actions">
              <button
                type="button"
                class="commits-refresh"
                :disabled="commitsLoading"
                @click="refreshCommits"
              >Refresh</button>
            </div>
          </header>
          <div v-if="commitsError" class="commits-error">{{ commitsError }}</div>
          <p v-if="!commits.length && !commitsLoading && !commitsError" class="commits-empty">
            No commits.
          </p>
          <div class="commits-list">
            <article v-for="commit in visibleCommits" :key="commit.sha" class="commit-row">
              <a
                class="commit-sha"
                :href="commit.html_url"
                target="_blank"
                rel="noopener noreferrer"
              >{{ shortSha(commit.sha) }}</a>
              <span class="commit-message" :title="commit.message">{{ commit.message }}</span>
              <span class="commit-meta">
                {{ commit.author_name || "unknown" }} · {{ commit.date.slice(0, 10) }}
              </span>
            </article>
          </div>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped>
.code-tab {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.code-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--caleo-text-secondary);
}

.code-empty-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--caleo-text);
}

.code-empty-hint {
  margin: 0;
  font-size: 13px;
}

.code-error {
  padding: 10px 14px;
  margin-bottom: 10px;
  font-size: 13px;
  color: var(--caleo-error);
  background: rgba(213, 73, 65, 0.08);
  border: 1px solid rgba(213, 73, 65, 0.3);
  border-radius: 6px;
}

.code-layout {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 0;
}

.code-sidebar {
  width: 260px;
  min-width: 220px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  overflow: auto;
  border-right: 1px solid var(--caleo-border);
}

.branch-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.branch-label {
  font-size: 12px;
  color: var(--caleo-text-secondary);
  white-space: nowrap;
}

.code-tree {
  flex: 1;
  min-height: 0;
  overflow: auto;
  font-size: 13px;
}

.tree-empty {
  margin: 8px 0;
  font-size: 13px;
  color: var(--caleo-text-secondary);
}

.code-view {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.code-view-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--caleo-border);
}

.code-file-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  color: var(--caleo-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.code-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.code-head-sha {
  flex: 0 0 auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  font-weight: 600;
  color: var(--caleo-primary);
  text-decoration: none;
}

.code-head-message {
  min-width: 0;
  font-size: 12px;
  color: var(--caleo-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.code-file-lang {
  font-size: 12px;
  color: var(--caleo-text-secondary);
}

.code-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--caleo-text-secondary);
}

.code-lines {
  flex: 1;
  overflow: auto;
  padding: 8px 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.5;
}

.md-preview {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px 20px;
  color: var(--caleo-text);
  font-size: 14px;
  line-height: 1.7;
  word-break: break-word;
}

.md-preview-body :deep(h1),
.md-preview-body :deep(h2),
.md-preview-body :deep(h3),
.md-preview-body :deep(h4) {
  margin: 1.2em 0 0.5em;
  color: var(--caleo-text);
  font-weight: 600;
  border-bottom: 1px solid var(--caleo-border);
  padding-bottom: 0.3em;
}

.md-preview-body :deep(h1) {
  font-size: 22px;
}

.md-preview-body :deep(h2) {
  font-size: 19px;
}

.md-preview-body :deep(h3) {
  font-size: 16px;
}

.md-preview-body :deep(a) {
  color: var(--caleo-sky);
  text-decoration: none;
}

.md-preview-body :deep(a:hover) {
  text-decoration: underline;
}

.md-preview-body :deep(code) {
  padding: 2px 5px;
  border-radius: 4px;
  font-family: monospace;
  font-size: 13px;
  background: var(--caleo-surface-hover);
  color: var(--caleo-primary);
}

.md-preview-body :deep(pre) {
  padding: 12px;
  border-radius: 6px;
  overflow-x: auto;
  background: var(--caleo-body-bg);
  border: 1px solid var(--caleo-border);
}

.md-preview-body :deep(pre code) {
  padding: 0;
  background: transparent;
  color: var(--caleo-text);
}

.md-preview-body :deep(blockquote) {
  margin: 1em 0;
  padding: 4px 12px;
  border-left: 3px solid var(--caleo-primary);
  background: var(--caleo-surface-hover);
  color: var(--caleo-text-secondary);
}

.md-preview-body :deep(ul),
.md-preview-body :deep(ol) {
  padding-left: 1.5em;
  margin: 0.5em 0;
}

.md-preview-body :deep(li) {
  margin: 0.2em 0;
}

.md-preview-body :deep(table) {
  border-collapse: collapse;
  margin: 1em 0;
  width: 100%;
}

.md-preview-body :deep(th),
.md-preview-body :deep(td) {
  padding: 6px 10px;
  border: 1px solid var(--caleo-border);
  text-align: left;
}

.md-preview-body :deep(th) {
  background: var(--caleo-surface-hover);
  font-weight: 600;
}

.md-preview-body :deep(hr) {
  border: none;
  border-top: 1px solid var(--caleo-border);
  margin: 1.5em 0;
}

.md-toggle {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  overflow: hidden;
}

.md-toggle-btn {
  padding: 3px 10px;
  font: inherit;
  font-size: 12px;
  color: var(--caleo-text-secondary);
  background: var(--caleo-surface);
  border: none;
  cursor: pointer;
}

.md-toggle-btn:hover:not(.is-active) {
  color: var(--caleo-primary);
}

.md-toggle-btn.is-active {
  color: var(--caleo-primary);
  background: var(--caleo-surface-hover);
}

.code-line-row {
  display: flex;
  padding-right: 12px;
}

.code-line-row:hover {
  background: rgba(127, 127, 127, 0.06);
}

.code-line-number {
  flex: 0 0 3.5em;
  padding-right: 12px;
  text-align: right;
  color: var(--caleo-text-secondary);
  user-select: none;
}

.code-line-content {
  white-space: pre;
  color: var(--caleo-text);
}

.code-line-content :deep(.tok-comment) {
  color: #8b949e;
}

.code-line-content :deep(.tok-string) {
  color: #a5d6ff;
}

.code-line-content :deep(.tok-keyword) {
  color: #ff7b72;
  font-weight: 500;
}

.code-line-content :deep(.tok-type) {
  color: #79c0ff;
}

.code-line-content :deep(.tok-number) {
  color: #79c0ff;
}

.code-line-content :deep(.tok-constant) {
  color: #d2a8ff;
}

.code-line-content :deep(.tok-tag) {
  color: #7ee787;
}

.commits-panel {
  width: 300px;
  min-width: 240px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--caleo-border);
}

.commits-panel.is-collapsed {
  display: none;
}

.commits-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--caleo-border);
}

.commits-panel-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--caleo-text);
}

.commits-panel-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.commits-toggle {
  padding: 3px 8px;
  font: inherit;
  font-size: 12px;
  color: var(--caleo-text-secondary);
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  cursor: pointer;
}

.commits-toggle:hover:not(:disabled) {
  border-color: var(--caleo-primary);
  color: var(--caleo-primary);
}

.commits-caret {
  display: inline-block;
  font-size: 11px;
}

.commits-refresh {
  padding: 3px 10px;
  font: inherit;
  font-size: 12px;
  color: var(--caleo-text);
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  cursor: pointer;
}

.commits-refresh:hover:not(:disabled) {
  border-color: var(--caleo-primary);
  color: var(--caleo-primary);
}

.commits-refresh:disabled {
  opacity: 0.6;
  cursor: default;
}

.commits-error {
  margin: 8px 12px 0;
  font-size: 12px;
  color: var(--caleo-error);
}

.commits-empty {
  margin: 0;
  padding: 12px;
  font-size: 12px;
  color: var(--caleo-text-secondary);
}

.commits-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 4px 0;
}

.commit-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--caleo-border);
}

.commit-row:hover {
  background: rgba(127, 127, 127, 0.06);
}

.commit-sha {
  align-self: flex-start;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 600;
  color: var(--caleo-primary);
  text-decoration: none;
}

.commit-message {
  font-size: 13px;
  color: var(--caleo-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.commit-meta {
  font-size: 11px;
  color: var(--caleo-text-secondary);
}

.code-tab :deep(.tree-row) {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 3px 6px;
  background: none;
  border: none;
  border-radius: 4px;
  font: inherit;
  color: var(--caleo-text);
  cursor: pointer;
  text-align: left;
}

.code-tab :deep(.tree-row:hover) {
  background: rgba(127, 127, 127, 0.1);
}

.code-tab :deep(.tree-caret) {
  flex: 0 0 12px;
  font-size: 11px;
  color: var(--caleo-text-secondary);
}

.code-tab :deep(.tree-name) {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.code-tab :deep(.tree-size) {
  font-size: 11px;
  color: var(--caleo-text-secondary);
}

.code-tab :deep(.tree-children) {
  margin-left: 14px;
  border-left: 1px solid var(--caleo-border);
}

.code-tab :deep(.tree-children-hidden) {
  display: none;
}
</style>
