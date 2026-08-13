<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useAuthStore } from "@/stores/auth";
import type { GithubRepo } from "@/api/github";
import {
  fetchBoard,
  TICKET_STATUSES,
  type KanbanIndex,
  type KanbanIndexSpec,
  type KanbanIndexTicket,
  type TicketStatus,
} from "@/api/kanban";
import { updatedAgoText, isStalled } from "@/kanban/progress";

const props = defineProps<{ repo: GithubRepo | null }>();

const auth = useAuthStore();

const board = ref<KanbanIndex | null>(null);
const loading = ref(false);
const error = ref("");
const lastRefresh = ref("");

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

watch(
  () => props.repo,
  () => {
    void loadBoard();
  },
  { immediate: true },
);
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
          <span v-if="loading" class="kanban-scan-status" aria-live="polite">
            <span class="kanban-spinner" aria-hidden="true" />
            Scanning docs/kanban…
          </span>
          <span v-else-if="lastRefresh" class="kanban-refreshed">
            Refreshed {{ lastRefresh }}
          </span>
        </div>
        <button
          type="button"
          class="kanban-refresh"
          :disabled="loading"
          @click="loadBoard(true)"
        >
          <span v-if="loading" class="kanban-spinner kanban-spinner-inline" aria-hidden="true" />
          {{ loading ? "Scanning…" : "Refresh" }}
        </button>
      </div>

      <div v-if="error" class="kanban-error">{{ error }}</div>

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
