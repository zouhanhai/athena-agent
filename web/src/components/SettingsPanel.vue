<script setup lang="ts">
import { ref } from "vue";
import { storeToRefs } from "pinia";
import { SettingIcon } from "tdesign-icons-vue-next";
import { useThemeStore } from "@/stores/theme";
import type { ThemeMode } from "@/theme";

const theme = useThemeStore();
const { mode } = storeToRefs(theme);

const visible = ref(false);
const panelRef = ref<HTMLElement | null>(null);

const themeOptions: { value: ThemeMode; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

function attachToPanel() {
  return panelRef.value;
}

function open() {
  visible.value = true;
}
</script>

<template>
  <div ref="panelRef" class="settings-panel">
    <t-button
      class="settings-trigger"
      variant="text"
      theme="default"
      @click="open"
    >
      <template #icon><SettingIcon /></template>
      Settings
    </t-button>

    <t-dialog
      v-model:visible="visible"
      class="settings-dialog"
      header="Settings"
      :footer="false"
      :destroy-on-close="true"
      :attach="attachToPanel"
      width="320px"
    >
      <div class="settings-section">
        <h4 class="settings-title">Theme</h4>
        <div class="theme-options">
          <button
            v-for="opt in themeOptions"
            :key="opt.value"
            type="button"
            class="theme-option"
            :class="{ active: mode === opt.value }"
            @click="theme.setMode(opt.value)"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>
    </t-dialog>
  </div>
</template>

<style scoped>
.settings-trigger {
  width: 100%;
  justify-content: flex-start;
  color: var(--caleo-sidebar-sub) !important;
  background: transparent !important;
}
.settings-trigger:hover {
  color: var(--caleo-primary) !important;
  background: var(--caleo-sidebar-hover) !important;
}

.settings-title {
  margin: 0 0 12px;
  font-size: 14px;
  color: var(--caleo-text-secondary);
}

.theme-options {
  display: flex;
  gap: 8px;
}

.theme-option {
  flex: 1;
  padding: 10px 12px;
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  background: var(--caleo-surface);
  color: var(--caleo-text);
  font-size: 14px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    color 0.15s;
}

.theme-option:hover {
  border-color: var(--caleo-primary);
  background: var(--caleo-surface-hover);
}

.theme-option.active {
  border-color: var(--caleo-primary);
  color: var(--caleo-primary);
  font-weight: 600;
}
</style>

<style>
.settings-dialog .t-dialog {
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
}

.settings-dialog .t-dialog__header {
  border-bottom: 1px solid var(--caleo-border);
}

.settings-dialog .t-dialog .title {
  color: var(--caleo-text);
}
</style>
