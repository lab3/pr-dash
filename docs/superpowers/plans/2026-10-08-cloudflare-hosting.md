# Cloudflare Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run pr-dash at `pr-dash.workarea.io` on Cloudflare Workers Free: a Worker cron builds the dashboard data every 5 minutes and stores it in KV, an Access-gated fetch handler serves it and the static assets, and the local `node server.ts` keeps working unchanged.

**Architecture:** The pure code (`github.ts`, `botreviews.ts`, `sanitize.ts`, config and views validation) moves from `src/` to `shared/` so both `server.ts` and `worker/` import it. The Worker has four modules: `access.ts` (Cloudflare Access JWT check with `jose`), `github-app.ts` (GitHub App installation tokens), `refresh.ts` (run `collect()` and write KV), and `index.ts` (routes, headers, assets, cron). `wrangler.json` is committed with placeholders that `scripts/render-wrangler.mjs` fills from environment variables at deploy; `scripts/check-config.mjs`, `check-access.mjs`, `seed-kv.mjs` and `build.mjs` are the guard rails. The browser changes by one footer line.

**Tech Stack:** TypeScript run directly by Node 22+ (type stripping), Cloudflare Workers with Static Assets and KV, `jose` 6.2.12, `wrangler` 4.149.0, `esbuild` 0.28.2, `@cloudflare/workers-types` 5.20261008.1, `node --test`, GitHub Actions.

**Spec:** `docs/specs/cloudflare-hosting.md` (v4)

## Global Constraints

- Node `>=22.18` for the local server and tests; `wrangler` needs `>=22`. Only erasable TypeScript syntax everywhere (no `enum`, `namespace`, parameter properties): Node strips types at run time and esbuild bundles `static/`.
- `static/` imports `src/` and `shared/` **only** with `import type`. The browser bundle must not pull in Node or Worker code.
- `wrangler.json` in git carries only the placeholders `__ACCOUNT_ID__`, `__HOSTNAME__`, `__KV_ID__`, `__ACCESS_TEAM_DOMAIN__`, `__ACCESS_AUD__`. No account id, hostname, namespace id, team domain, AUD, email, org name or installation id is committed anywhere. The spec names `pr-dash.workarea.io` as the example only.
- `workers_dev: false`, `preview_urls: false`, exactly one `custom_domain` route, `assets.run_worker_first: true`, `triggers.crons: ["*/5 * * * *"]`.
- Every request without a valid `Cf-Access-Jwt-Assertion` returns `403` with a one-line text body and `cache-control: no-store`, assets included. Missing `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` returns `500 Site is not configured.` The only bypass is `DEV_ACCESS_EMAIL`, and only when the request host is `localhost` or `127.0.0.1` **and** `ACCESS_AUD` is unset.
- The verified `email` claim must be in config `allowed_emails` (compared lowercase). `Host` must equal `HOSTNAME` in production.
- `GET /api/config` never returns `tokens` or `allowed_emails`. `PUT /api/config` and `PUT /api/views` require `Content-Type: application/json`, `X-PR-Dash: 1`, and `Origin` (if present) equal to `https://<HOSTNAME>` (or `http://<host>` locally).
- The browser-facing `DashboardData` shape stays as it is, plus one optional boolean `hosted`.
- GitHub App installation tokens are minted with a JWT (`iss` = App id, `iat` 60 s back, `exp` 10 min ahead, RS256) and cached per isolate for 50 minutes. Private key is PKCS#8 in the secret `GH_APP_PRIVATE_KEY`; App id in `GH_APP_ID`.
- CSP on every response: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`. Also `Referrer-Policy: same-origin`, `X-Content-Type-Options: nosniff`, `X-Robots-Tag: noindex`, `Cache-Control: private, no-store`.
- One KV write per cron run. `?refresh=1` reruns only if the stored data is older than 60 seconds.
- `collect()` stops paginating when it has made 40 GraphQL requests and adds a warning.
- Hosted queries never include `viewer { login }` (installation tokens can't answer it). `viewer_login` from config fills `isMine` and `reviewRequestedFromMe`.
- `npm test` and `npm run check` pass after every task. `package-lock.json` is committed from Task 4 on and CI uses `npm ci`.
- Commit messages end with `Claude-Session: https://claude.ai/code/session_01TGLDvt56yRdRHejPFjw9y2`.

## Review Focus

1. **A deploy with the wrong or missing AUD must fail closed.** If `ACCESS_AUD` is unset in production, every request must be 500, never 200. Pinned by the `access.ts` tests in Task 5 and the `check-config` placeholder test in Task 9.
2. **An expired or foreign Access token must not pass.** Tokens from another application in the same team (different `aud`) and expired tokens must be 403. Pinned in Task 5.
3. **`PUT /api/config` must not lock Len out.** A config without his email in `allowed_emails` would make every later request 403 with no way back except `wrangler kv`. The handler rejects a config whose `allowed_emails` doesn't contain the caller's verified email. Pinned in Task 8.
4. **The cron must never replace good data with nothing.** A thrown `collect()` leaves the previous KV value; a partial result (warnings) is still written. Pinned in Task 7.
5. **The browser bundle must not include server code.** esbuild resolving an accidental value import from `shared/` would pull `jose`-free but Node-leaning code into `dist/app.js`. Pinned by the build test in Task 4 (asserts `dist/app.js` has no `node:` or `shared/` strings).

Also tested: the subrequest budget stops paginating and warns (Task 2); a `secret:` token spec lets `wrangler dev` run against a plain `gh` token before the App exists (Task 6); `GET /api/config` strips secrets (Task 8).

## File Structure

| File | Responsibility |
| --- | --- |
| `shared/config-core.ts` (new) | `DashError`, `Config`, `DEFAULTS`, `normalizeConfig`, `TokenSource` interface. No Node imports. |
| `shared/views-core.ts` (new) | `validateViews`, `globToRegExp`, `isPattern`, `OWNER_RE`, `exactViewRepos`, `viewOwners`. No Node imports. |
| `shared/github.ts` (moved from `src/github.ts`) | Queries, raw shapes, transport, `collect`, `attachBotReviews`, shaping. `includeViewer`, request budget. |
| `shared/botreviews.ts`, `shared/sanitize.ts` (moved) | Unchanged. |
| `shared/*.test.ts` (moved from `src/`) | Existing suites plus the new cases. |
| `src/config.ts` | Node only: `ROOT`, `CONFIG_PATH`, `loadConfig`, `resolveTokenSpec`, `Tokens`. Re-exports from `shared/config-core.ts`. |
| `src/views.ts` | Node only: `VIEWS_PATH`, `loadViews`, `saveViews`. Re-exports from `shared/views-core.ts`. |
| `src/types.ts` | Unchanged shape plus `DashboardData.hosted?: boolean`. |
| `server.ts` | Imports from `shared/`; adds `/api/health`, `/api/config`; serves `/shared/*.ts` type-stripped. |
| `static/app.ts` | Footer: "cron not running" when hosted and older than 10 minutes. |
| `static/index.html` | Unchanged (`/app.ts`); the build rewrites the script tag to `/app.js`. |
| `worker/env.ts` (new) | `Env` interface, `Deps` interface for injection. |
| `worker/access.ts` (new) | `verifyAccess(request, env, deps)`: JWT check, email allowlist, host pin, dev bypass. |
| `worker/github-app.ts` (new) | `appTokens(env)`: `TokenSource` resolving `app:<id>` and `secret:<NAME>`. |
| `worker/refresh.ts` (new) | `runRefresh(env, deps)`: config + views from KV → `collect()` → KV `prs`. `readConfig`, `readViews`. |
| `worker/index.ts` (new) | `fetch` and `scheduled` handlers, routes, headers, assets. |
| `worker/*.test.ts` (new) | Node tests with fake KV, fake assets, local JWKS, stubbed `collect`. |
| `wrangler.json` (new) | Placeholders; validated by `check-config.mjs`. |
| `scripts/build.mjs` (new) | esbuild `static/app.ts` → `dist/app.js`; copy `index.html` (rewritten), `style.css`; write `_headers`. |
| `scripts/render-wrangler.mjs` (new) | Fill placeholders from env into `wrangler.deploy.json`; `--dev` fills dummies for `wrangler dev`. |
| `scripts/check-config.mjs` (new) | Reject `workers_dev`, `preview_urls`, missing domain, missing cron, leftover placeholders. |
| `scripts/check-access.mjs` (new) | Signed-out probe must 302 to the team's Access login with `kid` = AUD. |
| `scripts/seed-kv.mjs` (new) | Validate `config.hosted.json` and `views.json`, `wrangler kv key put --remote`. |
| `scripts/*.test.mjs` (new) | Tests for the scripts' pure functions. |
| `tsconfig.json`, `tsconfig.worker.json` (new) | DOM/Node vs Workers type settings. |
| `.github/workflows/check.yml` (modify), `deploy.yml` (new) | `npm ci`; main-only deploy through `production`; hourly redirect probe. |
| `package.json`, `package-lock.json`, `.gitignore`, `README.md`, `docs/specs/watcher-reviews.md` | Deps, scripts, ignores, docs. |

---

### Task 1: Pure config and views code to `shared/`

**Files:**
- Create: `shared/config-core.ts`, `shared/views-core.ts`
- Modify: `src/config.ts`, `src/views.ts`
- Move: `src/config.test.ts` → `shared/config-core.test.ts`

