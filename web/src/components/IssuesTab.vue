<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useAuthStore } from "@/stores/auth";
import {
  addIssueComment,
  fetchIssueDetail,
  fetchIssues,
  fetchLabels,
  updateIssue,
  type GithubIssue,
  type GithubIssueComment,
  type GithubIssueState,
  type GithubRepo,
} from "@/api/github";
import { renderMarkdown } from "@/kb/markdown";

const props = defineProps<{
  repo: GithubRepo | null;
  /** Issue to open/scroll to when set (Kanban 'view in Issues' action, G4.S5.T8). */
  locateIssueNumber?: number | null;
}>();

const auth = useAuthStore();

const state = ref<GithubIssueState>("open");
const issues = ref<GithubIssue[]>([]);
const loading = ref(false);
const error = ref("");

const selectedNumber = ref<number | null>(null);
const detail = ref<{ issue: GithubIssue; comments: GithubIssueComment[] } | null>(null);
const detailLoading = ref(false);
const detailError = ref("");
const repoLabels = ref<string[]>([]);

const editing = ref(false);
const editTitle = ref("");
const editBody = ref("");
const editState = ref<"open" | "closed">("open");
const editLabels = ref<string[]>([]);
const saving = ref(false);
const saveError = ref("");

const commentBody = ref("");
const commentSending = ref(false);
const commentError = ref("");

/** The issue row currently highlighted by a 'view in Issues' locate (G4.S5.T8). */
const locateHighlight = ref<number | null>(null);

/**
 * Locate bookkeeping (G4.S5.T8): `locating` suppresses the state-filter
 * watcher's reload while the locate handler drives its own load; `lastLocate`
 * dedupes repeated locates of the same issue on one mount.
 */
let locating = false;
let lastLocate = 0;

const hasSession = computed(() => !!auth.sessionToken);

