<script setup lang="ts">
import type { ChatParticipant } from "@/stores/chat";

defineProps<{
  participant: ChatParticipant;
  active?: boolean;
  stackIndex?: number;
}>();

const emit = defineEmits<{
  "speak-change": [speak: boolean];
  left: [];
  toggle: [];
}>();

function onCardClick(e: MouseEvent) {
  const t = e.target as HTMLElement;
  if (t.closest("button, input, label")) return; // don't toggle on inner controls
  emit("toggle");
}
</script>

<template>
  <article
    class="agent-card"
    :class="{ active }"
    :style="{ '--stack': stackIndex ?? 0 }"
    :title="active ? undefined : participant.name"
    @click="onCardClick"
  >
    <img class="agent-card-logo" :src="participant.logoUrl" :alt="participant.name" />
    <div class="agent-card-body">
      <header class="agent-card-head">
        <span class="agent-card-name">{{ participant.name }}</span>
        <span class="agent-card-kind">{{ participant.kind }}</span>
        <button
          type="button"
          class="card-remove"
          :aria-label="`Remove ${participant.name}`"
          title="Remove from conversation"
          @click="emit('left')"
        >
          ×
        </button>
      </header>
      <ul v-if="participant.capabilities.length" class="cap-chip-list">
        <li v-for="cap in participant.capabilities" :key="cap" class="cap-chip">
          {{ cap }}
        </li>
      </ul>
      <label class="speak-toggle-wrap">
        <input
          type="checkbox"
          class="speak-toggle"
          :checked="participant.speak"
          @change="emit('speak-change', ($event.target as HTMLInputElement).checked)"
        />
        <span class="speak-toggle-label">
          {{ participant.speak ? "Can speak" : "Read only" }}
        </span>
      </label>
    </div>
  </article>
</template>

<style scoped>
.agent-card {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 12px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  box-shadow: var(--caleo-shadow);
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease,
    bottom 200ms cubic-bezier(0.77, 0, 0.175, 1);
}

/* Active card sits in the flow (natural height, no overflow); the others are
   absolutely positioned below it. */
.agent-card.active {
  position: relative;
  z-index: 10;
  border-color: var(--caleo-primary);
  background: color-mix(in srgb, var(--caleo-primary) 6%, var(--caleo-surface));
}

.agent-card:not(.active) {
  position: absolute;
  left: 0;
  right: 0;
  /* each inactive card is a slim strip stacked below the active card, offset by
     its stack index so only the top edge (logo + name) peeks out */
  bottom: calc(0px - var(--stack, 0) * 40px);
  height: 44px;
  align-items: center;
  overflow: hidden;
  z-index: calc(9 - var(--stack, 0));
}

.agent-card:hover {
  border-color: var(--caleo-primary);
}

.agent-card:not(.active) .agent-card-head {
  gap: 6px;
}

.agent-card:not(.active) .agent-card-kind,
.agent-card:not(.active) .card-remove,
.agent-card:not(.active) .cap-chip-list,
.agent-card:not(.active) .speak-toggle-wrap {
  display: none;
}

.agent-card:not(.active) .agent-card-name {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-card:not(.active) .agent-card-logo {
  width: 30px;
  height: 30px;
}

.agent-card-logo {
  width: 36px;
  height: 36px;
  /* No circle crop, no white background — logo shows transparent on the card surface */
  border-radius: 0;
  object-fit: contain;
  flex-shrink: 0;
  background: transparent;
}

.agent-card-body {
  flex: 1;
  min-width: 0;
}

.agent-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.agent-card-name {
  font-weight: 600;
  font-size: 14px;
  color: var(--caleo-text);
}

.agent-card-kind {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--caleo-text-secondary);
  background: color-mix(in srgb, var(--caleo-primary) 12%, transparent);
  border-radius: 999px;
  padding: 1px 8px;
}

.card-remove {
  margin-left: auto;
  border: none;
  background: transparent;
  color: var(--caleo-text-secondary);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
}

.card-remove:hover {
  color: var(--caleo-error);
}

.cap-chip-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.cap-chip {
  font-size: 11px;
  color: var(--caleo-text-secondary);
  background: color-mix(in srgb, var(--caleo-text-secondary) 10%, transparent);
  border-radius: 999px;
  padding: 1px 8px;
}

.speak-toggle-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  cursor: pointer;
}

.speak-toggle-label {
  font-size: 12px;
  color: var(--caleo-text-secondary);
}
</style>
