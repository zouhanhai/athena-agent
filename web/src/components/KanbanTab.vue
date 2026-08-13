<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useAuthStore } from "@/stores/auth";
import { fetchFileContent, type GithubIssueComment, type GithubRepo } from "@/api/github";
import {
  fetchBoard,
  fetchGithubIssueComments,
  fetchGithubProjectBoard,
  fetchGithubProjects,
  postGithubIssueComment,
  TICKET_STATUSES,
  type GithubProject,
  type GithubProjectBoard,
  type GithubProjectCard,
  type GithubProjectSubIssue,
  type KanbanIndex,
  type KanbanIndexSpec,
  type KanbanIndexTicket,
  type TicketStatus,
} from "@/api/kanban";
import { updatedAgoText } from "@/kanban/progress";
import { parseTicketMd, type ParsedTicket } from "@/kanban/ticket-md";
import { renderMarkdown } from "@/kb/markdown";

const props = defineProps<{ repo: GithubRepo | null }>();

const emit = defineEmits<{
  /** Local 'view in Issues' navigation: switch the Workbench to the Issues tab and locate this issue (G4.S5.T8). */
  "open-issue": [payload: { issueNumber: number }];
}>();

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

/** The repo's OPEN linked Projects, for the project selector (G4.S5.T12). */
const projects = ref<GithubProject[]>([]);
const projectsLoading = ref(false);
const selectedProjectId = ref("");

/** localStorage key remembering the last-chosen project (G4.S5.T12). */
const PROJECT_SELECTION_KEY = "athena.kanban.project_id";

/** Selector options: one per open linked project (label = title). */
const projectOptions = computed(() =>
  projects.value.map((p) => ({ label: p.title, value: p.id })),
);

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

/** Live clock for the 'updated Xs ago' label — ticks so the age stays fresh. */
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

/** True for a Spec card (`Gx.Sy` ref) — gets the brand-orange accent. Ticket sub-issue cards (`Gx.Sy.Tz`) stay plain (G4.S5.T9). */
function isSpecCard(card: GithubProjectCard): boolean {
  return /^G\d+\.S\d+$/.test(card.ref ?? "");
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

/** Fetch the repo's open linked Projects, then load the board for the chosen one (G4.S5.T12). */
async function loadProjects(): Promise<void> {
  if (!auth.sessionToken || !props.repo) {
    projects.value = [];
    selectedProjectId.value = "";
    projectBoard.value = null;
    return;
  }
  projectsLoading.value = true;
  error.value = "";
  projects.value = [];
  selectedProjectId.value = "";
  projectBoard.value = null;
  try {
    const list = await fetchGithubProjects(auth.sessionToken, props.repo.full_name);
    projects.value = list;
    // Default to the first open project, or the last one the user picked.
    const saved = localStorage.getItem(PROJECT_SELECTION_KEY);
    const remembered = list.find((p) => p.id === saved);
    selectedProjectId.value = remembered?.id ?? list[0]?.id ?? "";
  } catch (err) {
    fail(err);
  } finally {
    projectsLoading.value = false;
  }
  if (selectedProjectId.value) {
    await loadProject();
  }
}

/** Load the board for the currently selected linked project (GitHub view only). */
async function loadProject(): Promise<void> {
  if (!auth.sessionToken || !props.repo || !selectedProjectId.value) {
    return;
  }
  projectLoading.value = true;
  error.value = "";
  try {
    projectBoard.value = await fetchGithubProjectBoard(
      auth.sessionToken,
      props.repo.full_name,
      selectedProjectId.value,
    );
    projectRefreshed.value = projectBoard.value.generated_at
      ? new Date(projectBoard.value.generated_at).toLocaleTimeString()
      : new Date().toLocaleTimeString();
  } catch (err) {
    fail(err);
  } finally {
    projectLoading.value = false;
  }
}

/** User picked a different linked project in the selector → load that board. */
function onProjectChange(id: string): void {
  selectedProjectId.value = id;
  if (id) {
    localStorage.setItem(PROJECT_SELECTION_KEY, id);
  }
  void loadProject();
}

// ---------------------------------------------------------------------------
// Local detail panel (G4.S5.T4): clicking a GitHub-view card opens a drawer
// with the ticket's md (frontmatter + description + Progress Log) pulled from
// the repo, plus the GitHub issue comment thread — no GitHub redirect.
// ---------------------------------------------------------------------------

const detailCard = ref<DetailCard | null>(null);
const detailMd = ref<ParsedTicket | null>(null);
const detailComments = ref<GithubIssueComment[] | null>(null);
const detailLoading = ref(false);
const detailError = ref("");

const newComment = ref("");
const commentPosting = ref(false);
const commentPostError = ref("");

/**
 * The detail panel target. A Spec card opened from the board carries its
 * sub-issues list; a sub-issue opened from that list has none (its own tickets
 * don't exist yet).
 */
type DetailCard = Pick<GithubProjectCard, "issueNumber" | "ref" | "title" | "status" | "subIssues">;

/** Build the detail target for a sub-issue row (opens that ticket's own detail). */
function subIssueCard(sub: GithubProjectSubIssue): DetailCard {
  return { issueNumber: sub.number, ref: sub.ref, title: sub.title, status: sub.status, subIssues: [] };
}

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

/** Open the local detail panel for a GitHub-view card (or sub-issue) and load its content. */
async function openDetail(card: DetailCard): Promise<void> {
  detailCard.value = card;
  detailMd.value = null;
  detailComments.value = null;
  detailError.value = "";
  commentPostError.value = "";
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
  newComment.value = "";
  commentPostError.value = "";
}

/** POST a new GitHub comment to the open issue and append it to the thread (G4.S5.T8). */
async function postComment(): Promise<void> {
  const target = detailCard.value;
  const text = newComment.value.trim();
  if (!auth.sessionToken || !props.repo || !target || !text) {
    return;
  }
  commentPosting.value = true;
  commentPostError.value = "";
  try {
    const comment = await postGithubIssueComment(
      auth.sessionToken,
      props.repo.full_name,
      target.issueNumber,
      text,
    );
    detailComments.value = [...(detailComments.value ?? []), comment];
    newComment.value = "";
  } catch (err) {
    commentPostError.value = err instanceof Error ? err.message : String(err);
  } finally {
    commentPosting.value = false;
  }
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
      void loadProjects();
    }
  },
  { immediate: true },
);

