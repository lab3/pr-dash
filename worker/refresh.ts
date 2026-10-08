// Reads config and views from KV, runs the same collect() the local server runs, and stores
// the shaped dashboard data in KV. The cron calls this every 5 minutes; /api/prs?refresh=1
// calls it on demand. One KV write per run.
import { DEFAULTS, normalizeConfig, type Config, type TokenSource } from "../shared/config-core.ts";
import { collect as realCollect } from "../shared/github.ts";
import { exactViewRepos, validateViews, viewOwners } from "../shared/views-core.ts";
import type { DashboardData, View } from "../src/types.ts";
import type { Env } from "./env.ts";
import { appTokens } from "./github-app.ts";

export interface RefreshDeps {
  collect: typeof realCollect;
  tokens(cfg: Config, env: Env): TokenSource;
  now(): number;
}

const defaultDeps: RefreshDeps = { collect: realCollect, tokens: (cfg, env) => appTokens(cfg, env), now: () => Date.now() };

export async function readConfig(kv: KVNamespace): Promise<Config> {
  const stored = (await kv.get("config", "json")) as Partial<Config> | null;
  const cfg = normalizeConfig({ ...DEFAULTS, ...(stored ?? {}) });
  cfg.mine = false; // the viewer is the App bot; list orgs in `owners` instead
  return cfg;
}

export async function readViews(kv: KVNamespace): Promise<View[]> {
  const stored = await kv.get("views", "json");
  return stored ? validateViews(stored) : [];
}

export async function readData(kv: KVNamespace): Promise<DashboardData | null> {
  return (await kv.get("prs", "json")) as DashboardData | null;
}

export async function runRefresh(env: Env, deps: RefreshDeps = defaultDeps): Promise<DashboardData> {
  const started = deps.now();
  const [cfg, views] = await Promise.all([readConfig(env.PRDASH), readViews(env.PRDASH)]);
  const stored = (await env.PRDASH.get("config", "json")) as Partial<Config> | null;
  const result = await deps.collect(cfg, deps.tokens(cfg, env), { repos: exactViewRepos(views), owners: viewOwners(views) });
  const warnings = [...result.warnings];
  if (stored?.mine) warnings.push("`mine` is ignored in hosted mode; list the orgs in `owners`.");
  const data: DashboardData = {
    ...result,
    warnings,
    fetchMs: deps.now() - started,
    generatedAt: new Date(deps.now()).toISOString(),
    refreshSeconds: Number(cfg.refresh_seconds),
    hosted: true,
  };
  await env.PRDASH.put("prs", JSON.stringify(data));
  return data;
}
