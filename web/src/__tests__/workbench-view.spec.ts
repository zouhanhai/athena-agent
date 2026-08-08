import { describe, expect, it, beforeEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import App from "@/App.vue";
import router from "@/router";
import { useChatStore } from "@/stores/chat";

beforeEach(() => {
  localStorage.clear();
});

async function waitForRoute(path: string) {
  for (let i = 0; i < 100; i++) {
    if (router.currentRoute.value.path === path) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`route did not become "${path}"`);
}

async function mountApp() {
  const wrapper = mount(App, {
    global: {
      plugins: [createPinia(), TDesign, router],
    },
    attachTo: document.body,
  });
  await router.isReady();
  await flushPromises();
  return wrapper;
}

type AppWrapper = Awaited<ReturnType<typeof mountApp>>;

function navItemByText(wrapper: AppWrapper, label: string) {
  return wrapper.findAll(".t-menu__item").find((item) => item.text().includes(label));
}

function tabItems(wrapper: AppWrapper) {
  return wrapper.findAll(".workbench-tabs .t-tabs__nav-item");
}

function tabByText(wrapper: AppWrapper, label: string) {
  return tabItems(wrapper).find((item) => item.text().includes(label));
}

describe("workbench page", () => {
  it("renders a Workbench nav item in the sidebar", async () => {
    const wrapper = await mountApp();
    const workbench = navItemByText(wrapper, "Workbench");
    expect(workbench).toBeDefined();
    wrapper.unmount();
  });

  it("navigates to /workbench when the Workbench item is clicked", async () => {
    const wrapper = await mountApp();
    const workbench = navItemByText(wrapper, "Workbench");
    expect(workbench).toBeDefined();
    await workbench!.trigger("click");
    await waitForRoute("/workbench");
    await flushPromises();
    expect(wrapper.find(".workbench-view").exists()).toBe(true);
    wrapper.unmount();
  });

  it("renders the 3 GitHub-style tabs Code / Issues / Kanban", async () => {
    const wrapper = await mountApp();
    await router.push("/workbench");
    await waitForRoute("/workbench");
    await flushPromises();
    const labels = tabItems(wrapper).map((item) => item.text());
    expect(labels.some((text) => text.includes("Code"))).toBe(true);
    expect(labels.some((text) => text.includes("Issues"))).toBe(true);
    expect(labels.some((text) => text.includes("Kanban"))).toBe(true);
    wrapper.unmount();
  });

  it("shows the Code tab by default", async () => {
    const wrapper = await mountApp();
    await router.push("/workbench");
    await waitForRoute("/workbench");
    await flushPromises();
    expect(wrapper.find(".tab-panel-code").exists()).toBe(true);
    expect(wrapper.find(".tab-panel-issues").exists()).toBe(false);
    expect(wrapper.find(".tab-panel-kanban").exists()).toBe(false);
    wrapper.unmount();
  });

  it("switches to the Issues tab when clicked", async () => {
    const wrapper = await mountApp();
    await router.push("/workbench");
    await waitForRoute("/workbench");
    await flushPromises();
    const issues = tabByText(wrapper, "Issues");
    expect(issues).toBeDefined();
    await issues!.trigger("click");
    await flushPromises();
    expect(wrapper.find(".tab-panel-issues").exists()).toBe(true);
    expect(wrapper.find(".tab-panel-code").exists()).toBe(false);
    wrapper.unmount();
  });

  it("switches to the Kanban tab when clicked", async () => {
    const wrapper = await mountApp();
    await router.push("/workbench");
    await waitForRoute("/workbench");
    await flushPromises();
    const kanban = tabByText(wrapper, "Kanban");
    expect(kanban).toBeDefined();
    await kanban!.trigger("click");
    await flushPromises();
    expect(wrapper.find(".tab-panel-kanban").exists()).toBe(true);
    expect(wrapper.find(".tab-panel-code").exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps the global chat panel mounted on the workbench page", async () => {
    const wrapper = await mountApp();
    await router.push("/workbench");
    await waitForRoute("/workbench");
    await flushPromises();
    expect(wrapper.find(".global-chat-panel").exists()).toBe(true);
    expect(wrapper.find(".global-chat-panel .chat-composer").exists()).toBe(true);
    wrapper.unmount();
  });

  it("tracks /workbench as the chat page context", async () => {
    const wrapper = await mountApp();
    const chat = useChatStore();
    await router.push("/workbench");
    await waitForRoute("/workbench");
    await flushPromises();
    expect(chat.page).toBe("/workbench");
    expect(wrapper.text()).toContain("Context: Workbench");
    wrapper.unmount();
  });
});
