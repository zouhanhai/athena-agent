import { createRouter, createWebHistory } from "vue-router";
import type { RouteRecordRaw } from "vue-router";

const routes: RouteRecordRaw[] = [
  {
    path: "/",
    redirect: "/knowledge",
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
    path: "/register",
    name: "register",
    component: () => import("../views/RegisterView.vue"),
  },
  {
    path: "/login",
    name: "login",
    component: () => import("../views/LoginView.vue"),
  },
  {
    path: "/auth/verify",
    name: "verify",
    component: () => import("../views/AuthVerifyView.vue"),
  },
  {
    path: "/wiki",
    name: "wiki",
    component: () => import("../views/WikiView.vue"),
  },
  {
    path: "/workbench",
    name: "workbench",
    component: () => import("../views/WorkbenchView.vue"),
  },
  {
    path: "/uploads",
    name: "uploads",
    component: () => import("../views/UploadsView.vue"),
  },
];

export default createRouter({
  history: createWebHistory(),
  routes,
});
