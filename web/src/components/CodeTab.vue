<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import CodeTreeNode from "./CodeTreeNode.vue";
import { useAuthStore } from "@/stores/auth";
import {
  fetchBranches,
  fetchFileContent,
  fetchRepos,
  fetchTree,
  type GithubRepo,
} from "@/api/github";
import { buildTree, type TreeNode } from "@/github/tree";
import { detectLanguage, renderCodeLines } from "@/github/highlight";

const auth = useAuthStore();

const repos = ref<GithubRepo[]>([]);
const repoValue = ref("");
const branches = ref<string[]>([]);
const branch = ref("");
const tree = ref<TreeNode[]>([]);
const selectedFile = ref<TreeNode | null>(null);
const contentLines = ref<string[]>([]);
const language = ref("plaintext");
const loading = ref(false);
const error = ref("");

const hasSession = computed(() => !!auth.sessionToken);

const selectedRepo = computed(() => repos.value.find((repo) => repo.full_name === repoValue.value) ?? null);

const repoOptions = computed(() => repos.value.map((repo) => ({ label: repo.name, value: repo.full_name })));
const branchOptions = computed(() => branches.value.map((name) => ({ label: name, value: name })));

/** True while onRepoChange sets the branch programmatically (skip the branch watcher). */
let syncingBranch = false;

function splitRepo(repo: GithubRepo): [string, string] {
  const [owner, name] = repo.full_name.split("/");
  return [owner ?? "", name ?? repo.name];
}

function fail(err: unknown): void {
  error.value = err instanceof Error ? err.message : String(err);
}

async function loadRepos(): Promise<void> {
  if (!auth.sessionToken) {
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    repos.value = await fetchRepos(auth.sessionToken);
  } catch (err) {
    fail(err);
  } finally {
    loading.value = false;
  }
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

async function onRepoChange(): Promise<void> {
  selectedFile.value = null;
  contentLines.value = [];
  branches.value = [];
  tree.value = [];
  const repo = selectedRepo.value;
  if (!repo) {
    return;
  }
  syncingBranch = true;
  branch.value = repo.default_branch;
  syncingBranch = false;
  await loadRepo(repo, branch.value);
  if (branches.value.length && !branches.value.includes(branch.value)) {
    branch.value = branches.value[0]!;
  }
}

async function onBranchChange(ref: string): Promise<void> {
  const repo = selectedRepo.value;
  if (!repo || !ref) {
    return;
  }
  selectedFile.value = null;
  contentLines.value = [];
  await loadRepo(repo, ref);
}

async function openFile(node: TreeNode): Promise<void> {
  const repo = selectedRepo.value;
  if (!auth.sessionToken || !repo || node.type !== "blob") {
    return;
  }
  selectedFile.value = node;
  language.value = detectLanguage(node.path);
  contentLines.value = [];
  loading.value = true;
  error.value = "";
  const [owner, name] = splitRepo(repo);
  try {
    const file = await fetchFileContent(auth.sessionToken, owner, name, node.path, branch.value || undefined);
    contentLines.value = renderCodeLines(file.content, language.value);
  } catch (err) {
    fail(err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void loadRepos();
});

watch(repoValue, () => {
  void onRepoChange();
});

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

    <template v-else>
      <div v-if="error" class="code-error">{{ error }}</div>

      <div class="code-layout">
        <aside class="code-sidebar">
          <t-select
            class="repo-select"
            v-model="repoValue"
            :options="repoOptions"
            :loading="loading"
            placeholder="Select a repository"
            size="small"
          />
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
            <p v-if="!tree.length && !loading" class="tree-empty">No repositories loaded.</p>
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
            <span v-if="selectedFile" class="code-file-lang">{{ language }}</span>
          </header>

          <div v-if="!selectedFile" class="code-placeholder">Select a file to view its contents</div>

          <div v-else class="code-lines" :aria-label="selectedFile.path">
            <div v-for="(line, index) in contentLines" :key="index" class="code-line-row">
              <span class="code-line-number">{{ index + 1 }}</span>
              <code class="code-line-content" v-html="line" />
            </div>
          </div>
        </section>
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
  color: #d54941;
  background: rgba(213, 73, 65, 0.08);
  border: 1px solid rgba(213, 73, 65, 0.3);
  border-radius: 6px;
}

.code-layout {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 12px;
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