watch(view, (next) => {
  error.value = "";
  if (next === "github") {
    void loadProjects();
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
                >
                  {{ updatedAgoText(card.ticket.progress_updated_at, now) }}
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
        <div v-else-if="projectsLoading || (projectLoading && !projectBoard)" class="kanban-project-loading">
          <span class="kanban-spinner" aria-hidden="true" />
          Loading the synced board from GitHub…
        </div>
        <div v-else-if="projects.length === 0" class="kanban-project-empty">
          <p class="kanban-project-empty-title">No open linked Project</p>
          <p class="kanban-project-empty-hint">
            This repo has no open GitHub Project linked to it.
          </p>
        </div>
        <template v-else-if="projectBoard">
          <div class="kanban-project-board">
            <div class="kanban-project-header">
              <div class="kanban-project-heading">
                <span class="kanban-project-title">Project</span>
                <t-select
                  class="kanban-project-select"
                  v-model="selectedProjectId"
                  :options="projectOptions"
                  size="small"
                  :loading="projectLoading"
                  placeholder="Select a project"
                  :aria-label="'Select the linked GitHub Project'"
                  @change="onProjectChange"
                />
              </div>
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
                    :class="{ 'kanban-project-card-spec': isSpecCard(card) }"
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

    <div v-if="detailCard" class="kanban-detail-overlay kanban-detail-embedded">
      <div
        class="kanban-detail-panel"
        role="dialog"
        aria-label="Spec detail"
        @click.self="closeDetail"
      >
        <header class="kanban-detail-header">
          <div class="kanban-detail-heading">
            <span v-if="detailCard.ref" class="kanban-detail-ref">{{ detailCard.ref }}</span>
            <span v-if="detailCard.title" class="kanban-detail-title">{{ detailCard.title }}</span>
            <span v-if="detailCard.status" class="kanban-detail-status">{{ detailCard.status }}</span>
          </div>
          <div class="kanban-detail-header-actions">
            <button
              type="button"
              class="kanban-detail-locate"
              @click="emit('open-issue', { issueNumber: detailCard.issueNumber })"
            >
              View in Issues
            </button>
            <button type="button" class="kanban-detail-close" aria-label="Close detail" @click="closeDetail">
              ×
            </button>
          </div>
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

          <!-- Sub-issues list (G4.S5.T8): clickable rows like GitHub's Sub-issues block. -->
          <section v-if="detailCard.subIssues.length" class="kanban-detail-section">
            <h4 class="kanban-detail-section-title">Sub-issues ({{ detailCard.subIssues.length }})</h4>
            <div class="kanban-detail-subissues">
              <div
                v-for="sub in detailCard.subIssues"
                :key="sub.number"
                class="kanban-detail-subissue"
              >
                <button
                  type="button"
                  class="kanban-detail-subissue-main"
                  @click="openDetail(subIssueCard(sub))"
                >
                  <span class="kanban-detail-subissue-ref">{{ sub.ref }}</span>
                  <span class="kanban-detail-subissue-title">{{ sub.title }}</span>
                  <span
                    class="kanban-detail-subissue-status"
                    :class="`kanban-detail-subissue-status-${sub.status}`"
                  >
                    {{ sub.status }}
                  </span>
                  <span class="kanban-detail-subissue-number">#{{ sub.number }}</span>
                </button>
                <button
                  type="button"
                  class="kanban-detail-subissue-locate"
                  @click="emit('open-issue', { issueNumber: sub.number })"
                >
                  View in Issues
                </button>
              </div>
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

            <!-- Comment input (G4.S5.T8): POSTs a new GitHub comment, then shows it. -->
            <div class="kanban-detail-comment-box">
              <textarea
                v-model="newComment"
                class="kanban-detail-comment-input"
                rows="3"
                placeholder="Leave a comment"
                aria-label="New comment"
              ></textarea>
              <div v-if="commentPostError" class="kanban-error">{{ commentPostError }}</div>
              <div class="kanban-detail-comment-actions">
                <button
                  type="button"
                  class="kanban-detail-comment-submit"
                  :disabled="commentPosting || !newComment.trim()"
                  @click="postComment"
                >
                  {{ commentPosting ? "Posting…" : "Post comment" }}
                </button>
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
  position: relative;
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

/* Project selector (G4.S5.T12): label + dropdown above the board. */
.kanban-project-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.kanban-project-select {
  min-width: 200px;
  max-width: 100%;
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

/* Brand-orange accent on Spec cards (G4.S5.T9): a Spec (issue) card is
   distinguished from a plain ticket sub-issue card at a glance. Theme-adaptive
   via the CSS-variable system: the tint is subtle in light mode and a readable
   brighter accent in dark mode; the left border is the brand orange in both. */
.kanban-project-card-spec {
  border-left: 3px solid var(--caleo-primary);
  background: var(--caleo-primary-tint);
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

/* Local detail panel (G4.S5.T4): md details + GitHub comments, no redirect.
   G4.S5.T8: EMBEDDED inside the Kanban tab (position: absolute within the
   relative .kanban-tab) so it covers only the Kanban area — the fixed
   right-side Chat panel stays visible and usable (no full-screen overlay). */
.kanban-detail-embedded {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 20;
  width: min(520px, 68%);
  max-width: 100%;
}

.kanban-detail-panel {
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

.kanban-detail-header-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

.kanban-detail-locate,
.kanban-detail-subissue-locate {
  padding: 3px 10px;
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  color: var(--caleo-primary);
  background: transparent;
  border: 1px solid var(--caleo-border);
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}

.kanban-detail-locate:hover,
.kanban-detail-subissue-locate:hover {
  background: rgba(127, 127, 127, 0.08);
  border-color: var(--caleo-primary);
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

/* Sub-issues list (G4.S5.T8): a GitHub Sub-issues-style block. */
.kanban-detail-subissues {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.kanban-detail-subissue {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: rgba(127, 127, 127, 0.06);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
}

.kanban-detail-subissue-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0;
  font: inherit;
  text-align: left;
  background: transparent;
  border: none;
  cursor: pointer;
}

.kanban-detail-subissue-main:hover .kanban-detail-subissue-title {
  color: var(--caleo-primary);
}

.kanban-detail-subissue-ref {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 700;
  color: var(--caleo-primary);
}

.kanban-detail-subissue-title {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--caleo-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kanban-detail-subissue-status {
  flex: 0 0 auto;
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 600;
  text-transform: capitalize;
  color: var(--caleo-text-secondary);
  background: rgba(127, 127, 127, 0.12);
  border-radius: 999px;
}

.kanban-detail-subissue-status-done {
  color: #1f2328;
  background: #2da44e;
}

.kanban-detail-subissue-number {
  flex: 0 0 auto;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--caleo-text-secondary);
}

/* Comment input (G4.S5.T8): POSTs a new GitHub comment from the panel. */
.kanban-detail-comment-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}

.kanban-detail-comment-input {
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

.kanban-detail-comment-input:focus {
  outline: none;
  border-color: var(--caleo-primary);
}

.kanban-detail-comment-actions {
  display: flex;
  justify-content: flex-end;
}

.kanban-detail-comment-submit {
  padding: 5px 14px;
  font: inherit;
  font-size: 13px;
  color: #fff;
  background: var(--caleo-primary);
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.kanban-detail-comment-submit:disabled {
  opacity: 0.6;
  cursor: default;
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
