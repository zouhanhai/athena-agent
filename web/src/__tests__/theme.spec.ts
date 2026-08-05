import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { useThemeStore } from "@/stores/theme";
import { applyTheme, caleoThemeVars } from "@/theme";

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
});

describe("theme store", () => {
  it("defaults to the dark brand theme", () => {
    const theme = useThemeStore();
    expect(theme.mode).toBe("dark");
  });

  it("setMode updates the mode and persists it to localStorage", () => {
    const theme = useThemeStore();
    theme.setMode("light");

    expect(theme.mode).toBe("light");
    expect(localStorage.getItem("caleo-theme")).toBe("light");
  });

  it("hydrates from a persisted theme choice", () => {
    localStorage.setItem("caleo-theme", "light");
    const theme = useThemeStore();
    expect(theme.mode).toBe("light");
  });

  it("toggle switches between dark and light", () => {
    const theme = useThemeStore();
    theme.toggle();
    expect(theme.mode).toBe("light");
    theme.toggle();
    expect(theme.mode).toBe("dark");
  });
});

describe("theme css variables", () => {
  it("defines distinct dark and light palettes for body, surface and text", () => {
    const dark = caleoThemeVars("dark");
    const light = caleoThemeVars("light");

    expect(dark["--caleo-body-bg"]).not.toBe(light["--caleo-body-bg"]);
    expect(dark["--caleo-text"]).not.toBe(light["--caleo-text"]);
    expect(light["--caleo-sidebar-bg"]).toBe("#f5f6f7");
    expect(dark["--caleo-sidebar-bg"]).toBe("#2d3142");
  });

  it("uses light-gray layered light theme (gray page + white cards)", () => {
    const light = caleoThemeVars("light");
    expect(light["--caleo-body-bg"]).toBe("#f0f1f3");
    expect(light["--caleo-surface"]).toBe("#ffffff");
    expect(light["--caleo-bubble-ai"]).toBe("#f0f1f3");
  });

  it("overrides TDesign component variables per theme", () => {
    const dark = caleoThemeVars("dark");
    const light = caleoThemeVars("light");

    expect(dark["--td-bg-color-page"]).toBe("#1f2128");
    expect(dark["--td-bg-color-container"]).toBe("#262a33");
    expect(dark["--td-text-color-primary"]).toBe("#e8e9ec");
    expect(light["--td-bg-color-page"]).toBe("#f0f1f3");
    expect(light["--td-bg-color-container"]).toBe("#ffffff");
    expect(light["--td-text-color-primary"]).toBe("#1f2329");
  });

  it("distinguishes AI vs user bubbles in both themes", () => {
    const dark = caleoThemeVars("dark");
    const light = caleoThemeVars("light");

    expect(dark["--caleo-bubble-ai"]).not.toBe(dark["--caleo-bubble-user"]);
    expect(light["--caleo-bubble-ai"]).not.toBe(light["--caleo-bubble-user"]);
    expect(light["--caleo-bubble-user"]).toBe("#69b3e7");
    expect(dark["--caleo-bubble-user"]).toBe("#ff6633");
  });

  it("applyTheme writes theme variables onto the document root", () => {
    applyTheme("light");
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--caleo-body-bg")).toBe("#f0f1f3");
    expect(root.style.getPropertyValue("--caleo-text")).toBe("#1f2329");

    applyTheme("dark");
    expect(root.style.getPropertyValue("--caleo-body-bg")).toBe("#1f2128");
    expect(root.style.getPropertyValue("--caleo-text")).toBe("#e8e9ec");
  });
});
