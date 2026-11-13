import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { applyTheme, isDark, nextTheme, parseTheme } from "./theme.ts";

// Just enough DOM for applyTheme and isDark: <html data-theme> and the OS dark setting.
let osDark = false;
const root = { dataset: {} as Record<string, string> };
Object.assign(globalThis, {
  document: { documentElement: root },
  matchMedia: (q: string) => ({ matches: q === "(prefers-color-scheme: dark)" && osDark }),
});
beforeEach(() => {
  osDark = false;
  root.dataset = {};
});

test("parseTheme: keeps known choices, falls back to system", () => {
  for (const t of ["system", "light", "dark"] as const) assert.equal(parseTheme(t), t);
  for (const v of [null, undefined, "", "Dark", "sepia", 1, {}]) assert.equal(parseTheme(v), "system");
});

test("nextTheme: system, light, dark, then back to system", () => {
  assert.equal(nextTheme("system"), "light");
  assert.equal(nextTheme("light"), "dark");
  assert.equal(nextTheme("dark"), "system");
});

test("applyTheme: light and dark set data-theme, system clears it", () => {
  applyTheme("dark");
  assert.equal(root.dataset.theme, "dark");
  applyTheme("light");
  assert.equal(root.dataset.theme, "light");
  applyTheme("system");
  assert.equal("theme" in root.dataset, false);
});

test("isDark: a forced theme wins over the OS setting", () => {
  osDark = true;
  applyTheme("light");
  assert.equal(isDark(), false);
  osDark = false;
  applyTheme("dark");
  assert.equal(isDark(), true);
});

test("isDark: system follows the OS setting", () => {
  applyTheme("system");
  assert.equal(isDark(), false);
  osDark = true;
  assert.equal(isDark(), true);
});
