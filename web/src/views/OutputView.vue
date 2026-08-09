<script setup lang="ts">
</script>

<template>
  <section class="output-view">
    <header class="output-header">
      <h2 class="output-title">Output</h2>
      <span class="output-meta">Generated deliverables and reports</span>
    </header>

    <div class="output-body">
      <p class="output-placeholder">Output — coming in M5</p>
      <p class="output-sub">
        Full output generation ships in milestone M5.
      </p>
    </div>
  </section>
</template>

<style scoped>
.output-view {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 48px);
  height: calc(100dvh - 48px);
  padding: 24px;
  gap: 16px;
  overflow-y: auto;
}

.output-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
}

.output-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.2px;
  color: var(--caleo-text);
}

.output-meta {
  font-size: 13px;
  color: var(--caleo-text-secondary);
}

.output-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  background: var(--caleo-surface);
  border: 1px solid var(--caleo-border);
  border-radius: 8px;
  box-shadow: var(--caleo-shadow);
}

.output-placeholder {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--caleo-text);
}

.output-sub {
  margin: 0;
  font-size: 13px;
  color: var(--caleo-text-secondary);
}
</style>
