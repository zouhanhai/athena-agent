<script setup lang="ts">
import { ref } from "vue";

type WorkbenchTabValue = "code" | "issues" | "kanban";

interface WorkbenchTab {
  value: WorkbenchTabValue;
  label: string;
  description: string;
}

const tabs: WorkbenchTab[] = [
  {
    value: "code",
    label: "Code",
    description:
      "Browse repositories as a GitHub-style file tree with branch selector and syntax-highlighted code view. Coming in G3.S4.T2.",
  },
  {
    value: "issues",
    label: "Issues",
    description:
      "View issues as a GitHub-style list with open/closed state, labels and assignees. Coming in G3.S4.T3.",
  },
  {
    value: "kanban",
    label: "Kanban",
    description:
      "Track Goals/Specs/Tickets as a board fed by the docs-scan. Coming in G3.S4.T4.",
  },
];

const activeTab = ref<WorkbenchTabValue>("code");
</script>

<template>
  <section class="workbench-view">
    <header class="workbench-header">
      <h2 class="workbench-title">Workbench</h2>
      <span class="workbench-meta">3 GitHub-style tabs</span>
    </header>

    <t-tabs v-model="activeTab" class="workbench-tabs">
      <t-tab-panel
        v-for="tab in tabs"
        :key="tab.value"
        :value="tab.value"
        :label="tab.label"
      >
        <div class="tab-panel" :class="`tab-panel-${tab.value}`">
          <h3 class="tab-title">{{ tab.label }}</h3>
          <p class="tab-description">{{ tab.description }}</p>
        </div>
      </t-tab-panel>
    </t-tabs>
  </section>
</template>

<style scoped>
.workbench-view {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 48px);
  padding: 24px;
}

.workbench-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
  padding: 16px 20px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  box-shadow: var(--caleo-shadow);
}

.workbench-title {
  margin: 0;
  font-size: 20px;
  color: var(--caleo-text);
}

.workbench-meta {
  font-size: 13px;
  color: var(--caleo-text-secondary);
}

.workbench-tabs {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  box-shadow: var(--caleo-shadow);
}

.workbench-tabs :deep(.t-tabs__nav) {
  padding: 0 8px;
  border-bottom: 1px solid var(--caleo-border);
}

.workbench-tabs :deep(.t-tabs__nav-item) {
  font-size: 14px;
  color: var(--caleo-text-secondary);
}

.workbench-tabs :deep(.t-tabs__nav-item:hover) {
  color: var(--caleo-text);
}

.workbench-tabs :deep(.t-tabs__nav-item.t-is-active) {
  color: var(--caleo-primary);
}

.workbench-tabs :deep(.t-tabs__content) {
  flex: 1;
  min-height: 0;
}

.workbench-tabs :deep(.t-tabs__panel) {
  height: 100%;
}

.tab-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  padding: 40px;
  gap: 12px;
  color: var(--caleo-text);
}

.tab-title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
}

.tab-description {
  margin: 0;
  max-width: 520px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--caleo-text-secondary);
}
</style>
