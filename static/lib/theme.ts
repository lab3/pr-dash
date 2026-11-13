// Theme choice: follow the OS setting (System), or force Light or Dark. The choice is stored
// per browser and applied as <html data-theme>, which style.css reads. static/theme-boot.js
// applies the stored choice before first paint; keep its storage key and values in step.

export type Theme = "system" | "light" | "dark";

export const THEMES: readonly Theme[] = ["system", "light", "dark"];

/** A stored value as a Theme. Anything unknown falls back to System. */
export function parseTheme(v: unknown): Theme {
  return THEMES.includes(v as Theme) ? (v as Theme) : "system";
}

/** The choice after `t`, for the `t` shortcut: System, Light, Dark, then System again. */
export function nextTheme(t: Theme): Theme {
  return THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
}

/** Set <html data-theme> for Light or Dark; clear it for System so the OS setting applies. */
export function applyTheme(t: Theme): void {
  const root = document.documentElement;
  if (t === "system") delete root.dataset.theme;
  else root.dataset.theme = t;
}

/** True when the page shows dark colors: the forced theme if there is one, else the OS setting. */
export function isDark(): boolean {
  const forced = document.documentElement.dataset.theme;
  return forced ? forced === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
}
