<script setup lang="ts">
import type { ChatParticipant } from "@/stores/chat";

defineProps<{ participant: ChatParticipant }>();

const emit = defineEmits<{
  "speak-change": [speak: boolean];
  left: [];
}>();
</script>

<template>
  <article class="agent-card">
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
