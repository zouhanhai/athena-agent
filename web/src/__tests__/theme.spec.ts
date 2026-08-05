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
    expect(light["--caleo-sidebar-bg"]).toBe("#ffffff");
    expect(dark["--caleo-sidebar-bg"]).toBe("#2d3142");
  });

  it("applyTheme writes theme variables onto the document root", () => {
    applyTheme("light");
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--caleo-body-bg")).toBe("#f5f6f7");
    expect(root.style.getPropertyValue("--caleo-text")).toBe("#1f2329");

    applyTheme("dark");
    expect(root.style.getPropertyValue("--caleo-body-bg")).toBe("#1f2128");
    expect(root.style.getPropertyValue("--caleo-text")).toBe("#e8e9ec");
  });
});
