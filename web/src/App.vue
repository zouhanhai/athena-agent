<script setup lang="ts">
import { onMounted, watch } from "vue";
import { useRoute } from "vue-router";
import SidebarNav from "@/components/SidebarNav.vue";
import GlobalChatPanel from "@/components/GlobalChatPanel.vue";
import { applyTheme } from "@/theme";
import { useThemeStore } from "@/stores/theme";
import { useAuthStore } from "@/stores/auth";
import { useChatStore } from "@/stores/chat";

const theme = useThemeStore();
const auth = useAuthStore();
const chat = useChatStore();
const route = useRoute();

watch(
  () => theme.mode,
  (mode) => applyTheme(mode),
  { immediate: true },
);

// Page-aware context injection: track the active page so the global chat sends
// the current page with each message. Switching tabs keeps the shared
// conversation context — only the injected capabilities follow the page.
watch(
  () => route.path,
  (path) => chat.setPage(path),
  { immediate: true },
);

onMounted(() => {
  auth.bootstrap();
});
</script>

<template>
  <t-layout class="app-shell">
    <SidebarNav />
    <t-content class="app-content">
      <router-view />
    </t-content>
    <GlobalChatPanel />
  </t-layout>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
}

.app-content {
  flex: 1;
  min-width: 0;
  background: var(--caleo-body-bg);
}
</style>
