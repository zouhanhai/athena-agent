<script setup lang="ts">
import SidebarNav from "@/components/SidebarNav.vue";
import { caleoThemeVars } from "@/theme";
</script>

<template>
  <t-layout class="app-shell" :style="caleoThemeVars()">
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
  background: #f5f6f7;
}
</style>
