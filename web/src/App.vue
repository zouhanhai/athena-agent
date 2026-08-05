<script setup lang="ts">
import { watch } from "vue";
import SidebarNav from "@/components/SidebarNav.vue";
import { applyTheme } from "@/theme";
import { useThemeStore } from "@/stores/theme";

const theme = useThemeStore();

watch(
  () => theme.mode,
  (mode) => applyTheme(mode),
  { immediate: true },
);
</script>

<template>
  <t-layout class="app-shell">
    <SidebarNav />
    <t-content class="app-content">
      <router-view />
    </t-content>
  </t-layout>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
}

.app-content {
  background: var(--caleo-body-bg);
}
</style>
