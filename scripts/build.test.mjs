import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HEADERS, build } from "./build.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("build emits app.js, index.html pointing at it, style.css and _headers", async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), "prdash-dist-"));
  await build({ staticDir: path.join(root, "static"), outDir });
  const files = (await readdir(outDir)).sort();
  assert.deepEqual(files, ["_headers", "app.js", "index.html", "style.css"]);
  const html = await readFile(path.join(outDir, "index.html"), "utf8");
  assert.ok(html.includes('src="/app.js"'));
  assert.ok(!html.includes("/app.ts"));
  const js = await readFile(path.join(outDir, "app.js"), "utf8");
  assert.ok(js.includes("renderList") || js.includes("pr-list"), "bundle contains the app");
  assert.ok(!js.includes("node:"), "no Node imports in the browser bundle");
  assert.ok(!js.includes("shared/"), "no shared/ runtime imports in the browser bundle");
  assert.ok(!js.includes("import "), "bundle is self-contained (no bare imports left)");
  const headers = await readFile(path.join(outDir, "_headers"), "utf8");
  assert.equal(headers, HEADERS);
  assert.ok(HEADERS.includes("Content-Security-Policy: default-src 'self'"));
});