**Interfaces:**
- Produces:
  - `shared/config-core.ts`: `class DashError extends Error { hint: string | null; status: number }`; `interface Config` (today's keys plus `viewer_login: string | null`, `allowed_emails: string[]`); `DEFAULTS: Config`; `normalizeConfig(cfg: Config): Config`; `interface TokenSource { default(): Promise<string>; forOwner(owner: string): Promise<string> }`.
  - `shared/views-core.ts`: `validateViews`, `globToRegExp`, `isPattern`, `OWNER_RE`, `exactViewRepos`, `viewOwners` with today's signatures.
  - `src/config.ts` and `src/views.ts` re-export everything they used to export, so `server.ts` and `src/github.ts` compile unchanged.

- [ ] **Step 1: Move the config test and add the new-key assertions**

`git mv src/config.test.ts shared/config-core.test.ts`. Change its import to `from "./config-core.ts"` and append:

```ts
test("new hosted keys default to empty", () => {
  assert.equal(DEFAULTS.viewer_login, null);
  assert.deepEqual(DEFAULTS.allowed_emails, []);
});

test("normalizeConfig lowercases and trims allowed_emails and drops blanks", () => {
  const cfg = normalizeConfig({ ...DEFAULTS, allowed_emails: [" Len@Example.org ", ""] });
  assert.deepEqual(cfg.allowed_emails, ["len@example.org"]);
});

test("normalizeConfig turns a blank viewer_login into null", () => {
  assert.equal(normalizeConfig({ ...DEFAULTS, viewer_login: "  " }).viewer_login, null);
  assert.equal(normalizeConfig({ ...DEFAULTS, viewer_login: " len " }).viewer_login, "len");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test shared/config-core.test.ts`
Expected: FAIL, `Cannot find module` for `./config-core.ts`.

- [ ] **Step 3: Create `shared/config-core.ts`**

```ts
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
export function normalizeConfig(cfg: Config): Config {
  const out = { ...cfg };
  out.prs_per_repo = Math.max(1, Math.min(100, Math.trunc(Number(cfg.prs_per_repo)) || 50));
  out.bot_reviews = cfg.bot_reviews !== false;
  out.bot_reviewers = Array.isArray(cfg.bot_reviewers) ? strings(cfg.bot_reviewers) : DEFAULTS.bot_reviewers;
  const login = typeof cfg.viewer_login === "string" ? cfg.viewer_login.trim() : "";
  out.viewer_login = login || null;
  out.allowed_emails = strings(cfg.allowed_emails).map((e) => e.toLowerCase());
  return out;
}
```

- [ ] **Step 4: Shrink `src/config.ts` to the Node pieces**

Replace the file's `Config` interface, `DEFAULTS`, `DashError` and `normalizeConfig` with re-exports. The result:

```ts
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { DEFAULTS, DashError, normalizeConfig, type Config, type TokenSource } from "../shared/config-core.ts";

export { DEFAULTS, DashError, normalizeConfig, type Config, type TokenSource };

const execFileAsync = promisify(execFile);

export const ROOT = path.resolve(import.meta.dirname, "..");
export const CONFIG_PATH = process.env.PR_DASH_CONFIG ?? path.join(ROOT, "config.json");

export function loadConfig(): Config {
  // ... unchanged body ...
}

// --------------------------------------------------------------------------- tokens
// runQuiet, resolveTokenSpec unchanged.

/** Default token plus optional per-owner overrides from config "tokens". */
export class Tokens implements TokenSource {
  // ... unchanged body ...
}
```

Keep every existing function body as it is; only the top of the file changes. `Tokens` gains `implements TokenSource` (its methods already match).

- [ ] **Step 5: Create `shared/views-core.ts` and shrink `src/views.ts`**

Move `MAX_VIEWS`, `MAX_ENTRIES`, `ENTRY_RE`, `OWNER_RE`, `isPattern`, `globToRegExp`, `validateViews`, `exactViewRepos`, `viewOwners` verbatim into `shared/views-core.ts` with these imports:

```ts
// Views validation shared by the Node server and the Cloudflare Worker. No "node:*" imports.
import { DashError } from "./config-core.ts";
import type { View } from "../src/types.ts";
```

`src/views.ts` becomes:

```ts
import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { DashError, ROOT } from "./config.ts";
import { OWNER_RE, exactViewRepos, globToRegExp, isPattern, validateViews, viewOwners } from "../shared/views-core.ts";
import type { View } from "./types.ts";

export { OWNER_RE, exactViewRepos, globToRegExp, isPattern, validateViews, viewOwners };

export const VIEWS_PATH = process.env.PR_DASH_VIEWS ?? path.join(ROOT, "views.json");

export function loadViews(): View[] { /* unchanged */ }
export async function saveViews(views: View[]): Promise<void> { /* unchanged */ }
```

- [ ] **Step 6: Point the test glob at `shared/` and run everything**

In `package.json`, the test script becomes:

```json
"test": "node --test 'src/**/*.test.ts' 'shared/**/*.test.ts' 'static/**/*.test.ts'"
```

Add `"shared/**/*.ts"` to `tsconfig.json`'s `include`.

Run: `npm test && npm run check`
Expected: 56 + 3 = 59 pass; tsc clean. `src/github.ts` still imports `DashError` from `./config.ts` and `globToRegExp` from `./views.ts`, which the re-exports satisfy.

- [ ] **Step 7: Commit**

```bash
git add shared/config-core.ts shared/views-core.ts shared/config-core.test.ts src/config.ts src/views.ts package.json tsconfig.json
git commit -m "refactor: move config and views validation to shared/

Claude-Session: https://claude.ai/code/session_01TGLDvt56yRdRHejPFjw9y2"
```

---

### Task 2: `shared/github.ts` with `includeViewer` and a request budget

**Files:**
- Move: `src/github.ts` → `shared/github.ts`, `src/github.test.ts` → `shared/github.test.ts`, `src/botreviews.ts` → `shared/botreviews.ts`, `src/botreviews.test.ts` → `shared/botreviews.test.ts`, `src/sanitize.ts` → `shared/sanitize.ts`, `src/sanitize.test.ts` → `shared/sanitize.test.ts`
- Modify: `server.ts` (imports), `static/lib/watcher.ts`, `static/lib/state.ts`, `static/lib/list.ts`, `static/lib/grid.ts` (none import `src/` values; confirm), `README.md` project layout

**Interfaces:**
- Consumes: `TokenSource`, `DashError`, `Config` from `shared/config-core.ts`; `globToRegExp` from `shared/views-core.ts`.
- Produces:
  - `ownerQuery(includeViewer: boolean): string`, `explicitQuery(count: number, includeViewer: boolean): string`; `VIEWER_QUERY` unchanged; `botReviewsQuery` unchanged.
  - `collect(cfg: Config, tokens: TokenSource, extra?: ExtraSources, opts?: { maxRequests?: number }): Promise<...>`. Behavior: `includeViewer = !cfg.viewer_login`; `ctx.viewer` starts as `cfg.viewer_login`; every `graphql()` call increments `ctx.requests`; `paginate` stops and warns `"Stopped fetching <owner> after <n> GitHub requests; raise max_repos_per_source pages later or narrow the sources."` when `ctx.requests >= opts.maxRequests` (default 40).
  - `Context` gains `requests: number`.
  - `graphql()` reads `GITHUB_GRAPHQL_URL` from `globalThis.process?.env` when present, so it also runs in a Worker.

- [ ] **Step 1: Move the files**

```bash
git mv src/github.ts shared/github.ts
git mv src/github.test.ts shared/github.test.ts
git mv src/botreviews.ts shared/botreviews.ts
git mv src/botreviews.test.ts shared/botreviews.test.ts
git mv src/sanitize.ts shared/sanitize.ts
git mv src/sanitize.test.ts shared/sanitize.test.ts
```

In `shared/github.ts` change the imports to:

```ts
import { botLogin, mergeBlockers, shapeWatcher, type RawBotReview, type RawThread } from "./botreviews.ts";
import { DashError, type Config, type TokenSource } from "./config-core.ts";
import type {
  CheckState, DashboardData, MergeStateStatus, MergeableState, PullRequest, RateLimit, Repo, ReviewDecision,
} from "../src/types.ts";
import { globToRegExp } from "./views-core.ts";
```

In `shared/botreviews.ts` change `from "./types.ts"` to `from "../src/types.ts"`. In `shared/github.test.ts` change `from "./config.ts"` to `from "./config-core.ts"` and `from "./types.ts"` to `from "../src/types.ts"`. In `server.ts`: `import { collect } from "./shared/github.ts";`.

- [ ] **Step 2: Write the failing tests**

Append to `shared/github.test.ts` (add `ownerQuery`, `collect` to the import; `explicitQuery` too):

```ts
test("ownerQuery and explicitQuery omit viewer when asked", () => {
  assert.ok(ownerQuery(true).includes("viewer { login }"));
  assert.ok(!ownerQuery(false).includes("viewer"));
  assert.ok(explicitQuery(2, true).includes("viewer { login }"));
  assert.ok(!explicitQuery(2, false).includes("viewer"));
  assert.ok(ownerQuery(false).includes("repositoryOwner(login: $login)"));
});

// ---------------------------------------------------------------- collect with a stubbed fetch

function ownerPage(repos: string[], hasNextPage: boolean): string {
  return JSON.stringify({
    data: {
      repositoryOwner: {
        login: "o",
        repositories: {
          pageInfo: { hasNextPage, endCursor: hasNextPage ? "c" : null },
          nodes: repos.map((name) => ({
            nameWithOwner: `o/${name}`, url: `https://github.com/o/${name}`, description: null, isPrivate: false,
            isArchived: false, isFork: false, pushedAt: null, primaryLanguage: null,
            pullRequests: { totalCount: 0, nodes: [] },
          })),
        },
      },
      rateLimit: { limit: 5000, remaining: 4000, resetAt: "x", cost: 50 },
    },
  });
}

async function withFetch<T>(pages: string[], body: () => Promise<T>): Promise<{ result: T; calls: { query: string; variables: Record<string, unknown> }[] }> {
  const real = globalThis.fetch;
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  let i = 0;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    const text = pages[Math.min(i++, pages.length - 1)];
    return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    return { result: await body(), calls };
  } finally {
    globalThis.fetch = real;
  }
}

const tokens = { default: async () => "t", forOwner: async () => "t" };

test("collect uses viewer_login and drops viewer from the queries", async () => {
  const cfg = { ...DEFAULTS, mine: false, owners: ["o"], viewer_login: "len" };
  const { result, calls } = await withFetch([ownerPage(["a"], false)], () => collect(cfg, tokens));
  assert.equal(result.viewer, "len");
  assert.ok(calls.every((c) => !c.query.includes("viewer")));
});

test("collect keeps viewer in the queries when viewer_login is unset", async () => {
  const cfg = { ...DEFAULTS, mine: false, owners: ["o"] };
  const { calls } = await withFetch([ownerPage(["a"], false)], () => collect(cfg, tokens));
  assert.ok(calls.every((c) => c.query.includes("viewer { login }")));
});

test("collect stops paginating at the request budget and warns", async () => {
  const cfg = { ...DEFAULTS, mine: false, owners: ["o"], max_repos_per_source: 1000 };
  const { result, calls } = await withFetch([ownerPage(["a"], true)], () => collect(cfg, tokens, undefined, { maxRequests: 3 }));
  assert.equal(calls.length, 3);
  assert.ok(result.warnings.some((w) => w.startsWith("Stopped fetching o after 3 GitHub requests")));
  assert.equal(result.repos.length, 1); // the same repo three times, deduped
});
```

- [ ] **Step 3: Run to see them fail**

Run: `node --test shared/github.test.ts`
Expected: FAIL, `ownerQuery` is not exported.

- [ ] **Step 4: Implement**

In `shared/github.ts`:

Replace the `API_URL` line with:

```ts
// Override for GitHub Enterprise Server. Read lazily so the module also loads in a Worker (no `process`).
const API_URL = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.GITHUB_GRAPHQL_URL
  ?? "https://api.github.com/graphql";
```

Replace `OWNER_QUERY` and `explicitQuery` with:

```ts
const viewerField = (on: boolean): string => (on ? "viewer { login }\n" : "");

/** Repos of one user/org, one page. `includeViewer` is false when the token can't answer `viewer` (GitHub Apps). */
export function ownerQuery(includeViewer: boolean): string {
  return REPO_FRAGMENT + /* GraphQL */ `
query($login: String!, $cursor: String, $n: Int!, $prs: Int!) {
  ${viewerField(includeViewer)}repositoryOwner(login: $login) {
    login
    repositories(first: $n, after: $cursor, orderBy: {field: PUSHED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { ...RepoFields }
    }
  }
  rateLimit { limit remaining resetAt cost }
}
`;
}