const stateFilters: { value: GithubIssueState; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

/** Candidate labels for the edit picker: repo labels ∪ any label seen in the list. */
const labelOptions = computed<string[]>(() => {
  const seen = new Set<string>();
  for (const label of repoLabels.value) {
    seen.add(label);
  }
  for (const issue of issues.value) {
    for (const label of issue.labels) {
      seen.add(label);
    }
  }
  if (detail.value) {
    for (const label of detail.value.issue.labels) {
      seen.add(label);
    }
  }
  return [...seen].sort();
});

function splitRepo(repo: GithubRepo): [string, string] {
  const [owner, name] = repo.full_name.split("/");
  return [owner ?? "", name ?? repo.name];
}

function fail(err: unknown): void {
  error.value = err instanceof Error ? err.message : String(err);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

let issuesReq = 0;

async function loadIssues(): Promise<void> {
  const repo = props.repo;
  if (!auth.sessionToken || !repo) {
    return;
  }
  const [owner, name] = splitRepo(repo);
  const myReq = ++issuesReq;
  loading.value = true;
  error.value = "";
  try {
    const result = await fetchIssues(auth.sessionToken, owner, name, state.value);
    if (myReq !== issuesReq) return; // a newer load superseded this one
    issues.value = result;
  } catch (err) {
    if (myReq !== issuesReq) return;
    fail(err);
  } finally {
    if (myReq === issuesReq) loading.value = false;
  }
}

function closeDetail(): void {
  selectedNumber.value = null;
  detail.value = null;
  detailError.value = "";
  editing.value = false;
  commentBody.value = "";
  commentError.value = "";
  saveError.value = "";
}

async function loadRepoLabels(owner: string, name: string): Promise<void> {
  if (!auth.sessionToken) {
    return;
  }
  try {
    repoLabels.value = await fetchLabels(auth.sessionToken, owner, name);
  } catch {
    repoLabels.value = [];
  }
}

async function openIssue(issue: GithubIssue): Promise<void> {
  const repo = props.repo;
  if (!auth.sessionToken || !repo) {
    return;
  }
  const [owner, name] = splitRepo(repo);
  selectedNumber.value = issue.number;
  detail.value = null;
  detailError.value = "";
  editing.value = false;
  commentBody.value = "";
  commentError.value = "";
  detailLoading.value = true;
  try {
    detail.value = await fetchIssueDetail(auth.sessionToken, owner, name, issue.number);
  } catch (err) {
    detailError.value = messageOf(err);
  } finally {
    detailLoading.value = false;
  }
  void loadRepoLabels(owner, name);
}

async function onRepoChange(): Promise<void> {
  issues.value = [];
  closeDetail();
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

function enterEdit(): void {
  const current = detail.value;
  if (!current) {
    return;
  }
  editTitle.value = current.issue.title;
  editBody.value = current.issue.body ?? "";
  editState.value = current.issue.state === "closed" ? "closed" : "open";
  editLabels.value = [...current.issue.labels];
  editing.value = true;
  saveError.value = "";
}

function cancelEdit(): void {
  editing.value = false;
  saveError.value = "";
}

async function saveEdit(): Promise<void> {
  const repo = props.repo;
  const current = detail.value;
  if (!auth.sessionToken || !repo || !current) {
    return;
  }
  const [owner, name] = splitRepo(repo);
  saving.value = true;
  saveError.value = "";
  try {
    const updated = await updateIssue(auth.sessionToken, owner, name, current.issue.number, {
      title: editTitle.value,
      body: editBody.value,
      state: editState.value,
      labels: editLabels.value,
    });
    detail.value = { ...current, issue: updated };
    editing.value = false;
    void loadIssues();
  } catch (err) {
    saveError.value = messageOf(err);
  } finally {
    saving.value = false;
  }
}

async function submitComment(): Promise<void> {
  const repo = props.repo;
  const current = detail.value;
  if (!auth.sessionToken || !repo || !current) {
    return;
  }
  const text = commentBody.value.trim();
  if (!text) {
    return;
  }
  const [owner, name] = splitRepo(repo);
  commentSending.value = true;
  commentError.value = "";
  try {
    const comment = await addIssueComment(auth.sessionToken, owner, name, current.issue.number, text);
    detail.value = { ...current, comments: [...current.comments, comment] };
    commentBody.value = "";
  } catch (err) {
    commentError.value = messageOf(err);
  } finally {
    commentSending.value = false;
  }
}

function formatDate(iso: string): string {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

watch(
  () => props.repo,
  () => {
    void onRepoChange();
  },
  { immediate: true },
);

watch(state, () => {
  if (!locating) void onStateChange();
});

/**
 * Locate an issue on demand (G4.S5.T8): the Kanban detail's 'view in Issues'
 * action sets `locateIssueNumber`; when the Issues tab mounts/updates we load
 * all issues, open the target and scroll/highlight its row. Immediate so a
 * tab opened straight into the locate (lazy tab mount) still handles it.
 */
watch(
  () => props.locateIssueNumber,
  async (target) => {
    if (target == null || target === lastLocate || !auth.sessionToken || !props.repo) {
      return;
    }
    lastLocate = target;
    locateHighlight.value = target;
    locating = true;
    try {
      // The target may be open or closed — locate regardless of the filter.
      if (state.value !== "all") {
        state.value = "all";
      }
      await loadIssues();
      const issue = issues.value.find((i) => i.number === target);
      if (issue) {
        await openIssue(issue);
        await nextTick();
        document.querySelector(`.issue-row[data-number="${target}"]`)?.scrollIntoView?.({
          behavior: "smooth",
          block: "nearest",
        });
      }
    } finally {
      locating = false;
    }
    window.setTimeout(() => {
      locateHighlight.value = null;
    }, 2000);
  },
  { immediate: true },
);
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
        <article
          v-for="issue in issues"
          :key="issue.number"
          class="issue-row"
          :class="{ 'issue-row-located': locateHighlight === issue.number }"
          :data-number="issue.number"
          role="button"
          tabindex="0"
          @click="openIssue(issue)"
          @keydown.enter="openIssue(issue)"
        >
          <span class="issue-state-icon" :class="`is-${issue.state}`" :aria-label="`${issue.state} issue`">
            {{ issue.state === "open" ? "◉" : "✓" }}
          </span>
          <div class="issue-main">
            <span class="issue-title">{{ issue.title }}</span>
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

      <aside v-if="selectedNumber !== null" class="issue-detail" aria-label="Issue detail">
        <header class="issue-detail-header">
          <h2 class="issue-detail-title">Issue detail</h2>
          <button class="issue-detail-close" type="button" aria-label="Close detail" @click="closeDetail">✕</button>
        </header>

        <div class="issue-detail-scroll">
          <p v-if="detailLoading" class="issue-detail-loading">Loading issue…</p>
          <div v-else-if="detailError" class="issues-error">{{ detailError }}</div>

          <div v-else-if="detail" class="issue-detail-content">
            <!-- View mode -->
            <div v-if="!editing" class="issue-view">
              <div class="issue-view-head">
                <span class="issue-state-icon" :class="`is-${detail.issue.state}`" :aria-label="`${detail.issue.state} issue`">
                  {{ detail.issue.state === "open" ? "◉" : "✓" }}
                </span>
                <div class="issue-view-heading">
                  <h3 class="issue-view-title">{{ detail.issue.title }}</h3>
                  <p class="issue-view-meta">
                    #{{ detail.issue.number }}
                    <span class="issue-state-chip" :class="`is-${detail.issue.state}`">{{ detail.issue.state }}</span>
                    opened by {{ detail.issue.user_login ?? "unknown" }}
                  </p>
                </div>
              </div>

              <div v-if="detail.issue.labels.length" class="issue-labels">
                <span v-for="label in detail.issue.labels" :key="label" class="issue-label">{{ label }}</span>
              </div>
              <div v-if="detail.issue.assignees.length" class="issue-detail-assignees" aria-label="Assignees">
                <span v-for="assignee in detail.issue.assignees" :key="assignee" class="issue-assignee">
                  {{ assignee }}
                </span>
              </div>

              <div class="issue-body" v-html="renderMarkdown(detail.issue.body ?? '')"></div>

              <button class="issue-edit-btn" type="button" @click="enterEdit">Edit issue</button>

              <h4 class="issue-comments-title">
                Comments ({{ detail.comments.length }})
              </h4>
              <div class="issue-comments">
                <p v-if="!detail.comments.length" class="issue-no-comments">No comments yet.</p>
                <div v-for="comment in detail.comments" :key="comment.id" class="issue-comment">
                  <div class="issue-comment-head">
                    <strong>{{ comment.user_login ?? "unknown" }}</strong>
                    <span class="issue-comment-date">{{ formatDate(comment.created_at) }}</span>
                  </div>
                  <div class="issue-comment-body" v-html="renderMarkdown(comment.body)"></div>
                </div>
              </div>

              <div class="issue-comment-box">
                <textarea
                  v-model="commentBody"
                  class="issue-comment-input"
                  rows="3"
                  placeholder="Leave a comment"
                  aria-label="New comment"
                ></textarea>
                <div v-if="commentError" class="issues-error">{{ commentError }}</div>
                <div class="issue-comment-actions">
                  <button
                    class="issue-comment-submit"
                    type="button"
                    :disabled="commentSending || !commentBody.trim()"
                    @click="submitComment"
                  >
                    {{ commentSending ? "Posting…" : "Comment" }}
                  </button>
                </div>
              </div>
            </div>

            <!-- Edit mode -->
            <form v-else class="issue-edit-form" @submit.prevent="saveEdit">
              <div class="issue-edit-field">
                <label class="issue-edit-label" for="issue-edit-title">Title</label>
                <input
                  id="issue-edit-title"
                  v-model="editTitle"
                  class="issue-edit-input"
                  type="text"
                  required
                />
              </div>

              <div class="issue-edit-field">
                <label class="issue-edit-label" for="issue-edit-body">Body (markdown)</label>
                <textarea
                  id="issue-edit-body"
                  v-model="editBody"
                  class="issue-edit-input"
                  rows="8"
                ></textarea>
              </div>

              <div class="issue-edit-field">
                <label class="issue-edit-label" for="issue-edit-state">State</label>
                <select id="issue-edit-state" v-model="editState" class="issue-edit-input">
                  <option value="open">open</option>
                  <option value="closed">closed</option>
                </select>
              </div>

              <fieldset class="issue-edit-field">
                <legend class="issue-edit-label">Labels</legend>
                <div class="issue-edit-label-picker">
                  <label v-for="label in labelOptions" :key="label" class="issue-edit-label-check">
                    <input v-model="editLabels" type="checkbox" :value="label" />
                    <span>{{ label }}</span>
                  </label>
                  <p v-if="!labelOptions.length" class="issue-no-comments">No labels on this repository.</p>
                </div>
              </fieldset>

              <div v-if="saveError" class="issues-error">{{ saveError }}</div>

              <div class="issue-edit-actions">
                <button class="issue-edit-save" type="submit" :disabled="saving">
                  {{ saving ? "Saving…" : "Save" }}
                </button>
                <button class="issue-edit-cancel" type="button" :disabled="saving" @click="cancelEdit">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      </aside>
    </template>
  </div>
</template>

<style scoped>
.issues-tab {
  position: relative;
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

.issue-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--caleo-border);
  cursor: pointer;
}

.issue-row:hover {
  background: rgba(127, 127, 127, 0.06);
}

/* The row 'view in Issues' located (G4.S5.T8) — brief highlight + left accent. */
.issue-row-located {
  background: rgba(255, 102, 51, 0.1);
  box-shadow: inset 3px 0 0 var(--caleo-primary);
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
  flex-wrap: wrap;
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

.issue-detail {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(64%, 560px);
  z-index: 10;
  display: flex;
  flex-direction: column;
  background: var(--caleo-surface);
  border-left: 1px solid var(--caleo-border);
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.18);
}

.issue-detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--caleo-border);
}

.issue-detail-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--caleo-text);
}

