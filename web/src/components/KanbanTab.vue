<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useAuthStore } from "@/stores/auth";
import { fetchFileContent, type GithubIssueComment, type GithubRepo } from "@/api/github";
import {
  fetchBoard,
  fetchGithubIssueComments,
  fetchGithubProjectBoard,
  TICKET_STATUSES,
  type GithubProjectBoard,
  type GithubProjectCard,
  type KanbanIndex,
  type KanbanIndexSpec,
  type KanbanIndexTicket,
  type TicketStatus,
} from "@/api/kanban";
import { updatedAgoText, isStalled } from "@/kanban/progress";
import { parseTicketMd, type ParsedTicket } from "@/kanban/ticket-md";
import { renderMarkdown } from "@/kb/markdown";

const props = defineProps<{ repo: GithubRepo | null }>();

const auth = useAuthStore();

const board = ref<KanbanIndex | null>(null);
const loading = ref(false);
const error = ref("");
const lastRefresh = ref("");

/** Which board the tab shows: the local md board or the synced GitHub Project (G4.S5.T4). */
type KanbanView = "local" | "github";
const view = ref<KanbanView>("local");

/** The synced GitHub Project board for the selected repo (GitHub view). */
const projectBoard = ref<GithubProjectBoard | null>(null);
const projectLoading = ref(false);
const projectRefreshed = ref("");

/** The status column currently expanded (clicked to widen); null = all equal-width. */
const expandedStatus = ref<TicketStatus | null>(null);

/** Toggle a column's expansion; clicking the same column again collapses all. */
function toggleColumn(status: TicketStatus): void {
  expandedStatus.value = expandedStatus.value === status ? null : status;
}

/** Grid columns: expanded column gets a wide fraction, others narrow; else all 1fr. */
const columnsGrid = computed(() => {
  if (!expandedStatus.value) return {};
  // minmax(0, ...) so the `auto` minimum width (content) never stretches a narrow
  // column — otherwise the done column (many cards) widens even when collapsed.
  const cols = TICKET_STATUSES.map(
    (s) => `minmax(0, ${s === expandedStatus.value ? "3.75fr" : "0.5fr"})`,
  ).join(" ");
  return { gridTemplateColumns: cols };
});

/** Live clock for the 'updated Xs ago' label — ticks so a card visibly goes stale. */
const now = ref(Date.now());
let nowTimer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  nowTimer = setInterval(() => {
    now.value = Date.now();
  }, 10_000);
});

onUnmounted(() => {
  if (nowTimer) clearInterval(nowTimer);
  nowTimer = undefined;
});

const hasSession = computed(() => !!auth.sessionToken);

/** Where the board comes from: the selected repo, or the local athena repo when none is chosen. */
const boardSource = computed(() => (props.repo ? props.repo.full_name : "athena-agent (local)"));

interface BoardCard {
  ref: string;
  specRef: string;
  ticket: KanbanIndexTicket;
}

const cards = computed<BoardCard[]>(() => {
  const out: BoardCard[] = [];
  for (const goal of board.value?.goals ?? []) {
    if (hiddenGoals.value.has(goal.ref)) continue; // user unchecked this goal → hide its tickets
    for (const spec of goal.specs) {
      for (const ticket of spec.tickets) {
        out.push({ ref: ticket.ref, specRef: spec.ref, ticket });
      }
    }
  }
  return out;
});

/** Goals the user has unchecked (their tickets are hidden from the board below). */
const hiddenGoals = ref<Set<string>>(new Set());

function toggleGoal(ref: string): void {
  const next = new Set(hiddenGoals.value);
  if (next.has(ref)) next.delete(ref);
  else next.add(ref);
  hiddenGoals.value = next;
}

function statusLabel(status: TicketStatus): string {
  return status.replace("_", " ");
}

function cardsFor(status: TicketStatus): BoardCard[] {
  return cards.value.filter((card) => card.ticket.status === status);
}

/** Spec titles carry their own "G1.S1: " ref prefix in the md files; the badge already shows the ref. */
function specTitle(spec: KanbanIndexSpec): string {
  const prefix = `${spec.ref}:`;
  return spec.title.startsWith(prefix) ? spec.title.slice(prefix.length).trim() : spec.title;
}

function fail(err: unknown): void {
  error.value = err instanceof Error ? err.message : String(err);
}

