<script setup lang="ts">
import { ref } from "vue";
import CodeTab from "@/components/CodeTab.vue";
import IssuesTab from "@/components/IssuesTab.vue";
import KanbanTab from "@/components/KanbanTab.vue";

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
      "Browse repositories as a GitHub-style file tree with branch selector and syntax-highlighted code view.",
  },
  {
    value: "issues",
    label: "Issues",
    description:
      "View issues as a GitHub-style list with open/closed state, labels and assignees.",
  },
  {
    value: "kanban",
    label: "Kanban",
    description:
      "Track Goals/Specs/Tickets as a board fed by the docs-scan.",
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
          <template v-if="tab.value === 'code'">
            <CodeTab class="code-tab-host" />
          </template>
          <template v-else-if="tab.value === 'issues'">
            <IssuesTab class="issues-tab-host" />
          </template>
          <template v-else>
            <KanbanTab class="kanban-tab-host" />
          </template>
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
  height: calc(100dvh - 48px);
  padding: 24px;
}

.workbench-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  padding: 10px 14px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
}

.workbench-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.2px;
  color: var(--caleo-text);
}

.workbench-meta {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
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

.tab-panel-code {
  padding: 0;
  justify-content: stretch;
  gap: 0;
}

.tab-panel-issues {
  padding: 0;
  justify-content: stretch;
  gap: 0;
}

.tab-panel-kanban {
  padding: 0;
  justify-content: stretch;
  gap: 0;
}

.code-tab-host {
  flex: 1;
  min-height: 0;
  width: 100%;
}

.issues-tab-host {
  flex: 1;
  min-height: 0;
  width: 100%;
}

.kanban-tab-host {
  flex: 1;
  min-height: 0;
  width: 100%;
}
</style>
