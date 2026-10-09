// Config shapes and validation shared by the Node server and the Cloudflare Worker.
// Nothing here may import from "node:*".

export interface Config {
  /** Repos you own, collaborate on, or reach through your orgs. Local only; forced off hosted. */
  mine: boolean;
  /** Extra users/orgs whose repos to include, e.g. ["my-org"]. */
  owners: string[];
  /** Explicit "owner/name" repos. */
  repos: string[];
  /** "owner/name" or globs like "my-org/old-*". */
  exclude: string[];
  /** Token specs per owner. Local: "gh", "env:VAR", "keychain:SERVICE". Worker: "app:<installation id>", "secret:NAME". */
  tokens: Record<string, string>;
  include_archived: boolean;
  include_forks: boolean;
  max_repos_per_source: number;
  prs_per_repo: number;
  host: string;
  port: number;
  /** How long the server reuses a GitHub response. */
  cache_seconds: number;
  /** How often the page auto-refreshes. */
  refresh_seconds: number;
  /** Fetch bot (PR Watcher) reviews and show their status. */
  bot_reviews: boolean;
  /** Bot logins whose reviews count, in GitHub's "[bot]" form. */
  bot_reviewers: string[];
  /** GitHub login used for "yours" and "needs your review" when the token can't answer `viewer`. */
  viewer_login: string | null;
  /** Hosted only: emails allowed through Cloudflare Access, lowercase. */
  allowed_emails: string[];
}

export const DEFAULTS: Config = {
  mine: true,
  owners: [],
  repos: [],
  exclude: [],
  tokens: {},
  include_archived: false,
  include_forks: false,
  max_repos_per_source: 200,
  prs_per_repo: 50,
  host: "127.0.0.1",
  port: 8787,
  cache_seconds: 120,
  refresh_seconds: 300,
  bot_reviews: true,
  bot_reviewers: ["grok-pr-watcher[bot]"],
  viewer_login: null,
  allowed_emails: [],
};

export class DashError extends Error {
  hint: string | null;
  status: number;

  constructor(message: string, hint: string | null = null, status = 502) {
    super(message);
    this.hint = hint;
    this.status = status;
  }
}

/** Anything that can hand out a GitHub token: the local `Tokens` class or the Worker's App resolver. */
export interface TokenSource {
  default(): Promise<string>;
  forOwner(owner: string): Promise<string>;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];

/** Coerce user-supplied values into the shapes the rest of the app assumes. */
/** Inclusive bounds for the numeric fields; `normalizeConfig` clamps to them and the hosted PUT rejects outside them. */
export const NUMBER_BOUNDS: Record<"max_repos_per_source" | "prs_per_repo" | "cache_seconds" | "refresh_seconds" | "port", [number, number]> = {
  max_repos_per_source: [1, 1000],
  prs_per_repo: [1, 100],
  cache_seconds: [0, 3600],
  refresh_seconds: [60, 3600],
  port: [1, 65535],
};

function clamp(key: keyof typeof NUMBER_BOUNDS, value: unknown): number {
  const [lo, hi] = NUMBER_BOUNDS[key];
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return DEFAULTS[key];
  return Math.max(lo, Math.min(hi, n));
}

export function normalizeConfig(cfg: Config): Config {
  const out = { ...cfg };
  for (const key of Object.keys(NUMBER_BOUNDS) as (keyof typeof NUMBER_BOUNDS)[]) out[key] = clamp(key, cfg[key]);
  out.bot_reviews = cfg.bot_reviews !== false;
  out.bot_reviewers = Array.isArray(cfg.bot_reviewers) ? strings(cfg.bot_reviewers) : DEFAULTS.bot_reviewers;
  const login = typeof cfg.viewer_login === "string" ? cfg.viewer_login.trim() : "";
  out.viewer_login = login || null;
  out.allowed_emails = strings(cfg.allowed_emails).map((e) => e.toLowerCase());
  return out;
}

/** The config the browser or an admin may see: no token specs, no email allowlist. */
export function publicConfig(cfg: Config): Omit<Config, "tokens" | "allowed_emails"> {
  const { tokens: _t, allowed_emails: _e, ...rest } = cfg;
  return rest;
}
