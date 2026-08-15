import { createRouter, createWebHistory } from "vue-router";
import type { RouteRecordRaw } from "vue-router";
import { getActivePinia } from "pinia";
import { useAuthStore } from "@/stores/auth";

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
  {
    path: "/terms-qa",
    name: "terms-qa",
    component: () => import("../views/TermsQaView.vue"),
  },
  {
    path: "/output",
    name: "output",
    component: () => import("../views/OutputView.vue"),
  },
  {
    path: "/settings",
    name: "settings",
    component: () => import("../views/SettingsView.vue"),
  },
  {
    path: "/admin",
    name: "admin",
    component: () => import("../views/AdminView.vue"),
    meta: { requiresAdmin: true },
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

// G4.S3.T11: /admin is admin-only. Members (or signed-out users) are sent to
// the Knowledge page; the sidebar hides the entry for them too. Guard is a
// no-op when Pinia is not installed (e.g. isolated router tests).
router.beforeEach((to) => {
  if (!getActivePinia()) {
    return true;
  }
  const auth = useAuthStore();

  // Public routes (login / register / magic-link verify) never require auth.
  const publicRoutes = ["login", "register", "verify"];
  if (publicRoutes.includes(to.name as string)) {
    return true;
  }

  // Global auth guard (athenakb.com is public): any other page requires a
  // logged-in session; otherwise redirect to /login.
  if (!auth.isAuthenticated) {
    return { path: "/login", query: { redirect: to.fullPath } };
  }

  // Admin-only guard.
  if (to.meta.requiresAdmin && auth.employee?.role !== "admin") {
    return { path: "/knowledge" };
  }

  return true;
});

export default router;