async function loadBoard(rescan = false): Promise<void> {
  if (!auth.sessionToken) {
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    board.value = await fetchBoard(auth.sessionToken, props.repo?.full_name, rescan);
    lastRefresh.value = board.value.generated_at
      ? new Date(board.value.generated_at).toLocaleTimeString()
      : new Date().toLocaleTimeString();
  } catch (err) {
    fail(err);
  } finally {
    loading.value = false;
  }
}

/** Load the selected repo's synced GitHub Project board (GitHub view only). */
async function loadProject(): Promise<void> {
  if (!auth.sessionToken || !props.repo) {
    return;
  }
  projectLoading.value = true;
  error.value = "";
  try {
    projectBoard.value = await fetchGithubProjectBoard(auth.sessionToken, props.repo.full_name);
    projectRefreshed.value = projectBoard.value.generated_at
      ? new Date(projectBoard.value.generated_at).toLocaleTimeString()
      : new Date().toLocaleTimeString();
  } catch (err) {
    fail(err);
  } finally {
    projectLoading.value = false;
  }
}

// ---------------------------------------------------------------------------
// Local detail panel (G4.S5.T4): clicking a GitHub-view card opens a drawer
// with the ticket's md (frontmatter + description + Progress Log) pulled from
// the repo, plus the GitHub issue comment thread — no GitHub redirect.
// ---------------------------------------------------------------------------

const detailCard = ref<GithubProjectCard | null>(null);
const detailMd = ref<ParsedTicket | null>(null);
const detailComments = ref<GithubIssueComment[] | null>(null);
const detailLoading = ref(false);
const detailError = ref("");

