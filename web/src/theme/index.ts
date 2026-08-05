export const caleoPalette = {
  primary: "#ff6633",
  primaryHover: "#e65a2b",
  dark: "#2d3142",
  sky: "#69b3e7",
  lightGray: "#bfc0c0",
} as const;

export type ThemeMode = "dark" | "light";

const themePalettes: Record<ThemeMode, Record<string, string>> = {
  dark: {
    "--caleo-body-bg": "#1f2128",
    "--caleo-surface": "#262a33",
    "--caleo-border": "#3a3e48",
    "--caleo-text": "#e8e9ec",
    "--caleo-text-secondary": "#9aa0aa",
    "--caleo-bubble-bg": "#33373f",
    "--caleo-sidebar-bg": caleoPalette.dark,
    "--caleo-sidebar-border": "rgba(255, 255, 255, 0.1)",
    "--caleo-sidebar-text": "#ffffff",
    "--caleo-sidebar-sub": caleoPalette.sky,
  },
  light: {
    "--caleo-body-bg": "#f5f6f7",
    "--caleo-surface": "#ffffff",
    "--caleo-border": "#e7e7e7",
    "--caleo-text": "#1f2329",
    "--caleo-text-secondary": "#6b7280",
    "--caleo-bubble-bg": "#f0f1f3",
    "--caleo-sidebar-bg": "#ffffff",
    "--caleo-sidebar-border": "#e7e7e7",
    "--caleo-sidebar-text": caleoPalette.dark,
    "--caleo-sidebar-sub": "#64748b",
  },
};

export function caleoThemeVars(mode: ThemeMode = "dark"): Record<string, string> {
  return {
    "--caleo-primary": caleoPalette.primary,
    "--caleo-primary-hover": caleoPalette.primaryHover,
    "--caleo-dark": caleoPalette.dark,
    "--caleo-sky": caleoPalette.sky,
    "--caleo-light-gray": caleoPalette.lightGray,

    "--td-brand-color": caleoPalette.primary,
    "--td-brand-color-hover": caleoPalette.primaryHover,
    "--td-brand-color-active": caleoPalette.primaryHover,

    "--td-gray-color-13": caleoPalette.dark,

    ...themePalettes[mode],
  };
}

export function applyTheme(mode: ThemeMode): void {
  const vars = caleoThemeVars(mode);
  const root = document.documentElement;
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value);
  }
}
