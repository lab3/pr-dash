#!/usr/bin/env node
/**
 * pr-dash: a small local dashboard of open GitHub pull requests, grouped by repo.
 *
 *   node server.ts            # then open http://localhost:8787
 *   node server.ts --open     # same, and open the browser
 *
 * Needs Node 22.18+ (runs TypeScript directly; no npm install, no build step).
 * Auth: GITHUB_TOKEN / GH_TOKEN, else `gh auth token`. Per-owner tokens via config.json.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as nodeModule from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";

import { CONFIG_PATH, DashError, ROOT, Tokens, loadConfig, type Config } from "./src/config.ts";
import { publicConfig } from "./shared/config-core.ts";
import { collect } from "./shared/github.ts";
import type { ApiError, DashboardData, ViewsPayload } from "./src/types.ts";
import { exactViewRepos, loadViews, saveViews, validateViews, viewOwners } from "./src/views.ts";

const STATIC_DIR = path.join(ROOT, "static");

// --------------------------------------------------------------------------- cache

let cached: DashboardData | null = null;
let fetchedAt = 0;
let inflight: Promise<DashboardData> | null = null;
let fetchedOwners = new Set<string>(); // view owners included in the cached fetch

async function getData(force: boolean): Promise<DashboardData> {
  const cfg = loadConfig();
  const fresh = cached && Date.now() - fetchedAt < cfg.cache_seconds * 1000;
  if (fresh && !force) return cached!;
  // Share one GitHub fetch between concurrent requests.
  inflight ??= (async () => {
    const started = Date.now();
    const views = loadViews();
    const owners = viewOwners(views);
    const result = await collect(cfg, new Tokens(cfg), { repos: exactViewRepos(views), owners });
    fetchedOwners = new Set(owners.map((o) => o.toLowerCase()));
    cached = {
      ...result,
      fetchMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
      refreshSeconds: Number(cfg.refresh_seconds),
    };
    fetchedAt = Date.now();
    return cached;
  })().finally(() => { inflight = null; });
  return inflight;
}

// --------------------------------------------------------------------------- static files

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8", // served with types stripped
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const strip = (nodeModule as { stripTypeScriptTypes?: (code: string, opts?: { mode?: "strip" }) => string })
  .stripTypeScriptTypes;
const tsCache = new Map<string, { mtime: number; js: string }>();

async function serveStatic(urlPath: string, res: ServerResponse): Promise<void> {
  const rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, "");
  const file = path.resolve(STATIC_DIR, rel);
  const ext = path.extname(file);
  if (!file.startsWith(STATIC_DIR + path.sep) || !TYPES[ext]) return notFound(res);

  let body: Buffer | string;
  try {
    body = await readFile(file);
  } catch {
    return notFound(res);
  }
  if (ext === ".ts") {
    if (!strip) return sendText(res, 500, "This Node version can't strip TypeScript types. Use Node 22.18 or newer.");
    const { mtimeMs } = await stat(file);
    const hit = tsCache.get(file);
    if (hit && hit.mtime === mtimeMs) body = hit.js;
    else {
      body = strip(body.toString("utf8"), { mode: "strip" });
      tsCache.set(file, { mtime: mtimeMs, js: body });
    }
  }
  res.writeHead(200, { "Content-Type": TYPES[ext], "Cache-Control": "no-cache" });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  sendText(res, 404, "Not found");
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function sendJson(res: ServerResponse, status: number, body: DashboardData | ViewsPayload | ApiError | Record<string, unknown>): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

// --------------------------------------------------------------------------- request safety
//
// The API returns private repo data and (for views) writes to disk, so:
//  - Host must be a loopback name (or the configured host). This blocks DNS-rebinding pages
//    from reading the API through a hostname they control.
//  - Writes need JSON + a custom X-PR-Dash header, which a cross-site page can't send without
//    a CORS preflight that this server never approves; Origin, if present, must match Host.
// Future write actions (approve, merge, ...) should go through assertWritable() too.

let listenHost = "127.0.0.1";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function hostAllowed(req: IncomingMessage): boolean {
  if (listenHost === "0.0.0.0" || listenHost === "::") return true; // you opted into LAN access
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  return LOOPBACK.has(host) || host === listenHost.toLowerCase();
}

function assertWritable(req: IncomingMessage): void {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json") || req.headers["x-pr-dash"] !== "1") {
    throw new DashError("Missing JSON content type or X-PR-Dash header.", null, 403);
  }
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) throw new DashError("Cross-origin write refused.", null, 403);
}

async function readJson(req: IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new DashError("Request body too large.", null, 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DashError("Request body is not valid JSON.", null, 400);
  }
}

// --------------------------------------------------------------------------- routes

async function api(req: IncomingMessage, url: URL): Promise<DashboardData | ViewsPayload | Record<string, unknown>> {
  if (url.pathname === "/api/prs" && req.method === "GET") {
    return getData(["1", "true"].includes(url.searchParams.get("refresh") ?? ""));
  }
  if (url.pathname === "/api/views" && req.method === "GET") {
    return { views: loadViews() };
  }
  if (url.pathname === "/api/views" && req.method === "PUT") {
    assertWritable(req);
    const views = validateViews(await readJson(req));
    await saveViews(views);
    // If a view names a repo or owner we haven't fetched yet, the next /api/prs refetches.
    const have = new Set(cached?.repos.map((r) => r.name.toLowerCase()) ?? []);
    const newRepo = exactViewRepos(views).some((r) => !have.has(r.toLowerCase()));
    const newOwner = viewOwners(views).some((o) => !fetchedOwners.has(o.toLowerCase()));
    if (newRepo || newOwner) fetchedAt = 0;
    return { views };
  }
  if (url.pathname === "/api/health" && req.method === "GET") return { ok: true };
  if (url.pathname === "/api/config" && req.method === "GET") return publicConfig(loadConfig());
  if (url.pathname === "/api/config" && req.method === "PUT") {
    throw new DashError("Config is a file in local mode.", "Edit config.json; it is re-read on the next refresh.", 405);
  }
  throw new DashError("Not found", null, 404);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname.startsWith("/api/")) {
    if (!hostAllowed(req)) return sendJson(res, 403, { error: "Host not allowed." });
    try {
      sendJson(res, 200, await api(req, url));
    } catch (e) {
      if (e instanceof DashError) sendJson(res, e.status, { error: e.message, hint: e.hint });
      else sendJson(res, 500, { error: `Unexpected error: ${(e as Error).message ?? e}` });
    }
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") return sendText(res, 405, "Method not allowed");
  // Shared type definitions are imported by static/app.ts with `import type`, which is
  // stripped before serving, so the browser never requests src/. Block it anyway.
  if (url.pathname.startsWith("/src/")) return notFound(res);
  return serveStatic(url.pathname, res);
}

// --------------------------------------------------------------------------- main

function main(): void {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (!(e instanceof DashError)) throw e;
    console.error(`pr-dash: ${e.message}${e.hint ? `\n  ${e.hint}` : ""}`);
    process.exit(1);
  }
  const { values } = parseArgs({
    options: {
      host: { type: "string", default: cfg.host },
      port: { type: "string", default: String(cfg.port) },
      open: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log("usage: node server.ts [--host 127.0.0.1] [--port 8787] [--open]");
    return;
  }
  const host = values.host;
  const port = Number(values.port);
  listenHost = host;
  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) sendText(res, 500, String(e));
      else res.end();
    });
  });
  server.listen(port, host, () => {
    const shown = host === "127.0.0.1" || host === "0.0.0.0" ? "localhost" : host;
    const url = `http://${shown}:${port}`;
    console.log(`pr-dash running at ${url}  (Ctrl+C to stop)`);
    console.log(`config: ${existsSync(CONFIG_PATH) ? CONFIG_PATH : "defaults (no config.json)"}`);
    if (values.open) {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
      execFile(opener, [url], () => {});
    }
  });
  server.on("error", (e: NodeJS.ErrnoException) => {
    console.error(e.code === "EADDRINUSE" ? `Port ${port} is already in use. Try --port ${port + 1}.` : e.message);
    process.exit(1);
  });
  process.on("SIGINT", () => { console.log("\nbye"); process.exit(0); });
}

main();