/** Map a ref parsed off a GitHub issue title to its md file in the repo. */
function mdPathForRef(ref: string | null): string | null {
  if (!ref) {
    return null;
  }
  if (/^G\d+\.S\d+\.T\d+$/.test(ref)) {
    return `docs/kanban/${ref.replace(/\./g, "/")}.md`;
  }
  if (/^G\d+\.S\d+$/.test(ref)) {
    return `docs/kanban/${ref.replace(/\./g, "/")}/Spec.md`;
  }
  return null;
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** Open the local detail panel for a GitHub-view card and load its content. */
async function openDetail(card: GithubProjectCard): Promise<void> {
  detailCard.value = card;
  detailMd.value = null;
  detailComments.value = null;
  detailError.value = "";
  if (!auth.sessionToken || !props.repo) {
    return;
  }
  const [owner, repo] = props.repo.full_name.split("/");
  detailLoading.value = true;
  try {
    const mdPath = mdPathForRef(card.ref);
    let parsed: ParsedTicket | null = null;
    if (mdPath) {
      try {
        const file = await fetchFileContent(auth.sessionToken, owner, repo, mdPath);
        parsed = parseTicketMd(file.content);
      } catch {
        // md unavailable in the repo — the panel still shows the GitHub comments.
        parsed = null;
      }
    }
    detailMd.value = parsed;
    detailComments.value = await fetchGithubIssueComments(auth.sessionToken, props.repo.full_name, card.issueNumber);
  } catch (err) {
    detailError.value = err instanceof Error ? err.message : String(err);
  } finally {
    detailLoading.value = false;
  }
}

function closeDetail(): void {
  detailCard.value = null;
  detailMd.value = null;
  detailComments.value = null;
  detailError.value = "";
}

/** Switch the tab's view; the GitHub view fetches on first entry. */
function setView(next: KanbanView): void {
  view.value = next;
}

/** Refresh the active view: rescan the local board, or re-pull the GitHub Project. */
function refresh(): void {
  if (view.value === "github") {
    void loadProject();
  } else {
    void loadBoard(true);
  }
}

/** Toolbar status line reflects the active view. */
const activeStatus = computed(() => {
  if (view.value === "github") {
    if (projectLoading.value) return "Syncing from GitHub…";
    if (projectRefreshed.value) return `Synced ${projectRefreshed.value}`;
    return "";
  }
  if (loading.value) return "Scanning docs/kanban…";
  if (lastRefresh.value) return `Refreshed ${lastRefresh.value}`;
  return "";
});

/** Refresh button label reflects the active view. */
const refreshLabel = computed(() => {
  if (view.value === "github") {
    return projectLoading.value ? "Syncing…" : "Refresh";
  }
  return loading.value ? "Scanning…" : "Refresh";
});

watch(
  () => props.repo,
  () => {
    void loadBoard();
    if (view.value === "github") {
      void loadProject();
    }
  },
  { immediate: true },
);

watch(view, (next) => {
  error.value = "";
  if (next === "github") {
    void loadProject();
  }
});
</script>

<template>
  <div class="kanban-tab">
    <div v-if="!hasSession" class="kanban-empty">
      <p class="kanban-empty-title">Sign in to view the board</p>
      <p class="kanban-empty-hint">Log in to see Goals, Specs and Tickets scanned from the repo.</p>
    </div>

    <template v-else>
      <div class="kanban-toolbar">
        <div class="kanban-toolbar-left">
          <span class="kanban-source">{{ boardSource }}</span>
          <span
            v-if="activeStatus"
            class="kanban-scan-status"
            :class="{ 'kanban-refreshed': view === 'local' && !loading }"
            aria-live="polite"
          >
            <span v-if="loading || projectLoading" class="kanban-spinner" aria-hidden="true" />
            {{ activeStatus }}
          </span>
        </div>
        <div class="kanban-toolbar-right">
          <div class="kanban-view-toggle" role="group" aria-label="Kanban view">
            <button
              type="button"
              class="kanban-view-toggle-btn kanban-view-toggle-local"
              :class="{ 'kanban-view-toggle-active': view === 'local' }"
              :aria-pressed="view === 'local'"
              @click="setView('local')"
            >
              Local kanban
            </button>
            <button
              type="button"
              class="kanban-view-toggle-btn kanban-view-toggle-github"
              :class="{ 'kanban-view-toggle-active': view === 'github' }"
              :aria-pressed="view === 'github'"
              @click="setView('github')"
            >
              GitHub Project
            </button>
          </div>
          <button
            type="button"
            class="kanban-refresh"
            :disabled="loading || projectLoading"
            @click="refresh"
          >
            <span v-if="loading || projectLoading" class="kanban-spinner kanban-spinner-inline" aria-hidden="true" />
            {{ refreshLabel }}
          </button>
        </div>
      </div>

      <div v-if="error" class="kanban-error">{{ error }}</div>

      <template v-if="view === 'local'">
        <template v-if="board">
        <div class="kanban-tree" aria-label="Goals and Specs">
          <div v-for="goal in board.goals" :key="goal.ref" class="kanban-goal">
            <label
              class="kanban-goal-check"
              :title="hiddenGoals.has(goal.ref) ? 'Show this goal\'s tickets' : 'Hide this goal\'s tickets'"
            >
              <input
                type="checkbox"
                :checked="!hiddenGoals.has(goal.ref)"
                @change="toggleGoal(goal.ref)"
              />
            </label>
            <div class="kanban-goal-main">
              <span class="kanban-goal-ref">{{ goal.ref }}</span>
              <span class="kanban-goal-title" :title="goal.title">{{ goal.title }}</span>
            </div>
            <div class="kanban-goal-specs">
              <span v-for="spec in goal.specs" :key="spec.ref" class="kanban-spec">
                <span class="kanban-spec-ref">{{ spec.ref }}</span>
                <span class="kanban-spec-title" :title="specTitle(spec)">{{ specTitle(spec) }}</span>
              </span>
            </div>
          </div>
        </div>

        <div class="kanban-columns" :style="columnsGrid">
          <section
            v-for="status in TICKET_STATUSES"
            :key="status"
            class="kanban-column"
            :class="[`kanban-column-${status}`, { 'kanban-column-expanded': expandedStatus === status }]"
          >
            <header class="kanban-column-header" role="button" tabindex="0" @click="toggleColumn(status)">
              <span class="kanban-column-title">{{ statusLabel(status) }}</span>
              <span class="kanban-column-count">{{ cardsFor(status).length }}</span>
            </header>
            <div class="kanban-column-body">
              <article v-for="card in cardsFor(status)" :key="card.ref" class="kanban-card">
                <span class="kanban-card-ref">{{ card.ref }}</span>
                <span class="kanban-card-title">{{ card.ticket.title }}</span>
                <span class="kanban-card-spec">{{ card.specRef }}</span>
                <span v-if="card.ticket.progress_last_row" class="kanban-card-progress">
                  {{ card.ticket.progress_last_row }}
                </span>
                <span
                  v-if="card.ticket.progress_updated_at"
                  class="kanban-card-updated"
                  :class="{ 'kanban-card-updated-stalled': isStalled(card.ticket.status, card.ticket.progress_updated_at, now) }"
                >
                  {{ updatedAgoText(card.ticket.progress_updated_at, now) }}
                </span>
                <span
                  v-if="isStalled(card.ticket.status, card.ticket.progress_updated_at, now)"
                  class="kanban-card-stalled"
                >
                  stalled
                </span>
                <span class="kanban-card-status" :class="`kanban-card-status-${card.ticket.status}`">
                  {{ statusLabel(card.ticket.status) }}
                </span>
                <span v-if="card.ticket.assignee" class="kanban-card-assignee">
                  {{ card.ticket.assignee }}
                </span>
                <span v-if="card.ticket.session_id" class="kanban-card-session">
                  {{ card.ticket.session_id }}
                </span>
              </article>
            </div>
          </section>
        </div>

        <div v-if="board.errors.length" class="kanban-scan-errors">
          <p class="kanban-scan-errors-summary">
            {{ board.errors.length }} file(s) failed to scan. Click to see which files and why.
          </p>
          <details class="kanban-scan-errors-detail">
            <summary>Show scan errors ({{ board.errors.length }})</summary>
            <ul>
              <li v-for="(err, i) in board.errors" :key="i" class="kanban-scan-error">
                <code class="kanban-scan-error-file">{{ err.file }}</code>
                <span class="kanban-scan-error-msg">{{ err.error }}</span>
              </li>
            </ul>
          </details>
        </div>
        </template>
      </template>

      <template v-else>
        <div v-if="!repo" class="kanban-project-empty">
          <p class="kanban-project-empty-title">Select a repository to view its GitHub Project</p>
          <p class="kanban-project-empty-hint">
            The GitHub Project view shows the board synced from the selected repo's linked Project.
          </p>
        </div>
        <div v-else-if="projectLoading && !projectBoard" class="kanban-project-loading">
          <span class="kanban-spinner" aria-hidden="true" />
          Loading the synced board from GitHub…
        </div>
        <template v-else-if="projectBoard">
          <div class="kanban-project-board">
            <div class="kanban-project-header">
              <span class="kanban-project-title">
                {{ projectBoard.project?.title ?? repo!.full_name }}
              </span>
              <a
                v-if="projectBoard.project"
                class="kanban-project-open"
                :href="projectBoard.project.url"
                target="_blank"
                rel="noopener"
              >
                Open on GitHub ↗
              </a>
            </div>
            <div v-if="projectBoard.columns.length === 0" class="kanban-project-empty">
              <p class="kanban-project-empty-title">This Project has no cards yet</p>
            </div>
            <div v-else class="kanban-project-columns">
              <section
                v-for="column in projectBoard.columns"
                :key="column.status"
                class="kanban-project-column"
              >
                <header class="kanban-project-column-header">
                  <span class="kanban-project-column-title">{{ column.status }}</span>
                  <span class="kanban-project-column-count">{{ column.cards.length }}</span>
                </header>
                <div class="kanban-project-column-body">
                  <button
                    v-for="card in column.cards"
                    :key="card.issueNumber"
                    type="button"
                    class="kanban-project-card"
                    @click="openDetail(card)"
                  >
                    <!-- Header: repo + Spec ref + issue id, like ABAPlorer's `owner/repo #id`. -->
                    <span class="kanban-project-card-header">
                      <span v-if="repo" class="kanban-project-card-repo">{{ repo.full_name }}</span>
                      <span v-if="card.ref" class="kanban-project-card-ref">{{ card.ref }}</span>
                      <span class="kanban-project-card-issue">#{{ card.issueNumber }}</span>
                    </span>
                    <span v-if="card.title" class="kanban-project-card-title">{{ card.title }}</span>
                    <span v-if="card.status" class="kanban-project-card-status">{{ card.status }}</span>
                    <!-- Segmented sub-task progress (G4.S5.T6): N blocks = N sub-issues,
                         done fills a block with the brand palette (--caleo-primary), empty
                         blocks use the theme's muted tone (--caleo-border). -->
                    <span
                      v-if="card.progress && card.progress.total > 0"
                      class="kanban-spec-progress"
                      :aria-label="`${card.progress.done} of ${card.progress.total} sub-tasks done`"
                    >
                      <span class="kanban-spec-progress-bar">
                        <span
                          v-for="i in card.progress.total"
                          :key="i"
                          class="kanban-spec-progress-block"
                          :class="{ 'kanban-spec-progress-block-filled': i <= card.progress.done }"
                          :style="{
                            background:
                              i <= card.progress.done
                                ? 'var(--caleo-primary)'
                                : 'var(--caleo-border)',
                          }"
                        />
                      </span>
                      <span class="kanban-spec-progress-text">
                        {{ card.progress.done }} / {{ card.progress.total }} · {{ card.progress.percent }}%
                      </span>
                    </span>
                    <span class="kanban-project-card-link">issue #{{ card.issueNumber }} · view details</span>
                  </button>
                </div>
              </section>
            </div>
          </div>
        </template>
      </template>
    </template>

    <div v-if="detailCard" class="kanban-detail-overlay" @click.self="closeDetail">
      <div class="kanban-detail-panel" role="dialog" aria-modal="true" aria-label="Ticket detail">
        <header class="kanban-detail-header">
          <div class="kanban-detail-heading">
            <span v-if="detailCard.ref" class="kanban-detail-ref">{{ detailCard.ref }}</span>
            <span v-if="detailCard.title" class="kanban-detail-title">{{ detailCard.title }}</span>
            <span v-if="detailCard.status" class="kanban-detail-status">{{ detailCard.status }}</span>
          </div>
          <button type="button" class="kanban-detail-close" aria-label="Close detail" @click="closeDetail">
            ×
          </button>
        </header>

        <div v-if="detailLoading" class="kanban-detail-loading">
          <span class="kanban-spinner" aria-hidden="true" />
          Loading ticket details…
        </div>

        <div v-else class="kanban-detail-scroll">
          <div v-if="detailError" class="kanban-error">{{ detailError }}</div>

          <section v-if="detailMd" class="kanban-detail-section">
            <h4 class="kanban-detail-section-title">Ticket (docs/kanban)</h4>
            <div class="kanban-detail-fm">
              <span v-if="detailMd.frontmatter.status" class="kanban-detail-chip">
                status: {{ detailMd.frontmatter.status }}
              </span>
              <span v-if="detailMd.frontmatter.assignee" class="kanban-detail-chip">
                assignee: {{ detailMd.frontmatter.assignee }}
              </span>
              <span v-if="detailMd.frontmatter.owner" class="kanban-detail-chip">
                owner: {{ detailMd.frontmatter.owner }}
              </span>
              <span v-if="detailMd.frontmatter.session_id" class="kanban-detail-chip">
                session: {{ detailMd.frontmatter.session_id }}
              </span>
              <span v-if="detailMd.frontmatter.blocked_by" class="kanban-detail-chip">
                blocked by: {{ detailMd.frontmatter.blocked_by }}
              </span>
            </div>
            <div class="kanban-detail-description" v-html="renderMarkdown(detailMd.description)"></div>
            <div v-if="detailMd.progressLog.length" class="kanban-detail-progress">
              <h5 class="kanban-detail-progress-title">Progress Log</h5>
              <ul class="kanban-detail-progress-list">
                <li v-for="row in detailMd.progressLog" :key="row.timestamp" class="kanban-detail-progress-row">
                  <span class="kanban-detail-progress-ts">{{ formatDateTime(row.timestamp) }}</span>
                  <span class="kanban-detail-progress-status">{{ row.status }}</span>
                  <span class="kanban-detail-progress-text">{{ row.progress }}</span>
                </li>
              </ul>
            </div>
          </section>

          <section class="kanban-detail-section">
            <h4 class="kanban-detail-section-title">Discussion — issue #{{ detailCard.issueNumber }}</h4>
            <p v-if="detailComments && detailComments.length === 0" class="kanban-detail-no-comments">
              No comments yet.
            </p>
            <div v-else-if="detailComments" class="kanban-detail-comments">
              <div v-for="comment in detailComments" :key="comment.id" class="kanban-detail-comment">
                <div class="kanban-detail-comment-head">
                  <strong>{{ comment.user_login ?? "unknown" }}</strong>
                  <span class="kanban-detail-comment-date">{{ formatDateTime(comment.created_at) }}</span>
                </div>
                <div class="kanban-detail-comment-body" v-html="renderMarkdown(comment.body)"></div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.kanban-tab {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.kanban-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--caleo-text-secondary);
}

