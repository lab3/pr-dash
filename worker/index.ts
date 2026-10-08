// pr-dash on Cloudflare Workers: Access gate, API routes backed by KV, static assets, and the
// cron that rebuilds the dashboard data. See docs/specs/cloudflare-hosting.md.
import { DEFAULTS, DashError, normalizeConfig, publicConfig, type Config } from "../shared/config-core.ts";
import { exactViewRepos, validateViews, viewOwners } from "../shared/views-core.ts";
import type { DashboardData } from "../src/types.ts";
import { verifyAccess, type AccessDeps } from "./access.ts";
import type { Env } from "./env.ts";
import { readConfig, readData, readViews, runRefresh, type RefreshDeps } from "./refresh.ts";

export interface HandlerDeps {
  access?: AccessDeps;
  refresh?: RefreshDeps;
}

const REFRESH_MIN_MS = 60_000;

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex",
  "cache-control": "private, no-store",
};

function withHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

function json(status: number, body: unknown): Response {
  return withHeaders(new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8" },
  }));
}

/** Same rules as server.ts: JSON body, the custom header, and Origin (if sent) must be this site. */
function assertWritable(request: Request): void {
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json") || request.headers.get("x-pr-dash") !== "1") {
    throw new DashError("Missing JSON content type or X-PR-Dash header.", null, 403);
  }
  const origin = request.headers.get("origin");
  const host = request.headers.get("host") ?? new URL(request.url).host;
  const scheme = new URL(request.url).protocol;
  if (origin && origin !== `${scheme}//${host}`) throw new DashError("Cross-origin write refused.", null, 403);
}

async function readJson(request: Request, limit = 256 * 1024): Promise<unknown> {
  const text = await request.text();
  if (text.length > limit) throw new DashError("Request body too large.", null, 413);
  try {
    return JSON.parse(text);
  } catch {
    throw new DashError("Request body is not valid JSON.", null, 400);
  }
}

const logBackground = (e: unknown): void => {
  console.error(`pr-dash: background refresh failed: ${(e as Error).message ?? e}`);
};

async function api(request: Request, url: URL, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }, email: string, refresh: RefreshDeps | undefined): Promise<Response> {
  const kv = env.PRDASH;
  const run = () => runRefresh(env, refresh);

  if (url.pathname === "/api/health" && request.method === "GET") return json(200, { ok: true });

  if (url.pathname === "/api/prs" && request.method === "GET") {
    const old = await readData(kv);
    const wantRefresh = ["1", "true"].includes(url.searchParams.get("refresh") ?? "");
    const now = refresh?.now() ?? Date.now();
    const fresh = old && now - +new Date(old.generatedAt) < REFRESH_MIN_MS;
    if (wantRefresh && !fresh) {
      try {
        return json(200, await run());
      } catch (e) {
        if (!old) throw e;
        return json(200, { ...old, warnings: [...old.warnings, `Refresh failed: ${(e as Error).message}`] } satisfies DashboardData);
      }
    }
    if (!old) return json(404, { error: "No data yet. The cron hasn't run.", hint: "It runs every 5 minutes; or press Refresh." });
    return json(200, old);
  }

  if (url.pathname === "/api/views" && request.method === "GET") return json(200, { views: await readViews(kv) });
  if (url.pathname === "/api/views" && request.method === "PUT") {
    assertWritable(request);
    const before = await readViews(kv);
    const views = validateViews(await readJson(request));
    await kv.put("views", JSON.stringify({ views }));
    const had = new Set([...viewOwners(before), ...exactViewRepos(before)].map((s) => s.toLowerCase()));
    const added = [...viewOwners(views), ...exactViewRepos(views)].some((s) => !had.has(s.toLowerCase()));
    if (added) ctx.waitUntil(run().catch(logBackground));
    return json(200, { views });
  }

  if (url.pathname === "/api/config" && request.method === "GET") return json(200, publicConfig(await readConfig(kv)));
  if (url.pathname === "/api/config" && request.method === "PUT") {
    assertWritable(request);
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new DashError("Config must be a JSON object.", null, 400);
    const stored = ((await kv.get("config", "json")) ?? {}) as Partial<Config>;
    const cfg: Config = normalizeConfig({ ...DEFAULTS, ...stored, ...(body as Partial<Config>) });
    if (!cfg.allowed_emails.includes(email)) {
      throw new DashError("allowed_emails must include your own email, or you would lock yourself out.", null, 400);
    }
    await kv.put("config", JSON.stringify(cfg));
    ctx.waitUntil(run().catch(logBackground));
    return json(200, publicConfig(cfg));
  }

  throw new DashError("Not found", null, 404);
}

export async function handle(
  request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }, deps: HandlerDeps = {},
): Promise<Response> {
  // Read the allowlist before verifying, so one KV read serves both the gate and the routes.
  const cfg = await readConfig(env.PRDASH).catch((e: unknown) => {
    console.error(`pr-dash: config unreadable, denying all requests: ${(e as Error).message ?? e}`);
    return { ...DEFAULTS, allowed_emails: [] as string[] };
  });
  const access = await verifyAccess(request, env, cfg.allowed_emails, deps.access);
  if (!access.ok) return withHeaders(access.response);

  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) {
    try {
      return await api(request, url, env, ctx, access.email, deps.refresh);
    } catch (e) {
      if (e instanceof DashError) return json(e.status, { error: e.message, hint: e.hint });
      return json(500, { error: `Unexpected error: ${(e as Error).message ?? e}` });
    }
  }
  if (request.method !== "GET" && request.method !== "HEAD") return withHeaders(new Response("Method not allowed", { status: 405 }));
  return withHeaders(await env.ASSETS.fetch(request));
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handle(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runRefresh(env).catch((e: unknown) => {
      console.error(`pr-dash cron failed: ${(e as Error).message ?? e}`);
    }));
  },
};
