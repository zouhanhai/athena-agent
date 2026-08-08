<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useAuthStore } from "@/stores/auth";
import {
  fetchBoard,
  TICKET_STATUSES,
  type KanbanBoard,
  type TicketFrontmatter,
  type TicketStatus,
} from "@/api/kanban";

const auth = useAuthStore();

const board = ref<KanbanBoard | null>(null);
const error = ref("");

const hasSession = computed(() => !!auth.sessionToken);

interface BoardCard {
  ref: string;
  specRef: string;
  ticket: TicketFrontmatter;
}

const cards = computed<BoardCard[]>(() => {
  const out: BoardCard[] = [];
  for (const goal of board.value?.goals ?? []) {
    for (const spec of goal.specs) {
      for (const ticket of spec.tickets) {
        out.push({ ref: ticket.ref, specRef: spec.ref, ticket: ticket.ticket });
      }
    }
  }
  return out;
});

function statusLabel(status: TicketStatus): string {
  return status.replace("_", " ");
}

function cardsFor(status: TicketStatus): BoardCard[] {
  return cards.value.filter((card) => card.ticket.status === status);
}

function fail(err: unknown): void {
  error.value = err instanceof Error ? err.message : String(err);
}

async function loadBoard(): Promise<void> {
  if (!auth.sessionToken) {
    return;
  }
  error.value = "";
  try {
    board.value = await fetchBoard(auth.sessionToken);
  } catch (err) {
    fail(err);
  }
}

onMounted(() => {
  void loadBoard();
});
</script>

<template>
  <div class="kanban-tab">
    <div v-if="!hasSession" class="kanban-empty">
      <p class="kanban-empty-title">Sign in to view the board</p>
      <p class="kanban-empty-hint">Log in to see Goals, Specs and Tickets scanned from the repo.</p>
    </div>

    <template v-else>
      <div v-if="error" class="kanban-error">{{ error }}</div>

      <template v-if="board">
        <div class="kanban-tree" aria-label="Goals and Specs">
          <div v-for="goal in board.goals" :key="goal.ref" class="kanban-goal">
            <span class="kanban-goal-ref">{{ goal.ref }}</span>
            <span class="kanban-goal-title">{{ goal.goal.title }}</span>
            <div class="kanban-goal-specs">
              <span
                v-for="spec in goal.specs"
                :key="spec.ref"
                class="kanban-spec"
              >{{ spec.ref }} · {{ spec.spec.title }}</span>
            </div>
          </div>
        </div>

        <div class="kanban-columns">
          <section
            v-for="status in TICKET_STATUSES"
            :key="status"
            class="kanban-column"
            :class="`kanban-column-${status}`"
          >
            <header class="kanban-column-header">
              <span class="kanban-column-title">{{ statusLabel(status) }}</span>
              <span class="kanban-column-count">{{ cardsFor(status).length }}</span>
            </header>
            <div class="kanban-column-body">
              <article v-for="card in cardsFor(status)" :key="card.ref" class="kanban-card">
                <span class="kanban-card-ref">{{ card.ref }}</span>
                <span class="kanban-card-title">{{ card.ticket.title }}</span>
                <span class="kanban-card-spec">{{ card.specRef }}</span>
                <span v-if="card.ticket.assignee" class="kanban-card-assignee">{{ card.ticket.assignee }}</span>
              </article>
            </div>
          </section>
        </div>

        <p v-if="board.errors.length" class="kanban-scan-errors">
          {{ board.errors.length }} file(s) failed to scan.
        </p>
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

.kanban-tree {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--caleo-border);
}

.kanban-goal {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
}

.kanban-goal-ref {
  flex: 0 0 auto;
  font-weight: 700;
  color: var(--caleo-primary);
}

.kanban-goal-title {
  font-weight: 600;
  color: var(--caleo-text);
}

.kanban-goal-specs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-left: auto;
}

.kanban-spec {
  padding: 1px 8px;
  font-size: 12px;
  color: var(--caleo-text-secondary);
  background: rgba(127, 127, 127, 0.08);
  border-radius: 999px;
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

.kanban-card-assignee {
  align-self: flex-start;
  padding: 1px 8px;
  font-size: 11px;
  color: var(--caleo-text-secondary);
  background: rgba(127, 127, 127, 0.1);
  border-radius: 999px;
}

.kanban-scan-errors {
  margin: 0;
  padding: 6px 14px 12px;
  font-size: 12px;
  color: var(--caleo-error);
}
</style>