.kanban-empty-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--caleo-text);
}

.kanban-empty-hint {
  margin: 0;
  font-size: 13px;
}

.kanban-error {
  padding: 10px 14px;
  margin: 12px 12px 0;
  font-size: 13px;
  color: var(--caleo-error);
  background: rgba(213, 73, 65, 0.08);
  border: 1px solid rgba(213, 73, 65, 0.3);
  border-radius: 6px;
}

.kanban-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--caleo-border);
}

.kanban-toolbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* Segmented control: Local kanban | GitHub Project (G4.S5.T4). */
.kanban-view-toggle {
  display: inline-flex;
  padding: 2px;
  background: rgba(127, 127, 127, 0.1);
  border: 1px solid var(--caleo-border);
  border-radius: 7px;
}

.kanban-view-toggle-btn {
  padding: 3px 10px;
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  color: var(--caleo-text-secondary);
  background: transparent;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
}

.kanban-view-toggle-btn:hover {
  color: var(--caleo-text);
}

.kanban-view-toggle-active {
  color: var(--caleo-text);
  background: var(--caleo-surface);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
}

/* GitHub Project view (G4.S5.T4): the synced board, GitHub-native look. */
.kanban-project-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px;
  color: var(--caleo-text-secondary);
}

.kanban-project-empty-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--caleo-text);
}