export function explicitQuery(count: number, includeViewer: boolean): string {
  const decls = ["$prs: Int!"];
  const fields: string[] = [];
  for (let i = 0; i < count; i++) {
    decls.push(`$o${i}: String!`, `$n${i}: String!`);
    fields.push(`r${i}: repository(owner: $o${i}, name: $n${i}) { ...RepoFields }`);
  }
  return REPO_FRAGMENT +
    `query(${decls.join(", ")}) {\n  ${viewerField(includeViewer)}${fields.join("\n  ")}\n  rateLimit { limit remaining resetAt cost }\n}`;
}
```

Keep `export const OWNER_QUERY = ownerQuery(true);` for the existing test that checks marker fields in `VIEWER_QUERY` (unchanged) — and update that test to also check `ownerQuery(true)` if it referenced `OWNER_QUERY`.

`Context` gains `requests: number` and a budget:

```ts
export interface Context {
  warnings: string[];
  viewer: string | null;
  rate: RateLimit | null;
  /** GraphQL requests made so far; `collect` stops paginating at `maxRequests`. */
  requests: number;
  maxRequests: number;
}
```

Add a helper used everywhere `graphql()` was called inside this file:

```ts
async function call(token: string, query: string, variables: Record<string, unknown>, ctx: Context) {
  ctx.requests++;
  const out = await graphql(token, query, variables);
  ctx.warnings.push(...out.errors);
  ctx.viewer = out.data.viewer?.login ?? ctx.viewer;
  ctx.rate = out.data.rateLimit ?? ctx.rate;
  return out.data;
}
```

`paginate` becomes:

```ts
async function* paginate(
  token: string, query: string, variables: Record<string, unknown>,
  pick: (d: QueryData) => RepoConnection | null | undefined, limit: number, ctx: Context, label: string,
): AsyncGenerator<RawRepo, boolean> {
  let cursor: string | null = null;
  let seen = 0;
  while (seen < limit) {
    if (ctx.requests >= ctx.maxRequests) {
      ctx.warnings.push(`Stopped fetching ${label} after ${ctx.requests} GitHub requests; raise max_repos_per_source pages later or narrow the sources.`);
      break;
    }
    const n = Math.min(REPO_PAGE_SIZE, limit - seen);
    const data = await call(token, query, { ...variables, cursor, n }, ctx);
    const conn = pick(data);
    if (!conn) return false;
    for (const repo of conn.nodes ?? []) {
      if (repo) {
        seen++;
        yield repo;
      }
    }
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return true;
}
```

`fetchExplicit` takes `includeViewer: boolean` and uses `call(...)` with `explicitQuery(batch.length, includeViewer)`. The errors filter (`Could not resolve to a Repository`) must now run on the warnings it just pushed; simplest: in `fetchExplicit`, call `graphql` directly as before but increment `ctx.requests++` first, keeping its existing error filtering. `fetchBotReviews` likewise does `ctx.requests++` before each `graphql`.

`collect`:

```ts
export async function collect(
  cfg: Config, tokens: TokenSource, extra: ExtraSources = { repos: [], owners: [] },
  opts: { maxRequests?: number } = {},
): Promise<Omit<DashboardData, "fetchMs" | "generatedAt" | "refreshSeconds">> {
  const includeViewer = !cfg.viewer_login;
  const ctx: Context = { warnings: [], viewer: cfg.viewer_login ?? null, rate: null, requests: 0, maxRequests: opts.maxRequests ?? 40 };
  // ... `mine` block: paginate(..., VIEWER_QUERY, ..., ctx, "your repos")
  // ... owners block: paginate(await tokens.forOwner(owner), ownerQuery(includeViewer), { prs, login: owner }, (d) => d.repositoryOwner?.repositories, limit, ctx, owner)
  // ... explicit block: fetchExplicit(await tokens.forOwner(owner), group, prs, ctx, includeViewer)
  // rest unchanged
}
```

`collect`'s `tokens` parameter type changes from `Tokens` to `TokenSource`; `attachBotReviews`'s stays `Pick<TokenSource, "forOwner">`.

- [ ] **Step 5: Run all tests and the type check**

Run: `npm test && npm run check`
Expected: 59 + 4 = 63 pass; tsc clean. If `static/` fails to type-check because `static/lib/*.ts` imported a value from `../../src/botreviews.ts`, that import was already a bug; it must be `import type` from `../../src/types.ts` only.

- [ ] **Step 6: Update the README project layout**

Replace the `src/github.ts`, `src/botreviews.ts`, `src/sanitize.ts`, `src/*.test.ts` lines in the "Project layout" block with:

```
shared/github.ts     GraphQL queries, pagination, shaping, Watcher fetch (Node and Worker)
shared/botreviews.ts Watcher status rules and merge blockers (pure, tested)
shared/sanitize.ts   allowlist filter for GitHub's rendered bodyHTML (pure, tested)
shared/config-core.ts, shared/views-core.ts  config and views validation shared by both runtimes
shared/*.test.ts, static/lib/*.test.ts       node --test suites
src/config.ts        config.json loading, token resolution (gh / env / macOS Keychain)
src/views.ts         views.json load/save
```

- [ ] **Step 7: Commit**

```bash
git add -A shared src server.ts README.md
git commit -m "refactor: move GitHub fetch, Watcher and sanitizer code to shared/; add includeViewer and a request budget

Claude-Session: https://claude.ai/code/session_01TGLDvt56yRdRHejPFjw9y2"
```

---

### Task 3: `hosted` flag, footer note, local `/api/health` and `/api/config`

**Files:**
- Modify: `src/types.ts`, `static/app.ts`, `server.ts`
- Test: `static/lib/state.test.ts` (no change needed), manual `curl`

**Interfaces:**
- Produces: `DashboardData.hosted?: boolean`; `server.ts` routes `GET /api/health` → `{"ok":true}`, `GET /api/config` → `publicConfig(cfg)`, `PUT /api/config` → 405 locally with hint "Edit config.json; the hosted site accepts PUT." `publicConfig(cfg: Config): Omit<Config, "tokens" | "allowed_emails">` exported from `shared/config-core.ts` (used by the Worker in Task 8).

- [ ] **Step 1: Types and `publicConfig`**

`src/types.ts`, `DashboardData`: add after `botReviews`:

```ts
  /** True when served by the Cloudflare Worker, whose data comes from the cron. */
  hosted?: boolean;
```

`shared/config-core.ts`: append

```ts
/** The config the browser or an admin may see: no token specs, no email allowlist. */
export function publicConfig(cfg: Config): Omit<Config, "tokens" | "allowed_emails"> {
  const { tokens: _t, allowed_emails: _e, ...rest } = cfg;
  return rest;
}
```

and a test in `shared/config-core.test.ts`:

```ts
test("publicConfig strips tokens and allowed_emails", () => {
  const pub = publicConfig({ ...DEFAULTS, tokens: { default: "gh" }, allowed_emails: ["a@b.c"] }) as Record<string, unknown>;
  assert.equal("tokens" in pub, false);
  assert.equal("allowed_emails" in pub, false);
  assert.equal(pub.prs_per_repo, 50);
});
```

- [ ] **Step 2: Footer**

In `static/app.ts` `renderFooter`, after the `parts` array is built:

```ts
  const ageMs = Date.now() - +new Date(d.generatedAt);
  if (d.hosted && ageMs > 10 * 60_000) parts.push("cron not running");
```

- [ ] **Step 3: Server routes**

In `server.ts` `api()`, before the final `throw`:

```ts
  if (url.pathname === "/api/health" && req.method === "GET") return { ok: true };
  if (url.pathname === "/api/config" && req.method === "GET") return publicConfig(loadConfig());
  if (url.pathname === "/api/config" && req.method === "PUT") {
    throw new DashError("Config is a file in local mode.", "Edit config.json; it is re-read on the next refresh.", 405);
  }
```

Widen `api()`'s return type and `sendJson`'s body type to `DashboardData | ViewsPayload | ApiError | Record<string, unknown>`. Import `publicConfig` from `./shared/config-core.ts`.

- [ ] **Step 4: Verify**

Run: `npm test && npm run check` → 64 pass, tsc clean. Then:

```bash
node server.ts --port 8793 &
sleep 1
curl -s http://127.0.0.1:8793/api/health
curl -s http://127.0.0.1:8793/api/config | python3 -c 'import json,sys; d=json.load(sys.stdin); print("tokens" in d, "allowed_emails" in d, d["prs_per_repo"])'
curl -s -X PUT -H 'Content-Type: application/json' -H 'X-PR-Dash: 1' -d '{}' http://127.0.0.1:8793/api/config
kill %1
```

Expected: `{"ok":true}`; `False False 50`; a 405 JSON error.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts static/app.ts server.ts shared/config-core.ts shared/config-core.test.ts
git commit -m "feat: hosted flag with a cron-stale footer note; /api/health and /api/config locally

Claude-Session: https://claude.ai/code/session_01TGLDvt56yRdRHejPFjw9y2"
```

---

### Task 4: Dependencies, lockfile, build script, Worker tsconfig

**Files:**
- Modify: `package.json`, `.gitignore`, `.github/workflows/check.yml`
- Create: `package-lock.json`, `scripts/build.mjs`, `scripts/build.test.mjs`, `tsconfig.worker.json`

**Interfaces:**
- Produces: `npm run build` → `dist/app.js`, `dist/index.html` (script tag `/app.js`), `dist/style.css`, `dist/_headers`. `scripts/build.mjs` exports `build({ staticDir, outDir })` and `HEADERS`. `npm run check` runs both tsconfigs.

- [ ] **Step 1: Install pinned dependencies**

```bash
npm install --save-exact jose@6.2.12
npm install --save-exact --save-dev wrangler@4.149.0 esbuild@0.28.2 @cloudflare/workers-types@5.20261008.1
```

This creates `package-lock.json`. Then edit `package.json` scripts:

```json
"scripts": {
  "start": "node server.ts",
  "open": "node server.ts --open",
  "check": "tsc --noEmit && tsc --noEmit -p tsconfig.worker.json",
  "test": "node --test 'src/**/*.test.ts' 'shared/**/*.test.ts' 'static/**/*.test.ts' 'worker/**/*.test.ts' 'scripts/**/*.test.mjs'",
  "build": "node scripts/build.mjs",
  "dev:worker": "node scripts/render-wrangler.mjs --dev && npm run build && wrangler dev --config wrangler.deploy.json"
}
```

`.gitignore` gains:

```
dist/
.dev.vars
.wrangler/
wrangler.deploy.json
config.hosted.json
```

- [ ] **Step 2: Worker tsconfig**

`tsconfig.worker.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "lib": ["ES2023"],
    "types": ["@cloudflare/workers-types"]
  },
  "include": ["worker/**/*.ts", "shared/**/*.ts", "src/types.ts"]
}
```

`tsconfig.json`'s `include` must not list `worker/**` (DOM lib vs Workers lib clash). Its current `include` is `["server.ts", "src/**/*.ts", "static/**/*.ts", "shared/**/*.ts"]`.

- [ ] **Step 3: Write the failing build test**

`scripts/build.test.mjs`:

```js
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
```

Run: `node --test scripts/build.test.mjs` → FAIL, cannot find `./build.mjs`.

- [ ] **Step 4: Write `scripts/build.mjs`**

```js
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
```

Note: `static/app.ts` uses top-level `await` (boot). esbuild with `format: "esm"` and `target: "es2022"` supports it.

- [ ] **Step 5: CI uses the lockfile**

`.github/workflows/check.yml`: change `npm install` to `npm ci`, and add `- run: npm run build` after `npm test`.

- [ ] **Step 6: Run everything**

Run: `npm test && npm run check && npm run build && ls dist`
Expected: 65 pass (64 + build test); both tsc runs clean (the worker one has no files yet beyond `shared/` and `src/types.ts`, which must compile with `lib: ES2023` — `shared/github.ts` uses `fetch`, `Response`, `AbortSignal`, which workers-types provide); `dist/` has the four files.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitignore .github/workflows/check.yml scripts/build.mjs scripts/build.test.mjs tsconfig.worker.json
git commit -m "build: pinned wrangler/esbuild/jose, lockfile, esbuild bundle of the browser app, Worker tsconfig

Claude-Session: https://claude.ai/code/session_01TGLDvt56yRdRHejPFjw9y2"
```

---

### Task 5: `worker/access.ts` — Cloudflare Access gate

**Files:**
- Create: `worker/env.ts`, `worker/access.ts`
- Test: `worker/access.test.ts`

**Interfaces:**
- Produces:
  - `worker/env.ts`:
    ```ts
    export interface Env {
      PRDASH: KVNamespace;
      ASSETS: { fetch(request: Request): Promise<Response> };
      ACCESS_TEAM_DOMAIN?: string;   // "https://<team>.cloudflareaccess.com"
      ACCESS_AUD?: string;
      HOSTNAME?: string;
      DEV_ACCESS_EMAIL?: string;     // .dev.vars only
      GH_APP_ID?: string;            // secret
      GH_APP_PRIVATE_KEY?: string;   // secret, PKCS#8
      [secret: string]: unknown;     // "secret:NAME" token specs read env[NAME]
    }
    ```
  - `worker/access.ts`: `type AccessResult = { ok: true; email: string } | { ok: false; response: Response }`; `verifyAccess(request: Request, env: Env, allowedEmails: string[], deps?: AccessDeps): Promise<AccessResult>`; `interface AccessDeps { getJwks(teamDomain: string): JWTVerifyGetKey }`; `deny(message: string, status?: number): Response`; `isLocalHost(host: string): boolean`.

- [ ] **Step 1: Write the failing tests**

`worker/access.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { verifyAccess } from "./access.ts";
import type { Env } from "./env.ts";

const TEAM = "https://team.cloudflareaccess.com";
const AUD = "a".repeat(64);

const pair = await generateKeyPair("RS256");
const other = await generateKeyPair("RS256");
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }] });
const deps = { getJwks: () => jwks };

