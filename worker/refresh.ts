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

export async function readStoredConfig(kv: KVNamespace): Promise<Partial<Config> | null> {
  return (await kv.get("config", "json")) as Partial<Config> | null;
}

function hostedConfig(stored: Partial<Config> | null): Config {
  const cfg = normalizeConfig({ ...DEFAULTS, ...(stored ?? {}) });
  cfg.mine = false; // the viewer is the App bot; list orgs in `owners` instead
  return cfg;
}

export async function readConfig(kv: KVNamespace): Promise<Config> {
  return hostedConfig(await readStoredConfig(kv));
}

export async function readViews(kv: KVNamespace): Promise<View[]> {
  const stored = await kv.get("views", "json");
  return stored ? validateViews(stored) : [];
}

export async function readData(kv: KVNamespace): Promise<DashboardData | null> {
  return (await kv.get("prs", "json")) as DashboardData | null;
}

/**
 * Workers Free allows 50 subrequests per invocation. Besides GraphQL pages, one run spends
 * subrequests on KV reads (config, views, old data), the KV write, the Access JWKS fetch on a
 * `?refresh=1` request, and one token mint per distinct `app:` spec. Leave room for all of them.
 */
export function hostedRequestBudget(cfg: Config): number {
  const distinctSpecs = new Set(Object.values(cfg.tokens ?? {})).size;
  return Math.max(10, 42 - distinctSpecs);
}

export async function runRefresh(env: Env, deps: RefreshDeps = defaultDeps): Promise<DashboardData> {
  const started = deps.now();
  const [stored, views] = await Promise.all([readStoredConfig(env.PRDASH), readViews(env.PRDASH)]);
  const cfg = hostedConfig(stored);
  // An App token can't answer `viewer`; the config's viewer_login stands in for it.
  const result = await deps.collect(cfg, deps.tokens(cfg, env), { repos: exactViewRepos(views), owners: viewOwners(views) },
    { includeViewer: false, maxRequests: hostedRequestBudget(cfg) });
  const warnings = [...result.warnings];
  if (stored?.mine === true) warnings.push("`mine` is ignored in hosted mode; list the orgs in `owners`.");
  // No repos plus warnings means every source went missing or was cut short. Keep what we had.
  if (result.repos.length === 0 && result.warnings.length > 0) {
    const old = await readData(env.PRDASH);
    if (old && old.repos.length > 0) {
      return { ...old, warnings: [...warnings, "This run found no repos; showing the previous data."] };
    }
  }
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
