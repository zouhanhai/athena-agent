<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import {
  BookIcon,
  ChatBubbleIcon,
  FolderOpenIcon,
  ViewGanttIcon,
} from "tdesign-icons-vue-next";
import type { Component } from "vue";

interface NavItem {
  label: string;
  path: string;
  icon: Component;
}

const route = useRoute();
const activeMenu = computed(() => route.path);

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
        <span class="brand-mark">C</span>
        <div class="brand-text">
          <span class="brand-name">Athena Agent</span>
          <span class="brand-tag">CALEO Portal</span>
        </div>
      </div>
    </header>
    <t-menu theme="dark" class="side-menu" :value="activeMenu">
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
  </t-aside>
</template>

<style scoped>
.app-aside {
  width: 220px;
  height: 100%;
  background: var(--caleo-dark);
  display: flex;
  flex-direction: column;
}

.app-header {
  padding: 20px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  background: var(--caleo-primary);
  color: #fff;
  font-weight: 700;
  font-size: 18px;
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}

.brand-name {
  color: #fff;
  font-size: 15px;
  font-weight: 600;
}

.brand-tag {
  color: var(--caleo-sky);
  font-size: 12px;
}

.side-menu {
  flex: 1;
  width: 100%;
  padding-top: 8px;
}
</style>