.kanban-project-empty-hint {
  margin: 0;
  font-size: 13px;
}

.kanban-project-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px;
  font-size: 13px;
  color: var(--caleo-text-secondary);
}

.kanban-project-board {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.kanban-project-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--caleo-border);
}

.kanban-project-title {
  min-width: 0;
  font-size: 13px;
  font-weight: 700;
  color: var(--caleo-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kanban-project-open {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--caleo-primary);
  text-decoration: none;
}

.kanban-project-open:hover {
  text-decoration: underline;
}

.kanban-project-columns {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
  padding: 12px 14px;
  overflow: auto;
}

.kanban-project-column {
  display: flex;
  flex-direction: column;
  background: rgba(127, 127, 127, 0.06);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  min-height: 0;
}

.kanban-project-column-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--caleo-border);
}

.kanban-project-column-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--caleo-text);
}

.kanban-project-column-count {
  padding: 1px 7px;
  font-size: 11px;
  color: var(--caleo-text-secondary);
  background: rgba(127, 127, 127, 0.12);
  border-radius: 999px;
}

.kanban-project-column-body {
  flex: 1;
  min-height: 60px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  overflow: auto;
}

.kanban-project-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px;
  font: inherit;
  text-align: left;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  box-shadow: 0 1px 1px rgba(0, 0, 0, 0.05);
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.kanban-project-card:hover {
  border-color: var(--caleo-primary);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.12);
}

