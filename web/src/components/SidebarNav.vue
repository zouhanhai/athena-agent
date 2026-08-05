<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { storeToRefs } from "pinia";
import {
  BookIcon,
  ChatBubbleIcon,
  FolderOpenIcon,
  ViewGanttIcon,
} from "tdesign-icons-vue-next";
import type { Component } from "vue";
import SettingsPanel from "@/components/SettingsPanel.vue";
import { useThemeStore } from "@/stores/theme";

interface NavItem {
  label: string;
  path: string;
  icon: Component;
}

const route = useRoute();
const activeMenu = computed(() => route.path);

const theme = useThemeStore();
const { mode } = storeToRefs(theme);
const menuTheme = computed(() => (mode.value === "dark" ? "dark" : "light"));

const navItems: NavItem[] = [
  { label: "Chat", path: "/chat", icon: ChatBubbleIcon },
  { label: "Knowledge", path: "/knowledge", icon: BookIcon },
  { label: "Kanban", path: "/kanban", icon: ViewGanttIcon },
  { label: "Wiki", path: "/wiki", icon: FolderOpenIcon },
];
</script>

<template>
  <t-aside class="app-aside">
    <header class="app-header">
      <div class="brand">
        <img
          class="brand-logo"
          src="/caleo-logo.png"
          alt="CALEO logo"
        />
        <div class="brand-text">
          <span class="brand-name">Athena Agent</span>
          <span class="brand-tag">CALEO Portal</span>
        </div>
      </div>
    </header>
    <t-menu :theme="menuTheme" class="side-menu" :value="activeMenu">
      <t-menu-item
        v-for="item in navItems"
        :key="item.path"
        :value="item.path"
        :to="item.path"
      >
        <template #icon>
          <component :is="item.icon" />
        </template>
        {{ item.label }}
      </t-menu-item>
    </t-menu>
    <footer class="app-footer">
      <SettingsPanel />
    </footer>
  </t-aside>
</template>

<style scoped>
.app-aside {
  width: 220px;
  height: 100%;
  background: var(--caleo-sidebar-bg);
  border-right: 1px solid var(--caleo-sidebar-border);
  display: flex;
  flex-direction: column;
}

.app-header {
  padding: 20px 16px;
  border-bottom: 1px solid var(--caleo-sidebar-border);
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.brand-logo {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  object-fit: contain;
  flex-shrink: 0;
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}

.brand-name {
  color: var(--caleo-sidebar-text);
  font-size: 15px;
  font-weight: 600;
}

.brand-tag {
  color: var(--caleo-sidebar-sub);
  font-size: 12px;
}

.side-menu {
  flex: 1;
  width: 100%;
  padding-top: 8px;
}

.app-footer {
  padding: 12px 16px;
  border-top: 1px solid var(--caleo-sidebar-border);
}
</style>
