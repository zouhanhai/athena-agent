import { beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import ThemeToggle from "@/components/ThemeToggle.vue";
import { useThemeStore } from "@/stores/theme";

function mountToggle() {
  setActivePinia(createPinia());
  const wrapper = mount(ThemeToggle);
  return { wrapper, theme: useThemeStore() };
}

describe("animated theme toggle", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders as a switch in dark mode by default, showing the stars + moon group", () => {
    const { wrapper } = mountToggle();
    const toggle = wrapper.find(".theme-toggle");

    expect(toggle.attributes("role")).toBe("switch");
    expect(toggle.attributes("data-mode")).toBe("dark");
    expect(toggle.attributes("aria-checked")).toBe("true");

    expect(
      wrapper.find(".theme-toggle__icons--dark").attributes("aria-hidden"),
    ).toBe("false");
    expect(
      wrapper.find(".theme-toggle__icons--light").attributes("aria-hidden"),
    ).toBe("true");
  });

  it("clicking the slider switches the theme store to light and shows the sun + cloud group", async () => {
    const { wrapper, theme } = mountToggle();

    await wrapper.find(".theme-toggle").trigger("click");
    await flushPromises();

    expect(theme.mode).toBe("light");
    expect(localStorage.getItem("caleo-theme")).toBe("light");
    expect(wrapper.find(".theme-toggle").attributes("data-mode")).toBe("light");
    expect(wrapper.find(".theme-toggle").attributes("aria-checked")).toBe(
      "false",
    );
    expect(
      wrapper.find(".theme-toggle__icons--dark").attributes("aria-hidden"),
    ).toBe("true");
    expect(
      wrapper.find(".theme-toggle__icons--light").attributes("aria-hidden"),
    ).toBe("false");
  });

  it("reflects a theme change made outside the component", async () => {
    const { wrapper, theme } = mountToggle();

    theme.setMode("light");
    await flushPromises();
    expect(wrapper.find(".theme-toggle").attributes("data-mode")).toBe("light");

    theme.setMode("dark");
    await flushPromises();
    expect(wrapper.find(".theme-toggle").attributes("data-mode")).toBe("dark");
  });
});