async function token(claims: Record<string, unknown>, key = pair.privateKey, exp = "10m"): Promise<string> {
  return new SignJWT({ email: "len@bitfly.org", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(TEAM).setAudience(AUD).setIssuedAt().setExpirationTime(exp).sign(key);
}

const env = (over: Partial<Env> = {}): Env =>
  ({ PRDASH: {} as KVNamespace, ASSETS: { fetch: async () => new Response("asset") }, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, HOSTNAME: "pr.example.test", ...over }) as Env;

const req = (jwt: string | null, host = "pr.example.test"): Request =>
  new Request(`https://${host}/`, { headers: jwt ? { "cf-access-jwt-assertion": jwt, host } : { host } });

const allowed = ["len@bitfly.org"];

test("valid token for an allowed email passes", async () => {
  const r = await verifyAccess(req(await token({})), env(), allowed, deps);
  assert.deepEqual(r, { ok: true, email: "len@bitfly.org" });
});

test("missing header is 403 with no-store", async () => {
  const r = await verifyAccess(req(null), env(), allowed, deps);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.response.status, 403);
    assert.equal(r.response.headers.get("cache-control"), "no-store");
  }
});

test("wrong audience, wrong issuer, expired, wrong key are all 403", async () => {
  for (const jwt of [
    await new SignJWT({ email: "len@bitfly.org" }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(TEAM).setAudience("b".repeat(64)).setIssuedAt().setExpirationTime("10m").sign(pair.privateKey),
    await new SignJWT({ email: "len@bitfly.org" }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer("https://evil.cloudflareaccess.com").setAudience(AUD).setIssuedAt().setExpirationTime("10m").sign(pair.privateKey),
    await new SignJWT({ email: "len@bitfly.org" }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(TEAM).setAudience(AUD).setIssuedAt(Math.floor(Date.now() / 1000) - 7200).setExpirationTime(Math.floor(Date.now() / 1000) - 3600).sign(pair.privateKey),
    await token({}, other.privateKey),
  ]) {
    const r = await verifyAccess(req(jwt), env(), allowed, deps);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.response.status, 403);
  }
});

test("email not in the allowlist is 403; comparison is case-insensitive", async () => {
  const bad = await verifyAccess(req(await token({ email: "someone@bitfly.org" })), env(), allowed, deps);
  assert.equal(bad.ok, false);
  const ok = await verifyAccess(req(await token({ email: "Len@Bitfly.org" })), env(), allowed, deps);
  assert.equal(ok.ok, true);
});

test("wrong Host is 403 even with a valid token", async () => {
  const r = await verifyAccess(req(await token({}), "other.example.test"), env(), allowed, deps);
  assert.equal(r.ok, false);
});

test("missing ACCESS_TEAM_DOMAIN or ACCESS_AUD is 500 not configured", async () => {
  for (const over of [{ ACCESS_TEAM_DOMAIN: undefined }, { ACCESS_AUD: undefined }]) {
    const r = await verifyAccess(req(await token({})), env(over), allowed, deps);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.response.status, 500);
      assert.equal(await r.response.text(), "Site is not configured.");
    }
  }
});

test("dev bypass works only on a local host with ACCESS_AUD unset", async () => {
  const dev = env({ ACCESS_AUD: undefined, ACCESS_TEAM_DOMAIN: undefined, HOSTNAME: undefined, DEV_ACCESS_EMAIL: "len@bitfly.org" });
  const local = await verifyAccess(req(null, "localhost:8787"), dev, allowed, deps);
  assert.deepEqual(local, { ok: true, email: "len@bitfly.org" });
  const remote = await verifyAccess(req(null, "pr.example.test"), dev, allowed, deps);
  assert.equal(remote.ok, false);
  const withAud = await verifyAccess(req(null, "localhost:8787"), env({ DEV_ACCESS_EMAIL: "len@bitfly.org" }), allowed, deps);
  assert.equal(withAud.ok, false);
});
```

Run: `node --test worker/access.test.ts` → FAIL, cannot find `./access.ts`.

- [ ] **Step 2: Write `worker/env.ts` and `worker/access.ts`**

`worker/env.ts`: the interface from the Interfaces block, with a doc comment per field.

`worker/access.ts`:

```ts
// Fail-closed gate in front of everything the Worker serves, assets included. Cloudflare Access
// adds a signed JWT to every request in Cf-Access-Jwt-Assertion; we verify it against the team's
// public keys, pin the audience to this application, and require the email to be on the
// allowlist from KV config. Same approach as bedrock.workarea.io's worker.js.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Env } from "./env.ts";

export type AccessResult = { ok: true; email: string } | { ok: false; response: Response };

export interface AccessDeps {
  /** Returns a key resolver for the team's JWKS. Tests pass a local key set. */
  getJwks(teamDomain: string): JWTVerifyGetKey;
}

const jwksCache = new Map<string, JWTVerifyGetKey>();

const defaultDeps: AccessDeps = {
  getJwks(teamDomain) {
    let jwks = jwksCache.get(teamDomain);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
      jwksCache.set(teamDomain, jwks);
    }
    return jwks;
  },
};

export function deny(message: string, status = 403): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export function isLocalHost(host: string): boolean {
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return name === "localhost" || name === "127.0.0.1";
}

export async function verifyAccess(
  request: Request, env: Env, allowedEmails: string[], deps: AccessDeps = defaultDeps,
): Promise<AccessResult> {
  const host = request.headers.get("host") ?? new URL(request.url).host;

  // Local development only: `wrangler dev` with DEV_ACCESS_EMAIL in .dev.vars and no ACCESS_AUD.
  if (env.DEV_ACCESS_EMAIL && !env.ACCESS_AUD && isLocalHost(host)) {
    return { ok: true, email: env.DEV_ACCESS_EMAIL.toLowerCase() };
  }

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return { ok: false, response: deny("Site is not configured.", 500) };
  if (env.HOSTNAME && host.toLowerCase() !== env.HOSTNAME.toLowerCase()) {
    return { ok: false, response: deny("Wrong host.") };
  }

  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) return { ok: false, response: deny("Sign in through Cloudflare Access to view this site.") };

  let email: string;
  try {
    const { payload } = await jwtVerify(jwt, deps.getJwks(env.ACCESS_TEAM_DOMAIN), {
      issuer: env.ACCESS_TEAM_DOMAIN,
      audience: env.ACCESS_AUD,
    });
    email = String(payload.email ?? "").toLowerCase();
  } catch {
    return { ok: false, response: deny("Access token could not be verified.") };
  }
  if (!email || !allowedEmails.includes(email)) {
    return { ok: false, response: deny("This account is not allowed to view this site.") };
  }
  return { ok: true, email };
}
```

- [ ] **Step 3: Run the tests and the type check**

Run: `node --test worker/access.test.ts && npm run check`
Expected: 7 pass; tsc clean for both configs. If `tsc -p tsconfig.worker.json` complains that `worker/access.test.ts` uses `node:test`, add `"exclude": ["worker/**/*.test.ts"]` to `tsconfig.worker.json` and `"worker/**/*.test.ts"` to `tsconfig.json`'s `include` (tests run under Node, so Node types are right for them).

- [ ] **Step 4: Commit**

```bash
git add worker/env.ts worker/access.ts worker/access.test.ts tsconfig.json tsconfig.worker.json
git commit -m "feat(worker): Cloudflare Access gate with jose, email allowlist and host pin

Claude-Session: https://claude.ai/code/session_01TGLDvt56yRdRHejPFjw9y2"
```

---

### Task 6: `worker/github-app.ts` — installation tokens

**Files:**
- Create: `worker/github-app.ts`
- Test: `worker/github-app.test.ts`

**Interfaces:**
- Consumes: `TokenSource`, `Config`, `DashError` from `shared/config-core.ts`.
- Produces: `appTokens(cfg: Config, env: Env, deps?: AppDeps): TokenSource`. Spec forms: `app:<installation id>` → mint; `secret:NAME` → `String(env[NAME])`. `default` uses `cfg.tokens.default`, else the only `app:` entry if exactly one owner is configured, else throws `DashError("No default token", ..., 500)`. `interface AppDeps { fetch: typeof fetch; now(): number }`. `mintAppJwt(appId: string, pkcs8: string, nowSec: number): Promise<string>` exported for tests. Installation tokens cached in a module-level `Map<installationId, { token, expiresAt }>` for 50 minutes.

- [ ] **Step 1: Write the failing tests**

`worker/github-app.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeJwt, exportPKCS8, exportSPKI, generateKeyPair, importSPKI, jwtVerify } from "jose";
import { DEFAULTS } from "../shared/config-core.ts";
import type { Env } from "./env.ts";
import { appTokens, mintAppJwt, resetTokenCache } from "./github-app.ts";

const pair = await generateKeyPair("RS256", { extractable: true });
const pkcs8 = await exportPKCS8(pair.privateKey);
const spki = await exportSPKI(pair.publicKey);

test("mintAppJwt signs RS256 with iss, iat 60s back, exp 10 min ahead", async () => {
  const jwt = await mintAppJwt("12345", pkcs8, 1_700_000_000);
  const { payload, protectedHeader } = await jwtVerify(jwt, await importSPKI(spki, "RS256"), { currentDate: new Date(1_700_000_000 * 1000) });
  assert.equal(protectedHeader.alg, "RS256");
  assert.equal(payload.iss, "12345");
  assert.equal(payload.iat, 1_700_000_000 - 60);
  assert.equal(payload.exp, 1_700_000_000 + 600);
});

function fakeEnv(over: Partial<Env> = {}): Env {
  return { PRDASH: {} as KVNamespace, ASSETS: { fetch: async () => new Response() }, GH_APP_ID: "12345", GH_APP_PRIVATE_KEY: pkcs8, MY_TOKEN: "ghp_secret", ...over } as Env;
}

test("secret:NAME resolves from env", async () => {
  const cfg = { ...DEFAULTS, tokens: { default: "secret:MY_TOKEN" } };
  const t = appTokens(cfg, fakeEnv());
  assert.equal(await t.default(), "ghp_secret");
  assert.equal(await t.forOwner("Anyone"), "ghp_secret");
});

test("app:<id> exchanges a JWT for an installation token and caches it", async () => {
  resetTokenCache();
  const calls: { url: string; auth: string | null }[] = [];
  const deps = {
    now: () => 1_700_000_000_000,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ token: "ghs_inst", expires_at: "2026-01-01T00:00:00Z" }), { status: 201 });
    }) as typeof fetch,
  };
  const cfg = { ...DEFAULTS, tokens: { carecise: "app:777" } };
  const t = appTokens(cfg, fakeEnv(), deps);
  assert.equal(await t.forOwner("Carecise"), "ghs_inst");
  assert.equal(await t.forOwner("carecise"), "ghs_inst");
  assert.equal(calls.length, 1, "second call served from cache");
  assert.equal(calls[0].url, "https://api.github.com/app/installations/777/access_tokens");
  assert.ok(calls[0].auth?.startsWith("Bearer "));
  assert.equal(decodeJwt(calls[0].auth!.slice(7)).iss, "12345");
});

