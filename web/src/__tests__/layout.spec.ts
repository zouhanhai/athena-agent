import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import App from "@/App.vue";
import router from "@/router";
import { useThemeStore } from "@/stores/theme";
import { useChatStore } from "@/stores/chat";
import { installAuthSession } from "./helpers/auth-session";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function waitForRoute(path: string) {
  for (let i = 0; i < 100; i++) {
    if (router.currentRoute.value.path === path) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`route did not become "${path}"`);
}

async function mountApp() {
  const pinia = createPinia();
  // Sign in before mounting so the global auth guard lets these protected
  // pages load (survives the per-test localStorage.clear() in beforeEach).
  installAuthSession(pinia);
  const wrapper = mount(App, {
    global: {
      plugins: [pinia, TDesign, router],
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
  it("renders the 7 nav items in exact order and no Chat / Agents", async () => {
    const wrapper = await mountApp();
    const labels = navItems(wrapper).map((item) => item.text().trim());
    expect(labels).toEqual([
      "Knowledge",
      "Wiki",
      "Workbench",
      "Output",
      "Uploads",
      "Terms & QA",
      "Settings",
    ]);
    expect(labels.some((text) => text.includes("Chat"))).toBe(false);
    expect(labels.some((text) => text.includes("Agents"))).toBe(false);
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
    // CALEO logo as subtitle image (cropped word variant)
    expect(header.find('img[src="/caleo-logo-word.png"]').exists()).toBe(true);
    expect(subtitle.exists()).toBe(false);
    expect(logo.element.compareDocumentPosition(brandName.element)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(brandName.text()).toBe("Athena Agent");
    wrapper.unmount();
  });

  it("redirects / to /knowledge and shows the knowledge view", async () => {
    const wrapper = await mountApp();
    await router.push("/");
    await waitForRoute("/knowledge");
    await flushPromises();
    expect(wrapper.text()).toContain("Knowledge Graph");
    wrapper.unmount();
  });

  it("navigates to /knowledge when the Knowledge item is clicked", async () => {
    const wrapper = await mountApp();
    const knowledge = navItemByText(wrapper, "Knowledge");
    expect(knowledge).toBeDefined();
    await knowledge!.trigger("click");
    await waitForRoute("/knowledge");
    await flushPromises();
    expect(wrapper.text()).toContain("Knowledge Graph");
    wrapper.unmount();
  });

  it("highlights the nav item of the active route", async () => {
    const wrapper = await mountApp();
    await router.push("/workbench");
    await flushPromises();
    const active = navItems(wrapper).filter((item) =>
      item.classes().includes("t-is-active"),
    );
    expect(active).toHaveLength(1);
    expect(active[0]!.text()).toContain("Workbench");
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

  it("pins the footer to the very bottom of the sidebar", async () => {
    const wrapper = await mountApp();
    const aside = wrapper.find(".app-aside");
    const children = Array.from(aside.element.children);
    const last = children[children.length - 1];
    expect(last.classList.contains("app-footer")).toBe(true);
    expect(wrapper.find(".app-footer .theme-toggle").exists()).toBe(true);
    wrapper.unmount();
  });

  it("removes the SettingsPanel dialog trigger from the footer (only ThemeToggle remains)", async () => {
    const wrapper = await mountApp();
    const footer = wrapper.find(".app-footer");
    expect(footer.find(".theme-toggle").exists()).toBe(true);
    expect(footer.find(".settings-trigger").exists()).toBe(false);
    expect(footer.find(".settings-panel").exists()).toBe(false);
    wrapper.unmount();
  });
});

describe("global chat panel", () => {
  it("renders a fixed right-side chat panel in the app shell", async () => {
    const wrapper = await mountApp();
    expect(wrapper.find(".global-chat-panel").exists()).toBe(true);
    expect(wrapper.find(".global-chat-panel .chat-composer").exists()).toBe(true);
    wrapper.unmount();
  });

  it("lays out the shell as [Sidebar | Content | GlobalChat] columns", async () => {
    const wrapper = await mountApp();
    const shell = wrapper.find(".app-shell");
    const classLists = Array.from(shell.element.children).map((el) =>
      el.classList.contains("app-aside")
        ? "app-aside"
        : el.classList.contains("app-content")
          ? "app-content"
          : el.classList.contains("global-chat-panel")
            ? "global-chat-panel"
            : el.className,
    );
    expect(classLists).toContain("app-aside");
    expect(classLists).toContain("app-content");
    expect(classLists).toContain("global-chat-panel");
    wrapper.unmount();
  });

  it("keeps the chat panel mounted when navigating between pages", async () => {
    const wrapper = await mountApp();
    const panel = wrapper.find(".global-chat-panel");
    expect(panel.exists()).toBe(true);

    await router.push("/knowledge");
    await waitForRoute("/knowledge");
    await flushPromises();
    expect(wrapper.find(".global-chat-panel").exists()).toBe(true);

    await router.push("/wiki");
    await waitForRoute("/wiki");
    await flushPromises();
    expect(wrapper.find(".global-chat-panel").exists()).toBe(true);

    await router.push("/kanban");
    await waitForRoute("/kanban");
    await flushPromises();
    expect(wrapper.find(".global-chat-panel").exists()).toBe(true);
    wrapper.unmount();
  });

  it("tracks the active page so the chat injects page-aware context on tab switch", async () => {
    const wrapper = await mountApp();
    const chat = useChatStore();

    await router.push("/knowledge");
    await waitForRoute("/knowledge");
    await flushPromises();
    expect(chat.page).toBe("/knowledge");

    await router.push("/wiki");
    await waitForRoute("/wiki");
    await flushPromises();
    expect(chat.page).toBe("/wiki");

    await router.push("/kanban");
    await waitForRoute("/kanban");
    await flushPromises();
    expect(chat.page).toBe("/kanban");
    wrapper.unmount();
  });
});

describe("chat panel auth gating (G4.S7.T8)", () => {
  async function mountAppSignedOut() {
    const pinia = createPinia();
    const wrapper = mount(App, {
      global: {
        plugins: [pinia, TDesign, router],
      },
      attachTo: document.body,
    });
    await router.isReady();
    await flushPromises();
    return wrapper;
  }

  it("hides the chat panel and splitter when signed out, keeping sidebar + content", async () => {
    const wrapper = await mountAppSignedOut();
    await router.push("/login");
    await waitForRoute("/login");
    await flushPromises();

    expect(wrapper.find(".global-chat-panel").exists()).toBe(false);
    expect(wrapper.find(".chat-splitter").exists()).toBe(false);
    expect(wrapper.find(".app-aside").exists()).toBe(true);
    expect(wrapper.find(".app-content").exists()).toBe(true);
    wrapper.unmount();
  });

  it("shows the chat panel and splitter when signed in", async () => {
    const wrapper = await mountApp();
    expect(wrapper.find(".global-chat-panel").exists()).toBe(true);
    expect(wrapper.find(".chat-splitter").exists()).toBe(true);
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

    expect(root.style.getPropertyValue("--td-bg-color-page")).toBe("#e7e9ec");
    expect(root.style.getPropertyValue("--td-bg-color-container")).toBe("#ffffff");
  });
});

describe("settings + output navigation", () => {
  it("navigates to /settings when the Settings nav item is clicked", async () => {
    const wrapper = await mountApp();
    const settings = navItemByText(wrapper, "Settings");
    expect(settings).toBeDefined();
    await settings!.trigger("click");
    await waitForRoute("/settings");
    await flushPromises();
    expect(wrapper.text()).toContain("Profile");
    expect(wrapper.text()).toContain("Agents");
    wrapper.unmount();
  });

  it("navigates to /output and renders the M5 placeholder", async () => {
    const wrapper = await mountApp();
    const output = navItemByText(wrapper, "Output");
    expect(output).toBeDefined();
    await output!.trigger("click");
    await waitForRoute("/output");
    await flushPromises();
    expect(wrapper.text()).toContain("Output — coming in M5");
    wrapper.unmount();
  });

  it("switches to light theme globally via the footer toggle and persists the choice", async () => {
    const wrapper = await mountApp();
    await wrapper.find(".app-footer .theme-toggle").trigger("click");
    await flushPromises();

    expect(useThemeStore().mode).toBe("light");
    expect(
      document.documentElement.style.getPropertyValue("--caleo-body-bg"),
    ).toBe("#e7e9ec");
    expect(localStorage.getItem("caleo-theme")).toBe("light");
    wrapper.unmount();
  });
});
