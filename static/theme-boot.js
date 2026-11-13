// Applies the stored theme choice before first paint, so a forced Light or Dark never flashes
// the OS theme while app.ts loads. A blocking classic script in <head>, because the CSP allows
// no inline scripts. Storage key and values match static/lib/theme.ts and the store helper.
try {
  const t = JSON.parse(localStorage.getItem("prdash.theme") ?? "null");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch {
  // Private window or blocked storage: follow the OS setting.
}