test("default() uses tokens.default, else the single app entry, else throws", async () => {
  resetTokenCache();
  const deps = { now: () => 0, fetch: (async () => new Response(JSON.stringify({ token: "ghs_x", expires_at: "x" }), { status: 201 })) as typeof fetch };
  assert.equal(await appTokens({ ...DEFAULTS, tokens: { lab3: "app:1" } }, fakeEnv(), deps).default(), "ghs_x");
  await assert.rejects(appTokens({ ...DEFAULTS, tokens: { a: "app:1", b: "app:2" } }, fakeEnv(), deps).default(), /No default token/);
  await assert.rejects(appTokens({ ...DEFAULTS, tokens: {} }, fakeEnv(), deps).default(), /No default token/);
});

test("an owner with no token spec falls back to default; missing App secrets throw", async () => {
  resetTokenCache();
  await assert.rejects(appTokens({ ...DEFAULTS, tokens: { x: "app:1" } }, fakeEnv({ GH_APP_PRIVATE_KEY: undefined }), { now: () => 0, fetch }).forOwner("x"), /GH_APP_PRIVATE_KEY/);
  const cfg = { ...DEFAULTS, tokens: { default: "secret:MY_TOKEN" } };
  assert.equal(await appTokens(cfg, fakeEnv()).forOwner("unknown-org"), "ghp_secret");
});

test("a failed exchange throws a DashError naming the installation", async () => {
  resetTokenCache();
  const deps = { now: () => 0, fetch: (async () => new Response("nope", { status: 401 })) as typeof fetch };
  await assert.rejects(appTokens({ ...DEFAULTS, tokens: { o: "app:9" } }, fakeEnv(), deps).forOwner("o"), /installation 9/);
});
```

Run: `node --test worker/github-app.test.ts` → FAIL, cannot find `./github-app.ts`.

- [ ] **Step 2: Write `worker/github-app.ts`**

```ts
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

async function installationToken(id: string, env: Env, deps: AppDeps): Promise<string> {
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
  const body = (await res.json()) as { token: string };
  cache.set(id, { token: body.token, expiresAt: deps.now() + CACHE_MS });
  return body.token;
}

async function resolve(spec: string, env: Env, deps: AppDeps): Promise<string> {
  const s = spec.trim();
  if (s.startsWith("app:")) return installationToken(s.slice(4), env, deps);
  if (s.startsWith("secret:")) {
    const v = env[s.slice(7)];
    if (typeof v !== "string" || !v) throw new DashError(`Secret ${s.slice(7)} is not set.`, null, 500);
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
```

- [ ] **Step 3: Run tests and type check**

Run: `node --test worker/github-app.test.ts && npm run check`
Expected: 6 pass; tsc clean.

- [ ] **Step 4: Commit**

```bash
git add worker/github-app.ts worker/github-app.test.ts
git commit -m "feat(worker): GitHub App installation tokens with app:<id> and secret:NAME specs

Claude-Session: https://claude.ai/code/session_01TGLDvt56yRdRHejPFjw9y2"
```

---

### Task 7: `worker/refresh.ts` — config, views and the cron snapshot

**Files:**
- Create: `worker/refresh.ts`
- Test: `worker/refresh.test.ts`

**Interfaces:**
- Consumes: `collect`, `ExtraSources` from `shared/github.ts`; `normalizeConfig`, `DEFAULTS` from `shared/config-core.ts`; `validateViews`, `exactViewRepos`, `viewOwners` from `shared/views-core.ts`; `appTokens` (Task 6).
- Produces:
  - `readConfig(kv: KVNamespace): Promise<Config>` — KV `config` JSON merged over `DEFAULTS`, normalized, `mine` forced false (warning added later by `runRefresh`). Missing key → `DEFAULTS` with `mine: false`.
  - `readViews(kv: KVNamespace): Promise<View[]>` — KV `views`, validated; missing → `[]`.
  - `readData(kv: KVNamespace): Promise<DashboardData | null>` — KV `prs` parsed, or null.
  - `runRefresh(env: Env, deps?: RefreshDeps): Promise<DashboardData>` — builds data with `hosted: true`, `refreshSeconds: cfg.refresh_seconds`, writes KV `prs`, returns it. Throws if `collect` throws (caller decides).
  - `interface RefreshDeps { collect: typeof collect; tokens(cfg: Config, env: Env): TokenSource; now(): number }`.
  - `MemoryKV` test helper exported from `worker/refresh.test.ts` is **not** shared; Task 8 defines its own identical copy in its test.

- [ ] **Step 1: Write the failing tests**

`worker/refresh.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS } from "../shared/config-core.ts";
import type { collect } from "../shared/github.ts";
import type { Env } from "./env.ts";
import { readConfig, readData, readViews, runRefresh } from "./refresh.ts";

export class MemoryKV {
  store = new Map<string, string>();
  writes = 0;
  async get(key: string, type?: "text" | "json" | "stream"): Promise<unknown> {
    const v = this.store.get(key) ?? null;
    if (v === null) return null;
    if (type === "json") return JSON.parse(v);
    if (type === "stream") return new Response(v).body;
    return v;
  }
  async put(key: string, value: string): Promise<void> {
    this.writes++;
    this.store.set(key, value);
  }
}

const env = (kv: MemoryKV): Env => ({ PRDASH: kv as unknown as KVNamespace, ASSETS: { fetch: async () => new Response() } }) as Env;

const okCollect: typeof collect = async (cfg) => ({
  viewer: cfg.viewer_login, rateLimit: null, warnings: ["w1"], repos: [], botReviews: true,
});

const deps = (c: typeof collect) => ({ collect: c, tokens: () => ({ default: async () => "t", forOwner: async () => "t" }), now: () => 1_700_000_000_000 });

test("readConfig merges KV over defaults, normalizes, and forces mine off", async () => {
  const kv = new MemoryKV();
  kv.store.set("config", JSON.stringify({ mine: true, owners: ["O"], allowed_emails: ["A@B.C"], viewer_login: "len" }));
  const cfg = await readConfig(kv as unknown as KVNamespace);
  assert.equal(cfg.mine, false);
  assert.deepEqual(cfg.owners, ["O"]);
  assert.deepEqual(cfg.allowed_emails, ["a@b.c"]);
  assert.equal(cfg.prs_per_repo, DEFAULTS.prs_per_repo);
});

test("readConfig and readViews tolerate missing keys", async () => {
  const kv = new MemoryKV();
  assert.equal((await readConfig(kv as unknown as KVNamespace)).mine, false);
  assert.deepEqual(await readViews(kv as unknown as KVNamespace), []);
  assert.equal(await readData(kv as unknown as KVNamespace), null);
});

test("readViews validates", async () => {
  const kv = new MemoryKV();
  kv.store.set("views", JSON.stringify({ views: [{ id: "x", name: "X", owners: ["o"], repos: [] }] }));
  assert.equal((await readViews(kv as unknown as KVNamespace))[0].id, "x");
  kv.store.set("views", JSON.stringify({ views: [{ id: "all" }] }));
  await assert.rejects(readViews(kv as unknown as KVNamespace));
});

test("runRefresh writes prs once with hosted, generatedAt, fetchMs and the mine warning", async () => {
  const kv = new MemoryKV();
  kv.store.set("config", JSON.stringify({ mine: true, owners: ["o"], viewer_login: "len", refresh_seconds: 300 }));
  kv.store.set("views", JSON.stringify({ views: [{ id: "v", name: "V", owners: ["p"], repos: ["q/r"] }] }));
  let extra: unknown;
  const spy: typeof collect = async (cfg, _t, e) => { extra = e; return okCollect(cfg, _t, e); };
  const data = await runRefresh(env(kv), deps(spy));
  assert.equal(kv.writes, 1);
  assert.equal(data.hosted, true);
  assert.equal(data.generatedAt, new Date(1_700_000_000_000).toISOString());
  assert.equal(typeof data.fetchMs, "number");
  assert.equal(data.refreshSeconds, 300);
  assert.equal(data.viewer, "len");
  assert.deepEqual(extra, { repos: ["q/r"], owners: ["p"] });
  assert.ok(data.warnings.includes("w1"));
  assert.ok(data.warnings.some((w) => w.includes("mine")));
  assert.deepEqual(await readData(kv as unknown as KVNamespace), data);
});

test("runRefresh leaves the old value when collect throws", async () => {
  const kv = new MemoryKV();
  kv.store.set("prs", JSON.stringify({ old: true }));
  const boom: typeof collect = async () => { throw new Error("rate limited"); };
  await assert.rejects(runRefresh(env(kv), deps(boom)), /rate limited/);
  assert.equal(kv.writes, 0);
  assert.deepEqual(JSON.parse(kv.store.get("prs")!), { old: true });
});
```

Run: `node --test worker/refresh.test.ts` → FAIL, cannot find `./refresh.ts`.

- [ ] **Step 2: Write `worker/refresh.ts`**

```ts
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
```

- [ ] **Step 3: Run tests and type check**

Run: `node --test worker/refresh.test.ts && npm run check`
Expected: 5 pass; tsc clean. `KVNamespace.get(key, "json")` is typed by workers-types; the `MemoryKV` cast covers the test.

- [ ] **Step 4: Commit**

```bash
git add worker/refresh.ts worker/refresh.test.ts
git commit -m "feat(worker): cron refresh runs collect() and stores the dashboard data in KV

Claude-Session: https://claude.ai/code/session_01TGLDvt56yRdRHejPFjw9y2"
```

---

### Task 8: `worker/index.ts` — routes, headers, assets, cron

**Files:**
- Create: `worker/index.ts`
- Test: `worker/index.test.ts`

**Interfaces:**
- Consumes: `verifyAccess`, `deny` (Task 5); `readConfig`, `readViews`, `readData`, `runRefresh`, `RefreshDeps` (Task 7); `publicConfig`, `normalizeConfig`, `DashError`; `validateViews`, `exactViewRepos`, `viewOwners`.
- Produces: `export default { fetch(request, env, ctx), scheduled(controller, env, ctx) }` plus `handle(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }, deps?: HandlerDeps): Promise<Response>` for tests. `interface HandlerDeps { access: AccessDeps; refresh: RefreshDeps }`. Routes:
  - any path, no valid Access → 403/500 from `verifyAccess`
  - `GET /api/health` → `{"ok":true}`
  - `GET /api/prs` → KV `prs` or `404 {"error":"No data yet. The cron hasn't run."}`; with `refresh=1` and data older than 60 s (or absent) → `runRefresh` first; if `runRefresh` throws and old data exists → old data with the error appended to `warnings`; if no old data → 502 error JSON
  - `GET /api/views` → `{views}`; `PUT /api/views` → `assertWritable`, validate, KV put, and if a new owner or exact repo appears, `ctx.waitUntil(runRefresh(...))`
  - `GET /api/config` → `publicConfig`; `PUT /api/config` → `assertWritable`, `normalizeConfig(DEFAULTS merged with body)`, reject (400) unless `allowed_emails` contains the caller's email, KV put, `ctx.waitUntil(runRefresh(...))`
  - everything else → `env.ASSETS.fetch(request)` with the security headers added
  - all API responses: `content-type: application/json; charset=utf-8` plus the security headers

- [ ] **Step 1: Write the failing tests**

`worker/index.test.ts` (reuse the local-JWKS setup from Task 5's test and a `MemoryKV` identical to Task 7's):

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { collect } from "../shared/github.ts";
import type { Env } from "./env.ts";
import { handle } from "./index.ts";

class MemoryKV { /* same as worker/refresh.test.ts */ }

const TEAM = "https://team.cloudflareaccess.com";
const AUD = "a".repeat(64);
const HOST = "pr.example.test";
const pair = await generateKeyPair("RS256");
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }] });
const jwt = await new SignJWT({ email: "len@bitfly.org" }).setProtectedHeader({ alg: "RS256", kid: "k1" })
  .setIssuer(TEAM).setAudience(AUD).setIssuedAt().setExpirationTime("10m").sign(pair.privateKey);

let now = 1_700_000_000_000;
let collectCalls = 0;
const fakeCollect: typeof collect = async (cfg) => { collectCalls++; return { viewer: cfg.viewer_login, rateLimit: null, warnings: [], repos: [], botReviews: true }; };
const deps = {
  access: { getJwks: () => jwks },
  refresh: { collect: fakeCollect, tokens: () => ({ default: async () => "t", forOwner: async () => "t" }), now: () => now },
};

function setup(): { env: Env; kv: MemoryKV; waits: Promise<unknown>[] } {
  const kv = new MemoryKV();
  kv.store.set("config", JSON.stringify({ owners: ["o"], allowed_emails: ["len@bitfly.org"], viewer_login: "len" }));
  const env = { PRDASH: kv, ASSETS: { fetch: async (r: Request) => new Response(`asset:${new URL(r.url).pathname}`, { headers: { "content-type": "text/css" } }) },
    ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, HOSTNAME: HOST } as unknown as Env;
  return { env, kv, waits: [] };
}

const ctxOf = (waits: Promise<unknown>[]) => ({ waitUntil: (p: Promise<unknown>) => { waits.push(p); } });

function req(path: string, init: RequestInit & { auth?: boolean } = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("host", HOST);
  if (init.auth !== false) headers.set("cf-access-jwt-assertion", jwt);
  return new Request(`https://${HOST}${path}`, { ...init, headers });
}

