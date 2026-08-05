import { defineStore } from "pinia";
import type { ThemeMode } from "@/theme";

const STORAGE_KEY = "caleo-theme";

function loadInitialMode(): ThemeMode {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === "light" ? "light" : "dark";
}

export const useThemeStore = defineStore("theme", {
  state: (): { mode: ThemeMode } => ({
    mode: loadInitialMode(),
  }),
  actions: {
    setMode(mode: ThemeMode) {
      this.mode = mode;
      localStorage.setItem(STORAGE_KEY, mode);
    },
    toggle() {
      this.setMode(this.mode === "dark" ? "light" : "dark");
    },
  },
});
