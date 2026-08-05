import { describe, expect, it, beforeEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import App from "@/App.vue";
import router from "@/router";
import { useThemeStore } from "@/stores/theme";

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

  it("shows the Athena owl logo before the brand name with a CALEO Portal subtitle", async () => {
    const wrapper = await mountApp();
    const header = wrapper.find(".app-header");
    const logo = header.find(".brand-logo");
    const brandName = header.find(".brand-name");
    const subtitle = header.find(".brand-subtitle");

    expect(logo.exists()).toBe(true);
    const src = logo.attributes("src")!;
    expect(src).toBe("/athena-logo-ai.png");
    // CALEO logo 作为副标题图片
    expect(header.find('img[src="/caleo-logo-clean.png"]').exists()).toBe(true);
    expect(subtitle.exists()).toBe(false);
    expect(logo.element.compareDocumentPosition(brandName.element)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(brandName.text()).toBe("Athena Agent");
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

  it("nav menu fills the sidebar width and does not protrude", async () => {
    const wrapper = await mountApp();
    const menu = wrapper.find(".side-menu");
    expect(menu.exists()).toBe(true);
    expect(menu.attributes("style")).toContain("width: 100%");
    expect(menu.element.parentElement).toBe(wrapper.find(".app-aside").element);
    wrapper.unmount();
  });

  it("offsets the sidebar content from the top of the viewport", async () => {
    const wrapper = await mountApp();
    const aside = wrapper.find(".app-aside").element as HTMLElement;
    const paddingTop = parseInt(getComputedStyle(aside).paddingTop, 10);
    expect(paddingTop).toBeGreaterThan(0);
    wrapper.unmount();
  });

  it("pins the Settings button to the very bottom of the sidebar", async () => {
    const wrapper = await mountApp();
    const aside = wrapper.find(".app-aside");
    const children = Array.from(aside.element.children);
    const last = children[children.length - 1];
    expect(last.classList.contains("app-footer")).toBe(true);
    expect(wrapper.find(".app-footer .settings-trigger").exists()).toBe(true);
    wrapper.unmount();
  });
});

describe("CALEO theme", () => {
  it("applies CALEO brand colors as CSS custom properties on the document root", async () => {
    await mountApp();
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--caleo-primary")).toBe("#ff6633");
    expect(root.style.getPropertyValue("--caleo-dark")).toBe("#2d3142");
    expect(root.style.getPropertyValue("--caleo-sky")).toBe("#69b3e7");
    expect(root.style.getPropertyValue("--td-brand-color")).toBe("#ff6633");
  });

  it("re-themes TDesign component variables when switching theme", async () => {
    await mountApp();
    const root = document.documentElement;

    expect(root.style.getPropertyValue("--td-bg-color-page")).toBe("#1f2128");
    expect(root.style.getPropertyValue("--td-bg-color-container")).toBe("#262a33");

    useThemeStore().setMode("light");
    await flushPromises();

    expect(root.style.getPropertyValue("--td-bg-color-page")).toBe("#f0f1f3");
    expect(root.style.getPropertyValue("--td-bg-color-container")).toBe("#ffffff");
  });
});

describe("theme settings panel", () => {
  function themeOptions(wrapper: AppWrapper) {
    return wrapper.findAll(".theme-option");
  }

  it("renders a settings button at the sidebar bottom", async () => {
    const wrapper = await mountApp();
    expect(wrapper.find(".settings-trigger").exists()).toBe(true);
    wrapper.unmount();
  });

  it("opens a dialog with dark and light theme options", async () => {
    const wrapper = await mountApp();
    await wrapper.find(".settings-trigger").trigger("click");
    await flushPromises();

    const options = themeOptions(wrapper);
    const labels = options.map((el) => el.text());
    expect(options).toHaveLength(2);
    expect(labels.some((t) => t.includes("Dark"))).toBe(true);
    expect(labels.some((t) => t.includes("Light"))).toBe(true);
    wrapper.unmount();
  });

  it("switches to light theme globally and persists the choice", async () => {
    const wrapper = await mountApp();
    await wrapper.find(".settings-trigger").trigger("click");
    await flushPromises();

    const light = themeOptions(wrapper).find((el) =>
      el.text().includes("Light"),
    );
    await light!.trigger("click");
    await flushPromises();

    expect(useThemeStore().mode).toBe("light");
    expect(
      document.documentElement.style.getPropertyValue("--caleo-body-bg"),
    ).toBe("#f0f1f3");
    expect(localStorage.getItem("caleo-theme")).toBe("light");
    wrapper.unmount();
  });
});