test("everything is 403 without Access, assets included", async () => {
  const { env, waits } = setup();
  for (const p of ["/", "/style.css", "/api/prs", "/api/health"]) {
    const res = await handle(req(p, { auth: false }), env, ctxOf(waits), deps);
    assert.equal(res.status, 403, p);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
  }
});

test("assets pass through with security headers", async () => {
  const { env, waits } = setup();
  const res = await handle(req("/style.css"), env, ctxOf(waits), deps);
  assert.equal(await res.text(), "asset:/style.css");
  assert.ok(res.headers.get("content-security-policy")?.startsWith("default-src 'self'"));
  assert.equal(res.headers.get("x-robots-tag"), "noindex");
  assert.equal(res.headers.get("cache-control"), "private, no-store");
});

test("/api/health and /api/prs before the first cron run", async () => {
  const { env, waits } = setup();
  assert.deepEqual(await (await handle(req("/api/health"), env, ctxOf(waits), deps)).json(), { ok: true });
  const res = await handle(req("/api/prs"), env, ctxOf(waits), deps);
  assert.equal(res.status, 404);
  assert.match(((await res.json()) as { error: string }).error, /cron/);
});

test("/api/prs serves KV; refresh=1 reruns only when older than 60 s", async () => {
  const { env, kv, waits } = setup();
  collectCalls = 0;
  now = 1_700_000_000_000;
  const first = await handle(req("/api/prs?refresh=1"), env, ctxOf(waits), deps);
  assert.equal(first.status, 200);
  assert.equal(collectCalls, 1);
  assert.equal(kv.writes, 1);
  now += 30_000;
  await handle(req("/api/prs?refresh=1"), env, ctxOf(waits), deps);
  assert.equal(collectCalls, 1, "30 s later: served from KV");
  now += 31_000;
  await handle(req("/api/prs?refresh=1"), env, ctxOf(waits), deps);
  assert.equal(collectCalls, 2, "61 s later: refreshed");
  const plain = await handle(req("/api/prs"), env, ctxOf(waits), deps);
  assert.equal(((await plain.json()) as { hosted: boolean }).hosted, true);
  assert.equal(collectCalls, 2);
});

test("refresh=1 with a failing collect keeps old data and reports the error", async () => {
  const { env, kv, waits } = setup();
  kv.store.set("prs", JSON.stringify({ repos: [], warnings: [], generatedAt: new Date(0).toISOString(), hosted: true }));
  const failing = { ...deps, refresh: { ...deps.refresh, collect: (async () => { throw new Error("GitHub down"); }) as typeof collect } };
  const res = await handle(req("/api/prs?refresh=1"), env, ctxOf(waits), failing);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { warnings: string[] };
  assert.ok(body.warnings.some((w) => w.includes("GitHub down")));
});

test("views round-trip; a new owner triggers a background refresh; writes need the CSRF headers", async () => {
  const { env, kv, waits } = setup();
  collectCalls = 0;
  const bad = await handle(req("/api/views", { method: "PUT", body: "{}" }), env, ctxOf(waits), deps);
  assert.equal(bad.status, 403);
  const put = await handle(req("/api/views", {
    method: "PUT", body: JSON.stringify({ views: [{ id: "v", name: "V", owners: ["newowner"], repos: [] }] }),
    headers: { "content-type": "application/json", "x-pr-dash": "1", origin: `https://${HOST}` },
  }), env, ctxOf(waits), deps);
  assert.equal(put.status, 200);
  await Promise.all(waits);
  assert.equal(collectCalls, 1, "new owner → refresh");
  assert.equal(((await (await handle(req("/api/views"), env, ctxOf(waits), deps)).json()) as { views: unknown[] }).views.length, 1);
  const wrongOrigin = await handle(req("/api/views", {
    method: "PUT", body: JSON.stringify({ views: [] }),
    headers: { "content-type": "application/json", "x-pr-dash": "1", origin: "https://evil.example" },
  }), env, ctxOf(waits), deps);
  assert.equal(wrongOrigin.status, 403);
});

test("GET /api/config strips secrets; PUT refuses to drop the caller's email", async () => {
  const { env, waits } = setup();
  const got = (await (await handle(req("/api/config"), env, ctxOf(waits), deps)).json()) as Record<string, unknown>;
  assert.equal("tokens" in got, false);
  assert.equal("allowed_emails" in got, false);
  assert.deepEqual(got.owners, ["o"]);
  const headers = { "content-type": "application/json", "x-pr-dash": "1", origin: `https://${HOST}` };
  const lockout = await handle(req("/api/config", { method: "PUT", body: JSON.stringify({ owners: ["o"], allowed_emails: ["other@x.y"] }), headers }), env, ctxOf(waits), deps);
  assert.equal(lockout.status, 400);
  const ok = await handle(req("/api/config", { method: "PUT", body: JSON.stringify({ owners: ["o", "p"], allowed_emails: ["len@bitfly.org"] }), headers }), env, ctxOf(waits), deps);
  assert.equal(ok.status, 200);
  await Promise.all(waits);
  const after = (await (await handle(req("/api/config"), env, ctxOf(waits), deps)).json()) as Record<string, unknown>;
  assert.deepEqual(after.owners, ["o", "p"]);
});
```

Run: `node --test worker/index.test.ts` → FAIL, cannot find `./index.ts`.

- [ ] **Step 2: Write `worker/index.ts`**

```ts
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
    if (added) ctx.waitUntil(run().catch(() => undefined));
    return json(200, { views });
  }

  if (url.pathname === "/api/config" && request.method === "GET") return json(200, publicConfig(await readConfig(kv)));
  if (url.pathname === "/api/config" && request.method === "PUT") {
    assertWritable(request);
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new DashError("Config must be a JSON object.", null, 400);
    const cfg: Config = normalizeConfig({ ...DEFAULTS, ...(body as Partial<Config>) });
    if (!cfg.allowed_emails.includes(email)) {
      throw new DashError("allowed_emails must include your own email, or you would lock yourself out.", null, 400);
    }
    await kv.put("config", JSON.stringify(cfg));
    ctx.waitUntil(run().catch(() => undefined));
    return json(200, publicConfig(cfg));
  }

  throw new DashError("Not found", null, 404);
}

export async function handle(
  request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }, deps: HandlerDeps = {},
): Promise<Response> {
  // Read the allowlist before verifying, so one KV read serves both the gate and the routes.
  const cfg = await readConfig(env.PRDASH).catch(() => ({ ...DEFAULTS, allowed_emails: [] as string[] }));
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
```

`readConfig` in `handle` is a `catch`-guarded call because a malformed KV config must not turn into a 500 that hides the Access result; it falls back to an empty allowlist (everyone 403) which is the safe failure.

- [ ] **Step 3: Run tests and type check**

Run: `npm test && npm run check`
Expected: all pass (65 + 7 access + 6 app + 5 refresh + 7 index = 90); both tsc runs clean. `ExecutionContext` and `ScheduledController` come from workers-types.

- [ ] **Step 4: Commit**

```bash
git add worker/index.ts worker/index.test.ts
git commit -m "feat(worker): fetch and scheduled handlers — Access gate, KV-backed API, assets, cron

Claude-Session: https://claude.ai/code/session_01TGLDvt56yRdRHejPFjw9y2"
```

---

### Task 9: `wrangler.json`, render/check/seed/probe scripts

**Files:**
- Create: `wrangler.json`, `scripts/render-wrangler.mjs`, `scripts/check-config.mjs`, `scripts/check-access.mjs`, `scripts/seed-kv.mjs`, `scripts/wrangler.test.mjs`, `scripts/check-access.test.mjs`

**Interfaces:**
- Produces:
  - `wrangler.json` (committed, placeholders).
  - `render-wrangler.mjs`: `render(template, values)` returns the filled object; CLI reads env (`CF_ACCOUNT_ID`, `PRDASH_HOSTNAME`, `PRDASH_KV_ID`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`), or with `--dev` uses dummies (`0`×32, `localhost`, `dev`, `https://dev.cloudflareaccess.com`, and **omits** `ACCESS_AUD` so the dev bypass works), writes `wrangler.deploy.json`.
  - `check-config.mjs`: `validate(config)` throws on `workers_dev !== false`, `preview_urls !== false`, route count ≠ 1, missing `assets.run_worker_first`, `triggers.crons` ≠ `["*/5 * * * *"]`, any string containing `__`, `account_id` not 32 hex. CLI validates `wrangler.deploy.json`.
  - `check-access.mjs`: `accessVerdict({status, location}, {teamDomain, aud})` → `ok` when 302 to `${teamDomain}/cdn-cgi/access/login/` and `kid=<aud>` is in the query; `retry` on 0/404/5xx; else `fail`. CLI probes `/`, `/app.js`, `/api/health`, `/api/prs`.
  - `seed-kv.mjs`: validates `config.hosted.json` with `normalizeConfig` (requires non-empty `allowed_emails`) and the optional views file with `validateViews`, then `wrangler kv key put --remote --config wrangler.deploy.json --binding PRDASH <key> --path <tmpfile>`.

- [ ] **Step 1: `wrangler.json`**

```json
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "pr-dash",
  "main": "worker/index.ts",
  "account_id": "__ACCOUNT_ID__",
  "compatibility_date": "2026-10-04",
  "workers_dev": false,
  "preview_urls": false,
  "assets": { "directory": "./dist", "binding": "ASSETS", "run_worker_first": true },
  "kv_namespaces": [{ "binding": "PRDASH", "id": "__KV_ID__" }],
  "triggers": { "crons": ["*/5 * * * *"] },
  "routes": [{ "pattern": "__HOSTNAME__", "custom_domain": true }],
  "vars": {
    "HOSTNAME": "__HOSTNAME__",
    "ACCESS_TEAM_DOMAIN": "__ACCESS_TEAM_DOMAIN__",
    "ACCESS_AUD": "__ACCESS_AUD__"
  }
}
```

- [ ] **Step 2: Failing tests**

