import { createRouter, createWebHistory } from "vue-router";
import type { RouteRecordRaw } from "vue-router";

const routes: RouteRecordRaw[] = [
  {
    path: "/",
    redirect: "/chat",
  },
  {
    path: "/chat",
    name: "chat",
    component: () => import("../views/ChatView.vue"),
  },
  {
    path: "/knowledge",
    name: "knowledge",
    component: () => import("../views/KnowledgeView.vue"),
  },
  {
    path: "/kanban",
    name: "kanban",
    component: () => import("../views/KanbanView.vue"),
  },
  {
    path: "/agents",
    name: "agents",
    component: () => import("../views/AgentRegistrationView.vue"),
  },
  {
    path: "/wiki",
    name: "wiki",
    component: () => import("../views/WikiView.vue"),
  },
];

export default createRouter({
  history: createWebHistory(),
  routes,
});
