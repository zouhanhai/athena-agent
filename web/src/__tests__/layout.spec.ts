import { describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import App from "@/App.vue";
import router from "@/router";

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
      plugins: [TDesign, router],
    },
    attachTo: document.body,
  });
  await router.isReady();
  await flushPromises();
  return wrapper;
}

type AppWrapper = Awaited<ReturnType<typeof mountApp>>;

function navItems(wrapper: AppWrapper) {
  return wrapper.findAll(".t-menu__item");
}

function navItemByText(wrapper: AppWrapper, label: string) {
  return navItems(wrapper).find((item) => item.text().includes(label));
}

describe("portal sidebar navigation", () => {
  it("renders the sidebar with Chat / Knowledge / Kanban / Wiki items", async () => {
    const wrapper = await mountApp();
    const labels = navItems(wrapper).map((item) => item.text());
    for (const label of ["Chat", "Knowledge", "Kanban", "Wiki"]) {
      expect(labels.some((text) => text.includes(label))).toBe(true);
    }
    wrapper.unmount();
  });

  it("renders the CALEO brand in the sidebar header", async () => {
    const wrapper = await mountApp();
    expect(wrapper.find(".app-header").exists()).toBe(true);
    expect(wrapper.text()).toContain("Athena Agent");
    wrapper.unmount();
  });

  it("redirects / to /chat and shows the chat view", async () => {
    const wrapper = await mountApp();
    await router.push("/");
    await waitForRoute("/chat");
    await flushPromises();
    expect(wrapper.text()).toContain("Personal Chat");
    wrapper.unmount();
  });

  it("navigates to /knowledge when the Knowledge item is clicked", async () => {
    const wrapper = await mountApp();
    const knowledge = navItemByText(wrapper, "Knowledge");
    expect(knowledge).toBeDefined();
    await knowledge!.trigger("click");
    await waitForRoute("/knowledge");
    await flushPromises();
    expect(wrapper.text()).toContain("Knowledge graph");
    wrapper.unmount();
  });

  it("highlights the nav item of the active route", async () => {
    const wrapper = await mountApp();
    await router.push("/kanban");
    await flushPromises();
    const active = navItems(wrapper).filter((item) =>
      item.classes().includes("t-is-active"),
    );
    expect(active).toHaveLength(1);
    expect(active[0]!.text()).toContain("Kanban");
    wrapper.unmount();
  });
});

describe("CALEO theme", () => {
  it("applies CALEO brand colors as CSS custom properties on the app root", async () => {
    const wrapper = await mountApp();
    const style = (wrapper.element as HTMLElement).style;
    expect(style.getPropertyValue("--caleo-primary")).toBe("#ff6633");
    expect(style.getPropertyValue("--caleo-dark")).toBe("#2d3142");
    expect(style.getPropertyValue("--caleo-sky")).toBe("#69b3e7");
    expect(style.getPropertyValue("--td-brand-color")).toBe("#ff6633");
    wrapper.unmount();
  });
});