.issue-detail-close {
  border: none;
  background: none;
  font: inherit;
  font-size: 14px;
  color: var(--caleo-text-secondary);
  cursor: pointer;
  padding: 4px;
}

.issue-detail-close:hover {
  color: var(--caleo-text);
}

.issue-detail-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px;
}

.issue-detail-loading {
  margin: 0;
  font-size: 13px;
  color: var(--caleo-text-secondary);
}

.issue-view-head {
  display: flex;
  gap: 10px;
  margin-bottom: 12px;
}

.issue-view-heading {
  flex: 1;
  min-width: 0;
}

.issue-view-title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  color: var(--caleo-text);
  line-height: 1.3;
}

.issue-view-meta {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--caleo-text-secondary);
}

.issue-state-chip {
  display: inline-block;
  padding: 1px 8px;
  margin-left: 6px;
  font-size: 11px;
  border-radius: 999px;
}

.issue-state-chip.is-open {
  color: #2da44e;
  background: rgba(45, 164, 78, 0.15);
}

.issue-state-chip.is-closed {
  color: #a371f7;
  background: rgba(163, 113, 247, 0.15);
}

.issue-detail-assignees {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
}

.issue-body {
  margin-top: 12px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--caleo-text);
  overflow-wrap: break-word;
}

.issue-body :deep(pre),
.issue-comment-body :deep(pre) {
  background: rgba(127, 127, 127, 0.1);
  padding: 10px;
  border-radius: 6px;
  overflow: auto;
}

