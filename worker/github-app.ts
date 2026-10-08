// GitHub App installation tokens for the Worker. Config "tokens" entries use "app:<installation id>"
// (mint a JWT with the App's private key, exchange it for a one-hour installation token, cache it
// for 50 minutes in this isolate) or "secret:NAME" (read a Worker secret, for local `wrangler dev`
// with a plain gh token before the App exists).
import { SignJWT, importPKCS8 } from "jose";
import { DashError, type Config, type TokenSource } from "../shared/config-core.ts";
import type { Env } from "./env.ts";

export interface AppDeps {
  fetch: typeof fetch;
  /** Milliseconds since the epoch; injectable for tests. */
  now(): number;
}

const defaultDeps: AppDeps = { fetch: (...args) => fetch(...args), now: () => Date.now() };

const CACHE_MS = 50 * 60_000;
const cache = new Map<string, { token: string; expiresAt: number }>();

/** Tests call this between cases. */
export function resetTokenCache(): void {
  cache.clear();
}

/** A short-lived JWT that identifies the App itself. `iat` sits 60 s in the past to absorb clock drift. */
export async function mintAppJwt(appId: string, pkcs8: string, nowSec: number): Promise<string> {
  const key = await importPKCS8(pkcs8, "RS256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(appId)
    .setIssuedAt(nowSec - 60)
    .setExpirationTime(nowSec + 600)
    .sign(key);
}

const SECRET_DENYLIST = ["GH_APP_ID", "GH_APP_PRIVATE_KEY", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "HOSTNAME", "DEV_ACCESS_EMAIL"];

async function installationToken(id: string, env: Env, deps: AppDeps): Promise<string> {
  if (!/^\d+$/.test(id)) throw new DashError(`Installation id "${id}" is not a number.`, null, 500);
  const hit = cache.get(id);
  if (hit && hit.expiresAt > deps.now()) return hit.token;
  if (!env.GH_APP_ID || !env.GH_APP_PRIVATE_KEY) {
    throw new DashError("GH_APP_ID and GH_APP_PRIVATE_KEY secrets are required for app:<id> tokens.", null, 500);
  }
  const jwt = await mintAppJwt(env.GH_APP_ID, env.GH_APP_PRIVATE_KEY, Math.floor(deps.now() / 1000));
  const res = await deps.fetch(`https://api.github.com/app/installations/${id}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "User-Agent": "pr-dash" },
  });
  if (!res.ok) {
    throw new DashError(`GitHub refused an installation token for installation ${id} (HTTP ${res.status}).`,
      "Check the App id, private key and that the App is installed on that org.", 502);
  }
  const body = (await res.json()) as { token?: unknown };
  if (typeof body.token !== "string" || !body.token) throw new DashError(`GitHub returned no token for installation ${id}.`, null, 502);
  cache.set(id, { token: body.token, expiresAt: deps.now() + CACHE_MS });
  return body.token;
}

async function resolve(spec: string, env: Env, deps: AppDeps): Promise<string> {
  const s = spec.trim();
  if (s.startsWith("app:")) return installationToken(s.slice(4), env, deps);
  if (s.startsWith("secret:")) {
    const name = s.slice(7);
    if (SECRET_DENYLIST.includes(name)) throw new DashError(`Refusing to use ${name} as a GitHub token.`, null, 500);
    const v = env[name];
    if (typeof v !== "string" || !v) throw new DashError(`Secret ${name} is not set.`, null, 500);
    return v;
  }
  throw new DashError(`Unknown token spec "${s}" for the Worker.`, 'Use "app:<installation id>" or "secret:NAME".', 500);
}

export function appTokens(cfg: Config, env: Env, deps: AppDeps = defaultDeps): TokenSource {
  const specs = Object.fromEntries(Object.entries(cfg.tokens ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const appEntries = Object.entries(specs).filter(([k, v]) => k !== "default" && v.startsWith("app:"));
  const defaultSpec = specs.default ?? (appEntries.length === 1 ? appEntries[0][1] : null);
  return {
    async default() {
      if (!defaultSpec) throw new DashError("No default token: set tokens.default or exactly one app:<id> owner.", null, 500);
      return resolve(defaultSpec, env, deps);
    },
    async forOwner(owner) {
      const spec = specs[owner.toLowerCase()];
      return spec ? resolve(spec, env, deps) : this.default();
    },
  };
}