.kanban-project-card-ref {
  font-size: 11px;
  font-weight: 700;
  color: var(--caleo-primary);
}

/* Card header (G4.S5.T6): repo + Spec ref + issue id on one line. */
.kanban-project-card-header {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.kanban-project-card-repo {
  font-size: 11px;
  font-weight: 600;
  color: var(--caleo-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kanban-project-card-issue {
  flex: 0 0 auto;
  margin-left: auto;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--caleo-text-secondary);
}

/* Segmented sub-task progress bar (G4.S5.T6) — brand palette, theme-adaptive. */
.kanban-spec-progress {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.kanban-spec-progress-bar {
  display: flex;
  gap: 3px;
}

.kanban-spec-progress-block {
  flex: 1 1 0;
  height: 6px;
  min-width: 4px;
  border-radius: 2px;
}

.kanban-spec-progress-text {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--caleo-text-secondary);
}

.kanban-project-card-title {
  font-size: 13px;
  color: var(--caleo-text);
}

.kanban-project-card-status {
  align-self: flex-start;
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--caleo-text-secondary);
  background: rgba(127, 127, 127, 0.12);
  border-radius: 999px;
}

.kanban-project-card-link {
  font-size: 11px;
  color: var(--caleo-primary);
}

/* Local detail panel (G4.S5.T4): md details + GitHub comments, no redirect. */
.kanban-detail-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  justify-content: flex-end;
  background: rgba(0, 0, 0, 0.35);
}

.kanban-detail-panel {
  width: min(520px, 92vw);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--caleo-surface);
  border-left: 1px solid var(--caleo-border);
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.18);
}

.kanban-detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--caleo-border);
}

.kanban-detail-heading {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.kanban-detail-ref {
  font-size: 11px;
  font-weight: 700;
  color: var(--caleo-primary);
}

.kanban-detail-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--caleo-text);
}

.kanban-detail-status {
  align-self: flex-start;
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--caleo-text-secondary);
  background: rgba(127, 127, 127, 0.12);
  border-radius: 999px;
}

.kanban-detail-close {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font: inherit;
  font-size: 18px;
  line-height: 1;
  color: var(--caleo-text-secondary);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.kanban-detail-close:hover {
  color: var(--caleo-text);
  background: rgba(127, 127, 127, 0.12);
}

.kanban-detail-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px;
  font-size: 13px;
  color: var(--caleo-text-secondary);
}