.issue-body :deep(code),
.issue-comment-body :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
}

.issue-edit-btn {
  margin-top: 14px;
  padding: 5px 12px;
  font-size: 13px;
  color: var(--caleo-text);
  background: rgba(127, 127, 127, 0.1);
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  cursor: pointer;
}

.issue-edit-btn:hover {
  background: rgba(127, 127, 127, 0.16);
}

.issue-comments-title {
  margin: 20px 0 10px;
  font-size: 14px;
  font-weight: 600;
  color: var(--caleo-text);
}

.issue-comments {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.issue-no-comments {
  margin: 0;
  font-size: 13px;
  color: var(--caleo-text-secondary);
}

.issue-comment {
  padding: 10px 12px;
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.06);
}

.issue-comment-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
  color: var(--caleo-text);
}

.issue-comment-date {
  font-size: 12px;
  color: var(--caleo-text-secondary);
}

.issue-comment-body {
  margin-top: 6px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--caleo-text-secondary);
  overflow-wrap: break-word;
}

.issue-comment-box {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.issue-comment-input,
.issue-edit-input {
  width: 100%;
  padding: 8px 10px;
  font: inherit;
  font-size: 13px;
  color: var(--caleo-text);
  background: var(--caleo-body-bg);
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  resize: vertical;
}

.issue-comment-input:focus,
.issue-edit-input:focus {
  outline: none;
  border-color: var(--caleo-primary);
}

.issue-comment-actions {
  display: flex;
  justify-content: flex-end;
}

.issue-comment-submit,
.issue-edit-save {
  padding: 5px 14px;
  font-size: 13px;
  color: #fff;
  background: var(--caleo-primary);
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.issue-comment-submit:disabled,
.issue-edit-save:disabled {
  opacity: 0.6;
  cursor: default;
}

.issue-edit-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.issue-edit-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  border: none;
}

.issue-edit-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--caleo-text);
}

.issue-edit-label-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.issue-edit-label-check {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  font-size: 13px;
  color: var(--caleo-text);
  background: rgba(127, 127, 127, 0.08);
  border: 1px solid var(--caleo-border);
  border-radius: 999px;
  cursor: pointer;
}

.issue-edit-actions {
  display: flex;
  gap: 8px;
}

.issue-edit-cancel {
  padding: 5px 14px;
  font-size: 13px;
  color: var(--caleo-text);
  background: rgba(127, 127, 127, 0.1);
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  cursor: pointer;
}

.issue-edit-cancel:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
