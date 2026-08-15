import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import App from "@/App.vue";
import router from "@/router";
import { installAuthSession } from "./helpers/auth-session";

beforeEach(() => {
  localStorage.clear();
});

async function mountWithRole(role: "admin" | "member") {
  const pinia = createPinia();
  const employee = {
    id: "e1",
    email: role === "admin" ? "admin@caleo.com" : "member@caleo.com",
    display_name: role === "admin" ? "Admin User" : "Member User",
    logo_url: "/logos/fox-clean.png",
    role,
    created_at: "2026-08-08T00:00:00.000Z",
    updated_at: "2026-08-08T00:00:00.000Z",
  };
  // Sign in before mounting so the global auth guard lets the page load; also
  // stubs fetch so App's bootstrap() (GET /api/me) keeps the session.
  installAuthSession(pinia, employee);
  const wrapper = mount(App, {
    global: { plugins: [pinia, TDesign, router] },
    attachTo: document.body,
  });
  await router.isReady();
  await flushPromises();
  return wrapper;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function navLabels(wrapper: Awaited<ReturnType<typeof mountWithRole>>) {
  return wrapper.findAll(".t-menu__item").map((item) => item.text().trim());
}

describe("sidebar admin nav (G4.S3.T11)", () => {
  it("shows an Admin item near Settings for an admin employee", async () => {
    const wrapper = await mountWithRole("admin");
    const labels = navLabels(wrapper);
    expect(labels).toContain("Admin");
    // Near Settings (immediately before it).
    expect(labels[labels.length - 2]).toBe("Admin");
    expect(labels[labels.length - 1]).toBe("Settings");
    wrapper.unmount();
  });

  it("hides the Admin item for a member employee", async () => {
    const wrapper = await mountWithRole("member");
    const labels = navLabels(wrapper);
    expect(labels.some((text) => text.includes("Admin"))).toBe(false);
    wrapper.unmount();
  });

  it("redirects a member away from /admin (navigation guard)", async () => {
    const wrapper = await mountWithRole("member");
    await router.push("/admin");
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(router.currentRoute.value.path).toBe("/knowledge");
    wrapper.unmount();
  });
});
