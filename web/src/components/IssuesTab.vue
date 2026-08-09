<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useAuthStore } from "@/stores/auth";
import {
  fetchIssues,
  type GithubIssue,
  type GithubIssueState,
  type GithubRepo,
} from "@/api/github";

const props = defineProps<{ repo: GithubRepo | null }>();

const auth = useAuthStore();

const state = ref<GithubIssueState>("open");
const issues = ref<GithubIssue[]>([]);
const loading = ref(false);
const error = ref("");

const hasSession = computed(() => !!auth.sessionToken);

const stateFilters: { value: GithubIssueState; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

function splitRepo(repo: GithubRepo): [string, string] {
  const [owner, name] = repo.full_name.split("/");
  return [owner ?? "", name ?? repo.name];
}

function fail(err: unknown): void {
  error.value = err instanceof Error ? err.message : String(err);
}

async function loadIssues(): Promise<void> {
  const repo = props.repo;
  if (!auth.sessionToken || !repo) {
    return;
  }
  const [owner, name] = splitRepo(repo);
  loading.value = true;
  error.value = "";
  try {
    issues.value = await fetchIssues(auth.sessionToken, owner, name, state.value);
  } catch (err) {
    fail(err);
  } finally {
    loading.value = false;
  }
}

async function onRepoChange(): Promise<void> {
  issues.value = [];
  if (!props.repo) {
    return;
  }
  await loadIssues();
}

async function onStateChange(): Promise<void> {
  if (!props.repo) {
    return;
  }
  await loadIssues();
}

watch(
  () => props.repo,
  () => {
    void onRepoChange();
  },
  { immediate: true },
);

watch(state, () => {
  void onStateChange();
});
</script>

<template>
  <div class="issues-tab">
    <div v-if="!hasSession" class="issues-empty">
      <p class="issues-empty-title">Sign in to browse GitHub issues</p>
      <p class="issues-empty-hint">Log in and register a GitHub credential to see issues from your repositories.</p>
    </div>

    <div v-else-if="!props.repo" class="issues-empty">
      <p class="issues-empty-title">Select a repository</p>
      <p class="issues-empty-hint">Choose a repository from the Workbench header to view its issues.</p>
    </div>

    <template v-else>
      <div v-if="error" class="issues-error">{{ error }}</div>

      <div class="issues-header">
        <div class="issues-state-filter" role="group" aria-label="Filter issues by state">
          <button
            v-for="filter in stateFilters"
            :key="filter.value"
            class="state-filter-btn"
            :class="{ 'is-active': state === filter.value }"
            :aria-pressed="state === filter.value"
            type="button"
            @click="state = filter.value"
          >
            <span class="state-dot" :class="`state-dot-${filter.value}`" aria-hidden="true"></span>
            {{ filter.label }}
          </button>
        </div>
      </div>

      <div class="issues-list">
        <p v-if="!issues.length && !loading" class="issues-none">No issues here. Try a different state filter.</p>
        <article v-for="issue in issues" :key="issue.number" class="issue-row">
          <span class="issue-state-icon" :class="`is-${issue.state}`" :aria-label="`${issue.state} issue`">
            {{ issue.state === "open" ? "◉" : "✓" }}
          </span>
          <div class="issue-main">
            <a
              class="issue-title"
              :href="issue.html_url"
              target="_blank"
              rel="noopener noreferrer"
            >{{ issue.title }}</a>
            <div v-if="issue.labels.length" class="issue-labels">
              <span
                v-for="label in issue.labels"
                :key="label"
                class="issue-label"
              >{{ label }}</span>
            </div>
            <p class="issue-meta">
              #{{ issue.number }}
              <template v-if="issue.state === 'open'">opened</template>
              <template v-else>closed</template>
              by {{ issue.user_login ?? "unknown" }}
            </p>
          </div>
          <div v-if="issue.assignees.length" class="issue-assignees" aria-label="Assignees">
            <span v-for="assignee in issue.assignees" :key="assignee" class="issue-assignee">
              {{ assignee }}
            </span>
          </div>
        </article>
      </div>
    </template>
  </div>
</template>

<style scoped>
.issues-tab {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.issues-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--caleo-text-secondary);
}

.issues-empty-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--caleo-text);
}

.issues-empty-hint {
  margin: 0;
  font-size: 13px;
}

.issues-error {
  padding: 10px 14px;
  margin-bottom: 10px;
  font-size: 13px;
  color: var(--caleo-error);
  background: rgba(213, 73, 65, 0.08);
  border: 1px solid rgba(213, 73, 65, 0.3);
  border-radius: 6px;
}

.issues-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--caleo-border);
}

.issues-state-filter {
  display: flex;
  align-items: center;
  gap: 4px;
}

.state-filter-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: none;
  font: inherit;
  font-size: 13px;
  color: var(--caleo-text-secondary);
  cursor: pointer;
}

.state-filter-btn:hover {
  color: var(--caleo-text);
}

.state-filter-btn.is-active {
  color: var(--caleo-text);
  border-color: var(--caleo-border);
  background: rgba(127, 127, 127, 0.06);
}

.state-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.state-dot-open {
  background: #2da44e;
}

.state-dot-closed {
  background: #a371f7;
}

.state-dot-all {
  background: #8b949e;
}

.issues-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.issues-none {
  margin: 0;
  padding: 24px 16px;
  font-size: 13px;
  color: var(--caleo-text-secondary);
}

.issues-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--caleo-text-secondary);
}

.issue-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--caleo-border);
}

.issue-row:hover {
  background: rgba(127, 127, 127, 0.06);
}

.issue-state-icon {
  flex: 0 0 16px;
  margin-top: 2px;
  font-size: 15px;
  line-height: 1.2;
  text-align: center;
}

.issue-state-icon.is-open {
  color: #2da44e;
}

.issue-state-icon.is-closed {
  color: #a371f7;
}

.issue-main {
  flex: 1;
  min-width: 0;
}

.issue-title {
  display: block;
  font-size: 15px;
  font-weight: 600;
  color: var(--caleo-text);
  text-decoration: none;
}

.issue-title:hover {
  color: var(--caleo-primary);
}

.issue-labels {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}

.issue-label {
  display: inline-block;
  padding: 2px 8px;
  font-size: 11px;
  line-height: 1.4;
  color: #1f2328;
  background: #d4a72c;
  border-radius: 999px;
}

.issue-meta {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--caleo-text-secondary);
}

.issue-assignees {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  margin-top: 4px;
}

.issue-assignee {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  font-size: 12px;
  color: var(--caleo-text-secondary);
  background: rgba(127, 127, 127, 0.1);
  border-radius: 999px;
}
</style>