.kanban-detail-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.kanban-detail-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.kanban-detail-section-title {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--caleo-text-secondary);
}

.kanban-detail-fm {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.kanban-detail-chip {
  padding: 1px 8px;
  font-size: 11px;
  color: var(--caleo-text-secondary);
  background: rgba(127, 127, 127, 0.1);
  border-radius: 999px;
}

.kanban-detail-description {
  font-size: 13px;
  line-height: 1.6;
  color: var(--caleo-text);
}

.kanban-detail-description :deep(pre) {
  padding: 8px 10px;
  background: rgba(127, 127, 127, 0.08);
  border-radius: 6px;
  overflow: auto;
}

.kanban-detail-progress-title {
  margin: 0 0 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--caleo-text);
}

.kanban-detail-progress-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.kanban-detail-progress-row {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px 8px;
  background: rgba(127, 127, 127, 0.06);
  border-radius: 6px;
}

.kanban-detail-progress-ts {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--caleo-text-secondary);
}

.kanban-detail-progress-status {
  font-size: 11px;
  font-weight: 600;
  color: var(--caleo-primary);
}

.kanban-detail-progress-text {
  font-size: 12px;
  color: var(--caleo-text);
}

.kanban-detail-no-comments {
  margin: 0;
  font-size: 13px;
  color: var(--caleo-text-secondary);
}

.kanban-detail-comments {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.kanban-detail-comment {
  padding: 8px 10px;
  background: rgba(127, 127, 127, 0.06);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
}

.kanban-detail-comment-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
  font-size: 12px;
  color: var(--caleo-text);
}

.kanban-detail-comment-date {
  font-size: 11px;
  color: var(--caleo-text-secondary);
}

.kanban-detail-comment-body {
  font-size: 13px;
  line-height: 1.5;
  color: var(--caleo-text);
}

.kanban-toolbar-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.kanban-source {
  font-size: 13px;
  font-weight: 600;
  color: var(--caleo-text);
}

.kanban-scan-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--caleo-text-secondary);
}

.kanban-refreshed {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--caleo-text-secondary);
}

.kanban-spinner {
  width: 12px;
  height: 12px;
  flex: 0 0 12px;
  border: 2px solid var(--caleo-border);
  border-top-color: var(--caleo-primary);
  border-radius: 50%;
  animation: kanban-spin 0.7s linear infinite;
}

.kanban-spinner-inline {
  vertical-align: -2px;
}

@keyframes kanban-spin {
  to {
    transform: rotate(360deg);
  }
}

.kanban-refresh {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  font: inherit;
  font-size: 12px;
  color: var(--caleo-text);
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  cursor: pointer;
}

.kanban-refresh:hover:not(:disabled) {
  border-color: var(--caleo-primary);
  color: var(--caleo-primary);
}

.kanban-refresh:disabled {
  opacity: 0.6;
  cursor: default;
}

.kanban-tree {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--caleo-border);
  /* As goals accumulate, cap the area and scroll vertically so it never blows
     out the tab layout or starves the ticket board below. */
  max-height: 260px;
  overflow-y: auto;
}

.kanban-goal-check {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  margin-top: 2px;
  cursor: pointer;
  color: var(--caleo-text-secondary);
}
.kanban-goal-check input {
  width: 14px;
  height: 14px;
  accent-color: var(--caleo-primary);
  cursor: pointer;
}

/* Each goal is a clean two-part row: fixed/narrow left (ref + title) and a
   wrapping spec-badge area on the right, so columns align and long titles no
   longer stretch the row or strand dead whitespace. */
.kanban-goal {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  font-size: 13px;
}

