export const caleoPalette = {
  primary: "#ff6633",
  primaryHover: "#e65a2b",
  dark: "#2d3142",
  sky: "#69b3e7",
  lightGray: "#bfc0c0",
} as const;

export type ThemeMode = "dark" | "light";

const brandVars: Record<string, string> = {
  "--td-brand-color": caleoPalette.primary,
  "--td-brand-color-hover": caleoPalette.primaryHover,
  "--td-brand-color-active": caleoPalette.primaryHover,
  "--td-brand-color-focus": "rgba(255, 102, 51, 0.2)",
  "--td-brand-color-light": "rgba(255, 102, 51, 0.12)",
};

const themePalettes: Record<ThemeMode, Record<string, string>> = {
  dark: {
    "--caleo-body-bg": "#1f2128",
    "--caleo-surface": "#262a33",
    "--caleo-surface-hover": "#2c313c",
    "--caleo-border": "#3a3e48",
    "--caleo-text": "#e8e9ec",
    "--caleo-text-secondary": "#9aa0aa",
    "--caleo-sidebar-bg": caleoPalette.dark,
    "--caleo-sidebar-border": "rgba(255, 255, 255, 0.1)",
    "--caleo-sidebar-text": "#ffffff",
    "--caleo-sidebar-sub": "rgba(255, 255, 255, 0.66)",
    "--caleo-sidebar-hover": "rgba(255, 255, 255, 0.08)",
    "--caleo-sidebar-active": "rgba(255, 102, 51, 0.16)",
    "--caleo-sidebar-footer-bg": "#2d3142",
    "--caleo-shadow": "0 1px 3px rgba(0, 0, 0, 0.4)",
    "--caleo-bubble-ai": "#33373f",
    "--caleo-bubble-user": caleoPalette.primary,
    "--caleo-bubble-user-text": "#ffffff",

    "--td-bg-color-page": "#1f2128",
    "--td-bg-color-container": "#262a33",
    "--td-bg-color-container-hover": "#2c313c",
    "--td-bg-color-container-active": "#33373f",
    "--td-bg-color-secondarycontainer": "#2c313c",
    "--td-bg-color-secondarycontainer-hover": "#33373f",
    "--td-bg-color-component": "#1f2128",
    "--td-bg-color-component-hover": "#2c313c",
    "--td-bg-color-component-active": "#33373f",
    "--td-bg-color-component-disabled": "#20232b",
    "--td-bg-color-specialcomponent": "#1f2128",
    "--td-text-color-primary": "#e8e9ec",
    "--td-text-color-secondary": "#9aa0aa",
    "--td-text-color-placeholder": "#767c86",
    "--td-text-color-disabled": "#5b5f68",
    "--td-border-level-1-color": "#3a3e48",
    "--td-border-level-2-color": "#4a4f5a",
    "--td-component-stroke": "#3a3e48",
    "--td-mask-active": "rgba(15, 17, 22, 0.6)",
    "--td-gray-color-10": "rgba(255, 255, 255, 0.08)",
    "--td-gray-color-13": caleoPalette.dark,
  },
  light: {
    "--caleo-body-bg": "#e7e9ec",
    "--caleo-surface": "#ffffff",
    "--caleo-surface-hover": "#f5f6f7",
    "--caleo-border": "#e3e5e7",
    "--caleo-text": "#1f2329",
    "--caleo-text-secondary": "#6b7280",
    "--caleo-sidebar-bg": "#f0f1f3",
    "--caleo-sidebar-border": "#e3e5e7",
    "--caleo-sidebar-text": caleoPalette.dark,
    "--caleo-sidebar-sub": "#64748b",
    "--caleo-sidebar-hover": "#e5e7eb",
    "--caleo-sidebar-active": "rgba(105, 179, 231, 0.16)",
    "--caleo-sidebar-footer-bg": "#e0e2e6",
    "--caleo-shadow": "0 1px 3px rgba(31, 35, 41, 0.08)",
    "--caleo-bubble-ai": "#e5e7eb",
    "--caleo-bubble-user": caleoPalette.sky,
    "--caleo-bubble-user-text": "#ffffff",

    "--td-bg-color-page": "#e7e9ec",
    "--td-bg-color-container": "#ffffff",
    "--td-bg-color-container-hover": "#fafbfc",
    "--td-bg-color-container-active": "#f5f6f7",
    "--td-bg-color-secondarycontainer": "#f5f6f7",
    "--td-bg-color-secondarycontainer-hover": "#eef0f2",
    "--td-bg-color-component": "#f5f6f7",
    "--td-bg-color-component-hover": "#eef0f2",
    "--td-bg-color-component-active": "#e7e9ec",
    "--td-bg-color-component-disabled": "#f5f6f7",
    "--td-bg-color-specialcomponent": "#ffffff",
    "--td-text-color-primary": "#1f2329",
    "--td-text-color-secondary": "#6b7280",
    "--td-text-color-placeholder": "#9aa0aa",
    "--td-text-color-disabled": "#c0c3c9",
    "--td-border-level-1-color": "#e3e5e7",
    "--td-border-level-2-color": "#d5d8dc",
    "--td-component-stroke": "#e3e5e7",
    "--td-mask-active": "rgba(31, 35, 41, 0.4)",
    "--td-gray-color-10": "#eef0f2",
    "--td-gray-color-13": caleoPalette.dark,
  },
};

export function caleoThemeVars(mode: ThemeMode = "dark"): Record<string, string> {
  return {
    "--caleo-primary": caleoPalette.primary,
    "--caleo-primary-hover": caleoPalette.primaryHover,
    "--caleo-dark": caleoPalette.dark,
    "--caleo-sky": caleoPalette.sky,
    "--caleo-light-gray": caleoPalette.lightGray,

    ...brandVars,
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
