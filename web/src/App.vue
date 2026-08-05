<script setup lang="ts"></script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <h1>Athena Agent</h1>
      <span class="app-tag">CALEO Portal</span>
    </header>
    <main class="app-content">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  height: 56px;
  background: #2d3142;
  color: #fff;
}

.app-header h1 {
  font-size: 18px;
  margin: 0;
}

.app-tag {
  color: #ff6633;
  font-size: 13px;
}

.app-content {
  flex: 1;
  padding: 24px;
}
</style>
