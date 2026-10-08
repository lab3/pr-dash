import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const ROOT = path.resolve(import.meta.dirname, "..");
export const CONFIG_PATH = process.env.PR_DASH_CONFIG ?? path.join(ROOT, "config.json");

export interface Config {
  /** Repos you own, collaborate on, or reach through your orgs. */
  mine: boolean;
  /** Extra users/orgs whose repos to include, e.g. ["my-org"]. */
  owners: string[];
  /** Explicit "owner/name" repos. */
  repos: string[];
  /** "owner/name" or globs like "my-org/old-*". */
  exclude: string[];
  /** Optional token specs: {"default": "gh", "my-org": "env:MYORG_GH_TOKEN"}. */
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

export function loadConfig(): Config {
  const cfg: Config = { ...DEFAULTS };
  if (existsSync(CONFIG_PATH)) {
    let user: unknown;
    try {
      user = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } catch (e) {
      throw new DashError(`Could not read ${path.basename(CONFIG_PATH)}: ${(e as Error).message}`,
        "Fix the JSON in your config file.", 500);
    }
    if (!user || typeof user !== "object" || Array.isArray(user)) {
      throw new DashError(`${path.basename(CONFIG_PATH)} must contain a JSON object.`, null, 500);
    }
    for (const [k, v] of Object.entries(user)) {
      if (!k.startsWith("_")) (cfg as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return normalizeConfig(cfg);
}

/** Coerce user-supplied values into the shapes the rest of the app assumes. */
export function normalizeConfig(cfg: Config): Config {
  const out = { ...cfg };
  out.prs_per_repo = Math.max(1, Math.min(100, Math.trunc(Number(cfg.prs_per_repo)) || 50));
  out.bot_reviews = cfg.bot_reviews !== false;
  out.bot_reviewers = Array.isArray(cfg.bot_reviewers)
    ? cfg.bot_reviewers.map((b) => String(b).trim()).filter(Boolean)
    : DEFAULTS.bot_reviewers;
  return out;
}

// --------------------------------------------------------------------------- tokens

async function runQuiet(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 10_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Turn a token spec into a token. Specs: "gh", "env:VAR", "keychain:SERVICE". */
export async function resolveTokenSpec(spec: string): Promise<string | null> {
  const s = spec.trim();
  if (s === "gh") return runQuiet("gh", ["auth", "token"]);
  if (s.startsWith("env:")) return process.env[s.slice(4)]?.trim() || null;
  if (s.startsWith("keychain:")) return runQuiet("security", ["find-generic-password", "-s", s.slice(9), "-w"]);
  throw new DashError(`Unknown token spec "${s}".`,
    'Use "gh", "env:VAR_NAME" or "keychain:SERVICE_NAME" (raw tokens are not accepted in ' +
    "config.json so they never end up in a file).", 500);
}

/** Default token plus optional per-owner overrides from config "tokens". */
export class Tokens {
  specs: Record<string, string>;
  cache = new Map<string, string>();

  constructor(cfg: Config) {
    this.specs = Object.fromEntries(
      Object.entries(cfg.tokens ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
  }

  async default(): Promise<string> {
    const hit = this.cache.get("\0default");
    if (hit) return hit;
    const token = this.specs.default
      ? await resolveTokenSpec(this.specs.default)
      : (await resolveTokenSpec("env:GITHUB_TOKEN")) ??
        (await resolveTokenSpec("env:GH_TOKEN")) ??
        (await resolveTokenSpec("gh"));
    if (!token) {
      throw new DashError("No GitHub token found.",
        "Run `gh auth login`, or set GITHUB_TOKEN to a token with read access to your repos.", 401);
    }
    this.cache.set("\0default", token);
    return token;
  }

  async forOwner(owner: string): Promise<string> {
    const key = owner.toLowerCase();
    const spec = this.specs[key];
    if (!spec) return this.default();
    const hit = this.cache.get(key);
    if (hit) return hit;
    const token = await resolveTokenSpec(spec);
    if (!token) {
      throw new DashError(`Token for ${owner} (${spec}) is empty or unavailable.`,
        "Check the environment variable / Keychain entry named in config.json.", 401);
    }
    this.cache.set(key, token);
    return token;
  }
}