`scripts/wrangler.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validate } from "./check-config.mjs";
import { DEV_VALUES, render } from "./render-wrangler.mjs";

const template = JSON.parse(await readFile(new URL("../wrangler.json", import.meta.url), "utf8"));
const values = { CF_ACCOUNT_ID: "0".repeat(32), PRDASH_HOSTNAME: "pr.example.test", PRDASH_KV_ID: "abc123", ACCESS_TEAM_DOMAIN: "https://t.cloudflareaccess.com", ACCESS_AUD: "f".repeat(64) };

test("the committed template has only placeholders and fails validation as is", () => {
  assert.throws(() => validate(template), /placeholder/);
});

test("render fills every placeholder and the result validates", () => {
  const out = render(template, values);
  assert.equal(out.account_id, values.CF_ACCOUNT_ID);
  assert.equal(out.routes[0].pattern, "pr.example.test");
  assert.equal(out.vars.ACCESS_AUD, values.ACCESS_AUD);
  assert.equal(out.kv_namespaces[0].id, "abc123");
  assert.doesNotThrow(() => validate(out));
  assert.ok(!JSON.stringify(out).includes("__"));
});

test("render refuses a missing value", () => {
  assert.throws(() => render(template, { ...values, ACCESS_AUD: "" }), /ACCESS_AUD/);
});

test("dev values omit ACCESS_AUD so the local bypass can work, and still validate otherwise", () => {
  const out = render(template, DEV_VALUES);
  assert.equal(out.vars.ACCESS_AUD, undefined);
  assert.equal(out.routes[0].pattern, "localhost");
  assert.doesNotThrow(() => validate(out, { dev: true }));
});

test("validate rejects the dangerous settings", () => {
  const good = render(template, values);
  assert.throws(() => validate({ ...good, workers_dev: true }), /workers_dev/);
  assert.throws(() => validate({ ...good, preview_urls: true }), /preview_urls/);
  assert.throws(() => validate({ ...good, routes: [] }), /custom_domain/);
  assert.throws(() => validate({ ...good, assets: { ...good.assets, run_worker_first: false } }), /run_worker_first/);
  assert.throws(() => validate({ ...good, triggers: { crons: ["* * * * *"] } }), /cron/);
  assert.throws(() => validate({ ...good, account_id: "nope" }), /account_id/);
});
```

`scripts/check-access.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { accessVerdict } from "./check-access.mjs";

const expect = { teamDomain: "https://t.cloudflareaccess.com", aud: "f".repeat(64) };
const login = `https://t.cloudflareaccess.com/cdn-cgi/access/login/pr.example.test?kid=${"f".repeat(64)}&redirect_url=%2F`;

test("302 to this application's login is ok", () => {
  assert.deepEqual(accessVerdict({ status: 302, location: login }, expect), { state: "ok" });
});

test("redirect to another application or team fails", () => {
  assert.equal(accessVerdict({ status: 302, location: login.replace("f".repeat(64), "e".repeat(64)) }, expect).state, "fail");
  assert.equal(accessVerdict({ status: 302, location: login.replace("t.cloudflareaccess", "evil.cloudflareaccess") }, expect).state, "fail");
  assert.equal(accessVerdict({ status: 302, location: "https://t.cloudflareaccess.com.evil.example/cdn-cgi/access/login/x?kid=" + "f".repeat(64) }, expect).state, "fail");
});

test("200 fails; 404, 5xx and network errors retry", () => {
  assert.equal(accessVerdict({ status: 200, location: null }, expect).state, "fail");
  assert.equal(accessVerdict({ status: 403, location: null }, expect).state, "fail");
  for (const status of [0, 404, 500, 503]) assert.equal(accessVerdict({ status, location: null }, expect).state, "retry");
});
```

Run: `node --test scripts/wrangler.test.mjs scripts/check-access.test.mjs` → FAIL, modules missing.

- [ ] **Step 3: Write the scripts**

`scripts/render-wrangler.mjs`:

```js
// Fills the placeholders in the committed wrangler.json from the environment and writes
// wrangler.deploy.json (gitignored). The repo is public, so account id, hostname, KV id,
// Access team domain and AUD never live in git.
//
//   node scripts/render-wrangler.mjs          # from env: CF_ACCOUNT_ID PRDASH_HOSTNAME PRDASH_KV_ID ACCESS_TEAM_DOMAIN ACCESS_AUD
//   node scripts/render-wrangler.mjs --dev    # dummies for `wrangler dev`; ACCESS_AUD omitted so DEV_ACCESS_EMAIL works
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const PLACEHOLDERS = {
  __ACCOUNT_ID__: "CF_ACCOUNT_ID",
  __HOSTNAME__: "PRDASH_HOSTNAME",
  __KV_ID__: "PRDASH_KV_ID",
  __ACCESS_TEAM_DOMAIN__: "ACCESS_TEAM_DOMAIN",
  __ACCESS_AUD__: "ACCESS_AUD",
};

export const DEV_VALUES = {
  CF_ACCOUNT_ID: "0".repeat(32),
  PRDASH_HOSTNAME: "localhost",
  PRDASH_KV_ID: "dev",
  ACCESS_TEAM_DOMAIN: "https://dev.cloudflareaccess.com",
  ACCESS_AUD: null,
};

export function render(template, values) {
  const text = JSON.stringify(template);
  let out = text;
  for (const [placeholder, name] of Object.entries(PLACEHOLDERS)) {
    const value = values[name];
    if (value === null) continue; // dev: leave the placeholder, remove the key below
    if (!value) throw new Error(`${name} is not set (needed for ${placeholder}).`);
    out = out.split(placeholder).join(value);
  }
  const config = JSON.parse(out);
  if (values.ACCESS_AUD === null) delete config.vars.ACCESS_AUD;
  return config;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const root = new URL("..", import.meta.url);
  const template = JSON.parse(await readFile(new URL("wrangler.json", root), "utf8"));
  const dev = process.argv.includes("--dev");
  const values = dev ? DEV_VALUES : Object.fromEntries(Object.values(PLACEHOLDERS).map((n) => [n, process.env[n]]));
  const config = render(template, values);
  await writeFile(new URL("wrangler.deploy.json", root), JSON.stringify(config, null, 2) + "\n");
  console.log(`Wrote wrangler.deploy.json${dev ? " (dev values)" : ""}.`);
}
```

`scripts/check-config.mjs`:

```js
// Refuses to deploy a Worker that could be reachable outside the Access sign-in or that
// still carries a placeholder.
//
//   node scripts/check-config.mjs [wrangler.deploy.json]
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
export const CRON = "*/5 * * * *";

export function validate(config, { dev = false } = {}) {
  const text = JSON.stringify(config);
  if (text.includes("__")) throw new Error("wrangler config still contains a placeholder (__NAME__). Run scripts/render-wrangler.mjs.");
  if (!ACCOUNT_ID.test(config.account_id ?? "")) throw new Error("account_id must be a 32-character lowercase hex id.");
  if (config.workers_dev !== false) throw new Error("workers_dev must be false.");
  if (config.preview_urls !== false) throw new Error("preview_urls must be false.");
  const domains = (config.routes ?? []).filter((r) => r.custom_domain).map((r) => r.pattern);
  if (domains.length !== 1) throw new Error(`expected exactly one custom_domain route, found ${domains.length}.`);
  if (!config.assets?.directory || config.assets.run_worker_first !== true) throw new Error("assets.run_worker_first must be true.");
  if (JSON.stringify(config.triggers?.crons) !== JSON.stringify([CRON])) throw new Error(`triggers.crons must be ["${CRON}"].`);
  if (!config.kv_namespaces?.some((k) => k.binding === "PRDASH")) throw new Error("a PRDASH kv_namespaces binding is required.");
  if (!dev) {
    for (const name of ["HOSTNAME", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD"]) {
      if (!config.vars?.[name]) throw new Error(`vars.${name} is required.`);
    }
    if (config.vars.HOSTNAME !== domains[0]) throw new Error("vars.HOSTNAME must equal the custom_domain route.");
  }
  return { name: config.name, hostname: domains[0], teamDomain: config.vars?.ACCESS_TEAM_DOMAIN, aud: config.vars?.ACCESS_AUD };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const file = process.argv[2] ?? "wrangler.deploy.json";
  try {
    const info = validate(JSON.parse(await readFile(file, "utf8")));
    console.log(`${file}: ok (${info.name} at ${info.hostname}).`);
  } catch (e) {
    console.error(`::error::${file}: ${e.message}`);
    process.exit(1);
  }
}
```

`scripts/check-access.mjs`:

```js
// After a deploy, a signed-out request must redirect to THIS Access application's login (the
// team domain and the application AUD in `kid`). Anything else means the site may be public, so
// the workflow fails loudly. A new custom domain can answer 404 or 5xx briefly; those retry.
//
//   ACCESS_TEAM_DOMAIN=https://team.cloudflareaccess.com ACCESS_AUD=... node scripts/check-access.mjs https://pr.example.test
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ATTEMPTS = 12;
const WAIT_MS = 10_000;
const PATHS = ["/", "/app.js", "/api/health", "/api/prs"];

export function accessVerdict({ status, location }, { teamDomain, aud }) {
  if (status === 302 && typeof location === "string") {
    let url;
    try { url = new URL(location); } catch { return { state: "fail", reason: `redirected to an invalid URL ${location}` }; }
    const expected = new URL(teamDomain);
    if (url.origin === expected.origin && url.pathname.startsWith("/cdn-cgi/access/login/") && url.searchParams.get("kid") === aud) {
      return { state: "ok" };
    }
    return { state: "fail", reason: `redirected to ${location}, not this application's Access login` };
  }
  if (status === 0 || status === 404 || status >= 500) return { state: "retry", reason: `answered ${status || "with a network error"}` };
  return { state: "fail", reason: `answered ${status}${location ? ` with a redirect to ${location}` : ""}` };
}

async function probe(url, expect) {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    return accessVerdict({ status: res.status, location: res.headers.get("location") }, expect);
  } catch {
    return accessVerdict({ status: 0, location: null }, expect);
  }
}

async function main(base) {
  const expect = { teamDomain: process.env.ACCESS_TEAM_DOMAIN, aud: process.env.ACCESS_AUD };
  if (!expect.teamDomain || !expect.aud) {
    console.error("::error::ACCESS_TEAM_DOMAIN and ACCESS_AUD must be set.");
    process.exit(1);
  }
  let failed = false;
  for (const path of PATHS) {
    const url = new URL(path, base).toString();
    let verdict;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      verdict = await probe(url, expect);
      if (verdict.state !== "retry") break;
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, WAIT_MS));
    }
    if (verdict.state === "ok") console.log(`${url} sends signed-out visitors to the Access login.`);
    else { failed = true; console.error(`::error::${url} ${verdict.reason}. The site may be reachable without sign-in.`); }
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main(process.argv[2] ?? `https://${process.env.PRDASH_HOSTNAME}`);
}
```

`scripts/seed-kv.mjs`:

```js
// Seeds the hosted KV namespace from gitignored local files, after validating them with the
// same code the Worker uses. Needs a rendered wrangler.deploy.json and a wrangler login.
//
//   node scripts/seed-kv.mjs config.hosted.json [views.json]
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULTS, normalizeConfig } from "../shared/config-core.ts";
import { validateViews } from "../shared/views-core.ts";

const [configFile, viewsFile] = process.argv.slice(2);
if (!configFile) {
  console.error("usage: node scripts/seed-kv.mjs config.hosted.json [views.json]");
  process.exit(1);
}

const cfg = normalizeConfig({ ...DEFAULTS, ...JSON.parse(await readFile(configFile, "utf8")) });
if (!cfg.allowed_emails.length) throw new Error("config.hosted.json needs at least one allowed_emails entry.");
if (!cfg.owners.length && !cfg.repos.length) throw new Error("config.hosted.json needs owners or repos (mine is ignored hosted).");
for (const [owner, spec] of Object.entries(cfg.tokens)) {
  if (!/^(app:\d+|secret:[A-Z0-9_]+)$/.test(spec)) throw new Error(`tokens.${owner} must be app:<id> or secret:NAME, got ${spec}.`);
}