.kanban-goal-main {
  flex: 0 0 320px;
  min-width: 0;
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.kanban-goal-ref {
  flex: 0 0 auto;
  font-weight: 700;
  color: var(--caleo-primary);
}

.kanban-goal-title {
  min-width: 0;
  font-weight: 600;
  color: var(--caleo-text);
  /* Allow the goal description to wrap onto multiple lines instead of a single
     truncated line. Clamp to 3 lines so a very long description can't blow out
     the row height. */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.kanban-goal-specs {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.kanban-spec {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  max-width: 100%;
  padding: 1px 8px;
  font-size: 12px;
  color: var(--caleo-text-secondary);
  background: rgba(127, 127, 127, 0.08);
  border-radius: 999px;
}

.kanban-spec-ref {
  flex: 0 0 auto;
  font-weight: 600;
  color: var(--caleo-primary);
}

/* Long spec titles truncate instead of stretching the row. */
.kanban-spec-title {
  min-width: 0;
  max-width: 320px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.kanban-columns {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  padding: 12px 14px;
  overflow: auto;
}

.kanban-column {
  display: flex;
  flex-direction: column;
  background: rgba(127, 127, 127, 0.06);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  min-height: 0;
}

.kanban-column-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--caleo-border);
  cursor: pointer;
  user-select: none;
  transition: background 0.15s ease;
}

.kanban-column-header:hover {
  background: rgba(255, 102, 51, 0.08);
}

/* The expanded column gets a subtle highlight so the widen is obvious. */
.kanban-column-expanded {
  outline: 1px solid var(--caleo-primary);
  outline-offset: 1px;
}

.kanban-column-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: capitalize;
  color: var(--caleo-text);
}

.kanban-column-count {
  padding: 1px 7px;
  font-size: 11px;
  color: var(--caleo-text-secondary);
  background: rgba(127, 127, 127, 0.12);
  border-radius: 999px;
}

.kanban-column-body {
  flex: 1;
  min-height: 60px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  overflow: auto;
}

.kanban-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
}

.kanban-card-ref {
  font-size: 11px;
  font-weight: 700;
  color: var(--caleo-primary);
}

.kanban-card-title {
  font-size: 13px;
  color: var(--caleo-text);
}

.kanban-card-spec {
  font-size: 11px;
  color: var(--caleo-text-secondary);
}

.kanban-card-progress {
  font-size: 11px;
  line-height: 1.4;
  color: var(--caleo-text-secondary);
  background: rgba(127, 127, 127, 0.08);
  border-radius: 4px;
  padding: 2px 6px;
}

.kanban-card-updated {
  align-self: flex-start;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--caleo-text-secondary);
}

.kanban-card-updated-stalled {
  color: var(--caleo-error);
}

/* Stalled is an OBSERVATION flag only — derived from the Progress Log last-row
   timestamp; it never modifies the ticket frontmatter status. */
.kanban-card-stalled {
  align-self: flex-start;
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: #fff;
  background: #cf222e;
  border-radius: 999px;
}

.kanban-card-assignee {
  align-self: flex-start;
  padding: 1px 8px;
  font-size: 11px;
  color: var(--caleo-text-secondary);
  background: rgba(127, 127, 127, 0.1);
  border-radius: 999px;
}

.kanban-card-status {
  align-self: flex-start;
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 600;
  text-transform: capitalize;
  color: var(--caleo-text-secondary);
  background: rgba(127, 127, 127, 0.12);
  border-radius: 999px;
}

.kanban-card-status-in_progress {
  color: #1f2328;
  background: #d4a72c;
}

.kanban-card-status-done {
  color: #1f2328;
  background: #2da44e;
}

.kanban-card-status-in_review {
  color: #1f2328;
  background: #a371f7;
}

.kanban-card-status-approved {
  color: #1f2328;
  background: #2da44e;
}

.kanban-card-status-rejected {
  color: #fff;
  background: #cf222e;
}

.kanban-card-session {
  align-self: flex-start;
  max-width: 100%;
  padding: 1px 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--caleo-text-secondary);
  background: rgba(127, 127, 127, 0.08);
  border-radius: 999px;
  overflow-wrap: anywhere;
  word-break: break-all;
}

.kanban-scan-errors {
  margin: 0;
  padding: 6px 14px 12px;
  font-size: 12px;
  color: var(--caleo-error);
}
.kanban-scan-errors-summary {
  margin: 0 0 4px;
  font-weight: 500;
  color: var(--caleo-error);
}
.kanban-scan-errors-detail {
  margin-top: 4px;
  border: 1px solid rgba(207, 34, 46, 0.25);
  border-radius: 6px;
  background: rgba(207, 34, 46, 0.04);
}
.kanban-scan-errors-detail summary {
  cursor: pointer;
  padding: 6px 10px;
  font-weight: 600;
  color: var(--caleo-error);
  user-select: none;
}
.kanban-scan-errors-detail ul {
  margin: 0;
  padding: 0 10px 8px 26px;
  list-style: none;
}
.kanban-scan-error {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 0;
  border-top: 1px solid rgba(207, 34, 46, 0.12);
}
.kanban-scan-error-file {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--caleo-text-primary);
  word-break: break-all;
}
.kanban-scan-error-msg {
  font-size: 11px;
  color: var(--caleo-error);
  word-break: break-word;
}
</style>
