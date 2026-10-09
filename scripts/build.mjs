// Builds dist/ for the Worker's static assets: bundles static/app.ts (and the static/lib modules
// it imports) into one browser file, copies index.html with the script tag pointing at the
// bundle, copies style.css, and writes the response headers. Node's own type stripping serves
// static/*.ts directly in local mode; Workers Static Assets need plain JavaScript.
//
//   node scripts/build.mjs
import { realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

export const HEADERS = `/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
  Referrer-Policy: same-origin
  X-Content-Type-Options: nosniff
  X-Robots-Tag: noindex
  Cache-Control: private, no-store
`;

export async function build({ staticDir, outDir }) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await esbuild({
    entryPoints: [path.join(staticDir, "app.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    outfile: path.join(outDir, "app.js"),
    logLevel: "silent",
  });
  const html = await readFile(path.join(staticDir, "index.html"), "utf8");
  await writeFile(path.join(outDir, "index.html"), html.replace('src="/app.ts"', 'src="/app.js"'));
  await copyFile(path.join(staticDir, "style.css"), path.join(outDir, "style.css"));
  await writeFile(path.join(outDir, "_headers"), HEADERS);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  build({ staticDir: path.join(root, "static"), outDir: path.join(root, "dist") })
    .then(() => console.log("Built dist/."))
    .catch((error) => {
      console.error(`Build failed: ${error.message}`);
      process.exit(1);
    });
}