const dir = await mkdtemp(path.join(tmpdir(), "prdash-seed-"));
const puts = [["config", cfg]];
if (viewsFile) puts.push(["views", { views: validateViews(JSON.parse(await readFile(viewsFile, "utf8"))) }]);
for (const [key, value] of puts) {
  const file = path.join(dir, `${key}.json`);
  await writeFile(file, JSON.stringify(value));
  const r = spawnSync("npx", ["--no-install", "wrangler", "kv", "key", "put", "--remote", "--config", "wrangler.deploy.json", "--binding", "PRDASH", key, "--path", file], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
console.log(`Seeded ${puts.map(([k]) => k).join(", ")}.`);
```

Note `seed-kv.mjs` imports `.ts` files; Node 22.18+ strips types on import from `.mjs` too. Run it with `node scripts/seed-kv.mjs` on Node ≥22.18.

- [ ] **Step 4: Run tests and a dev render**

Run: `npm test && node scripts/render-wrangler.mjs --dev && node scripts/check-config.mjs wrangler.deploy.json`
Expected: all tests pass (90 + 5 + 3 = 98); the render writes `wrangler.deploy.json`; check-config **fails** on the dev file with `vars.ACCESS_AUD is required` — expected, since `--dev` omits it; `validate(..., { dev: true })` is the test path. Confirm the CLI message says exactly that, then delete the file: `rm wrangler.deploy.json`.

- [ ] **Step 5: Commit**

```bash
git add wrangler.json scripts/render-wrangler.mjs scripts/check-config.mjs scripts/check-access.mjs scripts/seed-kv.mjs scripts/wrangler.test.mjs scripts/check-access.test.mjs
git commit -m "build: wrangler.json with placeholders, render/check/seed scripts, Access redirect probe

Claude-Session: https://claude.ai/code/session_01TGLDvt56yRdRHejPFjw9y2"
```

---

### Task 10: Deploy workflow, `wrangler dev` smoke test, docs

**Files:**
- Create: `.github/workflows/deploy.yml`
- Modify: `README.md`, `docs/specs/watcher-reviews.md`, `server.ts` (serve `/shared/*.ts`? — **not needed**: the browser never imports `shared/` at runtime; skip)

- [ ] **Step 1: `deploy.yml`**

```yaml
name: Deploy

# Every push runs the checks. Only main deploys, through the `production` environment, which
# holds the Cloudflare token and the placeholder values. The Worker has no preview addresses,
# because they would sit outside the Access sign-in.
on:
  push:
    branches: ['**']
  workflow_dispatch:
  schedule:
    - cron: '17 * * * *'   # hourly redirect probe, no deploy

permissions:
  contents: read

jobs:
  check:
    if: github.event_name != 'schedule'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run check
      - run: npm test
      - run: npm run build

  deploy:
    needs: check
    if: github.event_name != 'schedule' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    environment: production
    concurrency:
      group: deploy-production
      cancel-in-progress: false
    env:
      CF_ACCOUNT_ID: ${{ vars.CF_ACCOUNT_ID }}
      PRDASH_HOSTNAME: ${{ vars.PRDASH_HOSTNAME }}
      PRDASH_KV_ID: ${{ vars.PRDASH_KV_ID }}
      ACCESS_TEAM_DOMAIN: ${{ vars.ACCESS_TEAM_DOMAIN }}
      ACCESS_AUD: ${{ vars.ACCESS_AUD }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: node scripts/render-wrangler.mjs
      - run: node scripts/check-config.mjs wrangler.deploy.json
      - name: Deploy
        id: deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
        run: npx --no-install wrangler deploy --config wrangler.deploy.json
      # Runs whenever the deploy step ran, even if it failed after the version went live.
      - name: Check that the Access sign-in guards the site
        if: ${{ !cancelled() && steps.deploy.outcome != 'skipped' }}
        run: node scripts/check-access.mjs "https://$PRDASH_HOSTNAME"

  probe:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    environment: production
    env:
      PRDASH_HOSTNAME: ${{ vars.PRDASH_HOSTNAME }}
      ACCESS_TEAM_DOMAIN: ${{ vars.ACCESS_TEAM_DOMAIN }}
      ACCESS_AUD: ${{ vars.ACCESS_AUD }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 22
      - run: node scripts/check-access.mjs "https://$PRDASH_HOSTNAME"
```

Delete `.github/workflows/check.yml`; `deploy.yml`'s `check` job replaces it. (The `claude.yml` workflow stays.)

- [ ] **Step 2: `wrangler dev` smoke test**

```bash
printf 'DEV_ACCESS_EMAIL=len@bitfly.org\nGH_TOKEN=%s\n' "$(gh auth token)" > .dev.vars
node scripts/render-wrangler.mjs --dev && npm run build
npx --no-install wrangler kv key put --local --config wrangler.deploy.json --binding PRDASH config \
  '{"owners":["lab3"],"allowed_emails":["len@bitfly.org"],"viewer_login":"'"$(gh api user --jq .login)"'","tokens":{"default":"secret:GH_TOKEN"}}'
npx --no-install wrangler dev --config wrangler.deploy.json --port 8794 --test-scheduled &
sleep 6
curl -s -o /dev/null -w 'health %{http_code}\n' http://localhost:8794/api/health
curl -s 'http://localhost:8794/api/prs?refresh=1' | python3 -c 'import json,sys; d=json.load(sys.stdin); print("hosted", d["hosted"], "repos", len(d["repos"]), "warnings", d["warnings"][:2])'
curl -s -o /dev/null -w 'asset %{http_code}\n' http://localhost:8794/style.css
curl -s -o /dev/null -w 'no-host-bypass %{http_code}\n' -H 'Host: pr-dash.example.test' http://localhost:8794/
curl -s 'http://localhost:8794/__scheduled?cron=*/5+*+*+*+*' -o /dev/null -w 'cron %{http_code}\n'
kill %1
rm .dev.vars wrangler.deploy.json
```

Expected: `health 200`; `hosted True repos <n> warnings [...]` (lab3's repos via your `gh` token through the `secret:GH_TOKEN` spec); `asset 200`; `no-host-bypass 403` (the dev bypass only applies to a local Host); `cron 200` (wrangler's `--test-scheduled` endpoint runs the `scheduled` handler; afterwards `curl -s localhost:8794/api/prs` must show a fresh `generatedAt`). Record the output in the report. If `wrangler dev` needs a Cloudflare login even for local mode, run `npx wrangler login` once (Len's machine already has a Wrangler profile) — report if that blocks you.

- [ ] **Step 3: README**

Add a section after "## Configure":

````markdown
## Hosted on Cloudflare

pr-dash can also run as a private site on Cloudflare Workers (free plan), behind Cloudflare Access, so it's reachable from any device without a laptop running `node server.ts`. A Worker cron rebuilds the dashboard data every 5 minutes and stores it in KV; the page loads from that. Design: `docs/specs/cloudflare-hosting.md`.

What's in the repo is generic. The hostname, Cloudflare account, KV namespace, Access team and AUD come from the GitHub `production` environment at deploy time, and the org list, allowed emails and GitHub App installation ids live only in KV.

One-time setup (your machine):
1. Create a read-only GitHub App (Metadata, Pull requests, Checks, Commit statuses: read) and install it on each org. Note the App id and each installation id.
2. `npx wrangler kv namespace create PRDASH`; note the id.
3. `npx wrangler secret put GH_APP_ID` and `npx wrangler secret put GH_APP_PRIVATE_KEY` (PKCS#8) against the rendered config: `node scripts/render-wrangler.mjs` first with the five variables exported, then `--config wrangler.deploy.json`.
4. Create the Access application for the hostname and note its AUD.
5. Create a Cloudflare API token scoped to Workers Scripts: Edit and Workers Routes: Edit for the zone. Put it in the GitHub `production` environment as `CLOUDFLARE_API_TOKEN`, with variables `CF_ACCOUNT_ID`, `PRDASH_HOSTNAME`, `PRDASH_KV_ID`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`.
6. Write `config.hosted.json` (gitignored): `owners`, `allowed_emails`, `viewer_login`, `tokens` as `{"my-org": "app:<installation id>"}`, and run `node scripts/seed-kv.mjs config.hosted.json views.json`.
7. Push to `main`. The deploy job renders the config, deploys, and checks that a signed-out request redirects to your Access login. Then sign in and confirm the page.

Local development of the Worker: `npm run dev:worker` with a `.dev.vars` containing `DEV_ACCESS_EMAIL=you@example.com` and `GH_TOKEN=$(gh auth token)`, and a local KV `config` whose `tokens` is `{"default": "secret:GH_TOKEN"}`.

Hosted differences: `mine` is ignored (list orgs in `owners`); `viewer_login` fills "yours" and "needs your review"; the footer says "cron not running" if the data is older than 10 minutes; `PUT /api/config` is available behind Access and refuses a config that would drop your own email.
````

Update the "Run it" paragraph about `npm install`: "`npm ci` installs the pinned dev dependencies (TypeScript, wrangler, esbuild)". Update the project layout block with `worker/`, `shared/`, `scripts/`, `wrangler.json`, `.github/workflows/deploy.yml` lines. Update the API table: `GET /api/health`, `GET /api/config`, `PUT /api/config` (hosted).

`docs/specs/watcher-reviews.md`, under "Data" item 3, append: "Hosted on Cloudflare, the 120-second cache is the KV value the Worker cron rewrites every 5 minutes (see `cloudflare-hosting.md`)."

- [ ] **Step 4: Final verification**

Run: `npm ci && npm run check && npm test && npm run build`
Expected: clean install from the lockfile; both tsc configs clean; 98 tests pass; `dist/` built. `node server.ts --port 8795` still serves the dashboard with Watcher data (`curl -s localhost:8795/api/prs | head -c 200`).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy.yml README.md docs/specs/watcher-reviews.md
git rm .github/workflows/check.yml
git commit -m "ci: deploy workflow with main-only production deploy and hourly Access probe; hosted docs

Claude-Session: https://claude.ai/code/session_01TGLDvt56yRdRHejPFjw9y2"
```

---

## Self-review notes

- **Spec coverage.** Target architecture and `wrangler.json`: Tasks 4, 8, 9. API routes: Tasks 3 (local), 8 (Worker). Cron and refresh (60 s minimum, partial runs, `viewer`, `mine`, budget): Tasks 2, 7, 8. Access: Task 5. Identity (`viewer_login`): Tasks 1, 2, 7. Secrets and variables: Tasks 6, 9, 10. Headers/CSP: Tasks 4 (`_headers`), 8 (API). Config and views in KV, seeding: Tasks 7, 9. GitHub App tokens: Task 6. Deploy pipeline and redirect probe: Tasks 9, 10. Migration steps 1–2 are this plan; step 3 (Len's setup) and step 4 (first deploy) follow it. Testing list: every bullet maps to a task's tests except "same output in both modes", which is covered by `collect()` being one function with an injected `TokenSource` and the stubbed-fetch tests in Task 2.
- **Deviations from the spec text.** The spec's `scripts/check-config.mjs` reads `wrangler.json`; here it reads the rendered `wrangler.deploy.json` because the committed file is placeholders by design. The spec lists `worker/kv.ts`; its contents (`readConfig`, `readViews`, `readData`) live in `worker/refresh.ts` to avoid a one-screen file. The spec's "serve `/shared/*.ts` locally" is unnecessary because the browser never imports `shared/` at runtime, so it is dropped.
- **Type consistency.** `TokenSource` (Task 1) is what `collect` (Task 2), `appTokens` (Task 6) and `RefreshDeps.tokens` (Task 7) use. `Env` (Task 5) is shared by Tasks 6–8. `AccessDeps`/`RefreshDeps` are the only injection points and `HandlerDeps` (Task 8) carries both. `DashboardData.hosted` (Task 3) is set in Task 7 and read in Task 3's footer. `publicConfig` (Task 3) is used in Task 8.
- **Review Focus.** 1 → Task 5 "missing ACCESS_TEAM_DOMAIN or ACCESS_AUD is 500" and Task 9 placeholder/`vars` checks. 2 → Task 5 "wrong audience, wrong issuer, expired, wrong key". 3 → Task 8 "PUT refuses to drop the caller's email". 4 → Task 7 "leaves the old value when collect throws" and Task 8 "failing collect keeps old data". 5 → Task 4 build test.
