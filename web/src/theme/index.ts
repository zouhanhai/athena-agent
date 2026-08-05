export const caleoPalette = {
  primary: "#ff6633",
  primaryHover: "#e65a2b",
  dark: "#2d3142",
  sky: "#69b3e7",
  lightGray: "#bfc0c0",
} as const;

export function caleoThemeVars(): Record<string, string> {
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
  };
}
