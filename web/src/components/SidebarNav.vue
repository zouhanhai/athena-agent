<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { storeToRefs } from "pinia";
import {
  BookIcon,
  FolderOpenIcon,
  TerminalIcon,
  FileIcon,
  UploadIcon,
  SettingIcon,
  ChatBubbleHelpIcon,
  UserSafetyIcon,
} from "tdesign-icons-vue-next";
import type { Component } from "vue";
import ThemeToggle from "@/components/ThemeToggle.vue";
import { useThemeStore } from "@/stores/theme";
import { useAuthStore } from "@/stores/auth";

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

const auth = useAuthStore();
const isAdmin = computed(() => auth.employee?.role === "admin");

// G4.S3.T11: reactive nav — the Admin entry is appended (near Settings) only
// for signed-in employees with role=admin; members never see it.
const navItems = computed<NavItem[]>(() => {
  const items: NavItem[] = [
    { label: "Knowledge", path: "/knowledge", icon: BookIcon },
    { label: "Wiki", path: "/wiki", icon: FolderOpenIcon },
    { label: "Workbench", path: "/workbench", icon: TerminalIcon },
    { label: "Output", path: "/output", icon: FileIcon },
    { label: "Uploads", path: "/uploads", icon: UploadIcon },
    { label: "Terms & QA", path: "/terms-qa", icon: ChatBubbleHelpIcon },
  ];
  if (isAdmin.value) {
    items.push({ label: "Admin", path: "/admin", icon: UserSafetyIcon });
  }
  items.push({ label: "Settings", path: "/settings", icon: SettingIcon });
  return items;
});

const sidebarTopOffset = "24px";
</script>

<template>
  <t-aside class="app-aside" :style="{ paddingTop: sidebarTopOffset }">
    <header class="app-header">
      <div class="brand">
        <img
          class="brand-logo"
          src="/athena-logo-ai.png"
          alt="Athena Agent logo"
        />
        <div class="brand-text">
          <span class="brand-name">Athena Agent</span>
          <img
            class="brand-caleo-logo"
            src="/caleo-logo-word.png"
            alt="CALEO"
          />
        </div>
      </div>
    </header>
    <t-menu
      :theme="menuTheme"
      class="side-menu"
      :value="activeMenu"
      width="100%"
    >
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
      <ThemeToggle />
    </footer>
  </t-aside>
</template>

<style scoped>
.app-aside {
  width: 220px;
  min-height: 100vh;
  min-height: 100dvh;
  background: var(--caleo-sidebar-bg);
  border-right: 1px solid var(--caleo-sidebar-border);
  display: flex;
  flex-direction: column;
}

.app-header {
  padding: 16px 16px 20px;
  border-bottom: 1px solid var(--caleo-sidebar-border);
  background: var(--caleo-sidebar-bg);
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  text-align: left;
}

.brand-logo {
  width: 44px;
  height: 44px;
  object-fit: contain;
  flex-shrink: 0;
}

.brand-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.brand-name {
  color: var(--caleo-sidebar-text);
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.2px;
  white-space: nowrap;
}

.brand-caleo-logo {
  height: 18px;
  width: auto;
  object-fit: contain;
  margin-top: 1px;
}

.side-menu {
  flex: 1;
  width: 100%;
  padding-top: 8px;
  background: var(--caleo-sidebar-bg);
}

.side-menu :deep(.t-menu__item) {
  color: var(--caleo-sidebar-sub);
}

.side-menu :deep(.t-menu__item:hover) {
  color: var(--caleo-sidebar-text);
  background: var(--caleo-sidebar-hover);
}

.side-menu :deep(.t-menu__item.t-is-active) {
  color: var(--caleo-primary);
  background: var(--caleo-sidebar-active);
}

.side-menu :deep(.t-menu__item.t-is-active .t-icon) {
  color: var(--caleo-primary);
}

.app-footer {
  padding: 12px 16px;
  border-top: 1px solid var(--caleo-sidebar-border);
  background: var(--caleo-sidebar-bg);
}
</style>
