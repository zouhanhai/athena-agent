<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
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

// Resizable chat panel: drag the splitter between content and chat to resize.
// chatWidth is in px, applied via --chat-panel-width. Persisted in localStorage.
const chatWidth = ref<number>(360);
const CHAT_MIN = 280;
const CHAT_MAX_VW = 70;
let dragging = false;

const persisted = Number(localStorage.getItem("athena.chatWidth") ?? 0);
if (persisted && persisted >= CHAT_MIN) {
  chatWidth.value = persisted;
}

function panelStyle(): Record<string, string> {
  return { "--chat-panel-width": `${chatWidth.value}px` } as Record<string, string>;
}

function onSplitterDown(event: PointerEvent): void {
  dragging = true;
  event.preventDefault();
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function onSplitterMove(event: PointerEvent): void {
  if (!dragging) return;
  const maxWidth = Math.round((window.innerWidth * CHAT_MAX_VW) / 100);
  const width = Math.min(Math.max(window.innerWidth - event.clientX, CHAT_MIN), maxWidth);
  chatWidth.value = width;
}

function onSplitterUp(event: PointerEvent): void {
  if (!dragging) return;
  dragging = false;
  (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  localStorage.setItem("athena.chatWidth", String(chatWidth.value));
}

onMounted(() => {
  auth.bootstrap();
});
</script>

<template>
  <t-layout class="app-shell" :style="panelStyle()">
    <SidebarNav />
    <t-content class="app-content">
      <router-view />
    </t-content>
    <div
      class="chat-splitter"
      title="Drag to resize chat panel"
      @pointerdown="onSplitterDown"
      @pointermove="onSplitterMove"
      @pointerup="onSplitterUp"
      @pointercancel="onSplitterUp"
    />
    <GlobalChatPanel />
  </t-layout>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
  min-height: 100dvh;
}

.app-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  height: 100vh;
  height: 100dvh;
  overflow: auto;
  background: var(--caleo-body-bg);
}

.chat-splitter {
  width: 5px;
  cursor: col-resize;
  flex-shrink: 0;
  background: var(--caleo-border);
  transition: width 0.15s, background 0.15s;
  touch-action: none;
}

.chat-splitter:hover,
.chat-splitter:active {
  width: 10px;
  background: var(--caleo-primary);
}
</style>
