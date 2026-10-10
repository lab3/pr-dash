# pr-dash: hosting on Cloudflare Workers (free plan), spec

Status: spec v4, Oct 8. All questions answered by Len. Watcher reviews (`docs/specs/watcher-reviews.md`) have shipped, so this spec builds on that code. No hosting code written yet.

v4 replaces v3's "store GitHub's raw pages, shape in the browser" design. Measured on Len's real data (63 repos, 18 open PRs), the raw GraphQL for all four orgs is 35 KB and parses in 0.2 ms, so the Worker can do the whole job the local server does today. The browser code stays as it is.

## Goal
Run pr-dash as a private site at `pr-dash.workarea.io` on Cloudflare's **Workers Free plan**, warm when Len opens it from any device, without a laptop running `node server.ts`. Keep the local app working.

## Decisions (Len, Oct 8)
1. **Hostname and account:** `pr-dash.workarea.io` on Len's "bucchino" Cloudflare account. The `workarea.io` zone is on that account (it serves `bedrock.workarea.io` and `garden.workarea.io`); the name is unused. A dedicated Access application covers the hostname.
2. **Zero Trust:** the account's existing Zero Trust Free team, Google identity provider for `bitfly.org`. Len signs in as `len@bitfly.org`. The Access application can attach the reusable "bitfly.org Google users" policy bedrock and garden use; the Worker also pins the exact email from config.
3. **Plan:** Workers Free. "If we outgrow free" lists the symptoms and the fallback.
4. **GitHub auth:** a new read-only GitHub App owned by lab3 ("pr-dash reader"), installed on all repositories in Ascera-life, Carecise, Workarea-io and lab3.
5. **CI probe:** redirect-only. GitHub Actions checks that a signed-out request redirects to this Access application. No service token. Len confirms the signed-in page in a browser after a deploy.
6. **Refresh:** a Worker cron every 5 minutes, 24/7, builds the dashboard data and stores it in KV, so the page is warm on open.
7. **Write actions:** none in v1. Rows link to GitHub.
8. **Local mode:** stays first-class. Same browser code, same `/api/prs` shape.
9. **Repo hygiene:** `lab3/pr-dash` is public. Committed `wrangler.json` and this spec carry placeholders only. Account id, KV namespace id, Access team domain and AUD come from GitHub `production` environment variables at deploy time. Org inventory, emails and installation ids live only in KV.
10. **Storage: KV.** Config, views and the dashboard data.

## Verified free-plan limits (Oct 8, 2026)
| Limit | Free | Source |
|---|---|---|
| Worker CPU per request or cron run | **10 ms** (waiting on `fetch`, KV and so on doesn't count) | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Subrequests per invocation | **50** | same |
| Requests | 100,000/day | same |
| Cron Triggers | 5 per account, **UTC only**, 15 min wall time | same, plus [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) |
| KV | 100,000 reads/day, **1,000 writes/day**, 1 write/sec per key, values up to 25 MiB | [KV limits](https://developers.cloudflare.com/kv/platform/limits/) |
| Cache API | **Not available for Workers fronted by Cloudflare Access** | [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) |

**What follows:** KV holds the data (no Cache API behind Access). A 5-minute cron is 288 runs and 288 KV writes a day; with Refresh clicks and config edits that stays under 1,000. **2 minutes (720 writes) is the floor; 1 minute (1,440) breaks the limit.** CPU is not a concern at the measured data size (next section).

## Measured, Oct 8
| | |
|---|---|
| Raw GraphQL, all four orgs, 5 owner pages | 35 KB, `JSON.parse` 0.2 ms total |
| Shaped `/api/prs` (what the browser consumes) | 49 KB |
| Open PRs / with a Watcher review | 18 / 2 |
| Rate-limit cost per owner page | 50 points, regardless of how much comes back |

So one cron run parses about 35 KB, shapes 18 PRs, runs one Watcher batch, and stringifies 49 KB. That is under 1 ms of CPU on a laptop; allow 3× for the Worker. The expensive step is minting GitHub App tokens (one RS256 signature per org on a cold isolate, about 1 ms each). Budget: 2 to 6 ms worst case, under the 10 ms cap with headroom for the data to grow tenfold. Step 2 of the migration confirms this with Workers Logs `cpuTime`.

## GitHub rate limit
GitHub prices a GraphQL query by what it *could* return (`first:` and `last:` arguments), not by what it does return, at roughly 1 point per 100 nodes. Each token has 5,000 points an hour; with the App, each org installation has its own 5,000.

| | Points |
|---|---|
| One owner page (25 repos × 50 PRs with nested fields) | 50 |
| Watcher enrichment batch (20 PRs) | 1 to 2 |
| One cron run, per org | 50 to 100 |
| 12 runs an hour (5-minute cron), per org | 600 to 1,200 |
| Cap per installation per hour | 5,000 |

The cron uses 12 to 24% of each org's budget. A Refresh click adds one run. Knobs if ever needed: `prs_per_repo` (50 → 20 roughly halves a page) and the 25-repo page size. A personal `gh` token instead of the App would share one 5,000 budget across all orgs (about 3,000 an hour at this cadence); that is a second reason for the App.

## Target architecture
- **One Worker, `pr-dash`,** with Workers Static Assets serving `static/` and a thin API. Same shape as bedrock's `bedrock-research` Worker.
- **`wrangler.json`** (validated by `scripts/check-config.mjs`):
  - `workers_dev: false`, `preview_urls: false`, exactly one `custom_domain` route
  - `assets: { directory: "./dist", binding: "ASSETS", run_worker_first: true }`: every request passes the Access check in the Worker first, then goes to `env.ASSETS.fetch()`
  - `triggers: { crons: ["*/5 * * * *"] }`
  - KV namespace binding `PRDASH`
  - `main: "worker/index.ts"`; `build: { command: "node scripts/build.mjs" }` turns `static/*.ts` into `dist/*.js` with esbuild (the local server strips types at serve time; the Worker's assets must be plain JS)
  - placeholders `__ACCOUNT_ID__`, `__HOSTNAME__`, `__KV_ID__`, `__ACCESS_TEAM_DOMAIN__`, `__ACCESS_AUD__` filled at deploy
- **The Worker:**
  1. verifies Access on every request
  2. **on cron, runs `collect()`** (the same function `server.ts` runs today) with the App's installation tokens, and writes the resulting `DashboardData` JSON to the KV key `prs`
  3. serves `/api/prs` from that key; `?refresh=1` reruns `collect()` on demand if the stored data is older than 60 seconds, then serves the new result
  4. serves and stores config and views in KV
- **The browser: unchanged.** It fetches `/api/prs`, renders, auto-refreshes on `refreshSeconds`. One small addition: when `generatedAt` is older than 10 minutes the footer says "cron not running" (two missed runs).
- **Shared pure code moves to `shared/`,** used by the Worker and `server.ts`: `shared/github.ts` (queries, raw shapes, shaping, `collect`, `attachBotReviews`), `shared/botreviews.ts`, `shared/sanitize.ts`, `shared/config-core.ts` (`Config`, `DEFAULTS`, `normalizeConfig`, `DashError`), `shared/views-core.ts` (`validateViews`, `globToRegExp`). `src/` keeps the Node pieces: the `gh`/`env:`/`keychain:` token resolver, `config.json` and `views.json` file I/O, the HTTP server. The browser keeps importing `src/types.ts` as types only.

## What already exists (from the Watcher spec)
Shipped in PR #2 and reused as is:
- `src/github.ts`: `graphql()` uses the global `fetch`, so it already runs in a Worker. `collect(cfg, tokens, extra)` takes a `Tokens`-like object with `forOwner(owner)`; the Worker passes an App-token resolver. The only Node dependency is `DashError` from `src/config.ts`, which moves to `shared/config-core.ts`.
- `src/botreviews.ts`, `src/sanitize.ts`: pure, 47 tests between them. Move unchanged.
- `static/`: unchanged except the footer line above.

## API (the same in both backends)
| Route | Behavior |
|---|---|
| `GET /api/prs[?refresh=1]` | The stored `DashboardData`. With `refresh=1`, rerun `collect()` first unless the stored data is under 60 seconds old. Same shape as today, so the browser doesn't change. |
| `GET /api/views`, `PUT /api/views` | As today (`validateViews()`, `X-PR-Dash: 1`, JSON body, Origin must equal `https://<host>`), stored in the KV key `views`. A `PUT` that adds a new owner or repo marks the data stale, as `server.ts` does today. |
| `GET /api/config`, `PUT /api/config` | Admin: read and replace the hosted config. Response never includes `tokens` (installation ids), `allowed_emails` or `allowed_domains`. `PUT` validated with `normalizeConfig()`, behind `assertWritable`. |
| `GET /api/health` | `{ok:true}`. |
- Local `server.ts` keeps serving the same routes from `config.json` and `views.json`, with its in-memory cache in place of KV.

## Cron and refresh
- **Schedule:** `*/5 * * * *`, 24/7.
- **Handler (`worker/scheduled.ts`):** read config and views from KV; `collect(cfg, appTokens, { repos: exactViewRepos(views), owners: viewOwners(views) })`; add `fetchMs`, `generatedAt`, `refreshSeconds`; `PRDASH.put("prs", JSON.stringify(data))`. One write per run.
- **Partial runs:** `collect()` already turns a failed owner or a failed Watcher fetch into warnings and keeps going (PR #2). The handler writes whatever it got, with the warnings, so stale good data never blocks fresh partial data. If `collect()` throws outright (no token, GitHub down), the handler logs and leaves the previous data in place.
- **Subrequests per run:** owner pages (5 today) + explicit-repo batches (0 to 2) + Watcher batches (1 to 3) + token mints (up to 4 on a cold isolate) + 2 KV reads + 1 KV write, about 15. `collect()` gains a budget counter that stops paginating at 40 subrequests and adds a warning naming the owner, so a growing org can't hit the hard cap of 50 and fail the run.
- **Wall time:** the local run takes about 16 s with `mine: true` and sequential owners; hosted is less without `mine`. The cron limit is 15 minutes.
- **`viewer`:** the queries today include `viewer { login }`, which an App installation token can't answer. The shared query builder takes `includeViewer` (true locally, false hosted), and hosted mode passes `viewer_login` from config into `shapePr` for "yours" and "needs your review".
- **`mine`:** forced to false hosted, with a warning. List the orgs in `owners`.
- **Refresh button and `r`:** the browser already sends `?refresh=1`. Hosted, that reruns `collect()` on demand if the stored data is over 60 seconds old, else returns what is stored. Each on-demand run is one more KV write; at a few dozen clicks a day the total stays far under 1,000.
- **Auto-refresh:** the browser re-reads `/api/prs` every `refreshSeconds` (set to 300 hosted; one KV read).
- **Staleness:** `generatedAt` older than 10 minutes means two missed cron runs. Footer: "Updated 23m ago · cron not running". Between 5 and 10 minutes is normal.

## Access, identity and security
- **Cloudflare Access application** for `pr-dash.workarea.io`: self-hosted, Google provider only, instant redirect, 24 h session, the reusable "bitfly.org Google users" policy (or a new one with the exact email `len@bitfly.org`).
- **The Worker verifies `Cf-Access-Jwt-Assertion` on every request,** as bedrock's `site/src/worker.js` does:
  - `jose` `createRemoteJWKSet(new URL(`${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`))`, cached per isolate, refetches on an unknown `kid`
  - `jwtVerify` with `issuer: ACCESS_TEAM_DOMAIN`, `audience: ACCESS_AUD`; `exp` and `nbf` enforced by `jose`
  - `email` from the **verified** claims must be in the KV config `allowed_emails` (exact, lowercase), or its domain (after the last `@`) must be in `allowed_domains`
  - `Host` must equal the configured hostname
  - otherwise `403`, one-line text body, `cache-control: no-store`
  - missing `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` → 500 "not configured", as bedrock does, so a misdeploy fails closed
- **Identity:** config `viewer_login` drives `personalize`-style flags (`isMine`, `reviewRequestedFromMe`). Later: `identities: {email: login}`.
- **Local dev bypass:** `DEV_ACCESS_EMAIL` in `.dev.vars`, only when the hostname is `localhost` or `127.0.0.1` and `ACCESS_AUD` is unset.
- **Secrets** (`wrangler secret put` from Len's machine; never in Actions or the repo): `GH_APP_PRIVATE_KEY` (PKCS#8), `GH_APP_ID`. Installation ids per owner live in KV config `tokens`, for example `"Carecise": "app:<id>"`.
- **Variables** (from the `production` environment at deploy, not committed): `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `HOSTNAME`.
- **Access administration:** Wrangler's OAuth token can't manage Access. Use the dashboard, or the API token in the macOS keychain (service `cloudflare-access`, account `bucchino`), as bedrock did.
- **Headers** (`dist/_headers` and the Worker on API responses): `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` (`h()` sets styles via `el.style.cssText`, which this allows); `Referrer-Policy: same-origin`; `X-Content-Type-Options: nosniff`; `X-Robots-Tag: noindex`; `Cache-Control: private, no-store` on everything.
- **Watcher markdown:** sanitized server-side in `collect()` exactly as today (the Worker is the server). The CSP backs it up.
- **Data at rest:** the KV `prs` value holds PR titles, branches and Watcher review text for every org. KV is account-private; only the Worker reads it, behind Access. No browser-side persistence beyond the page.

## Config and views
- **Config:** KV key `config`, same keys as `config.json` plus `allowed_emails`, `viewer_login`, and `tokens` in the `app:<installation id>` form.
- **Seeding and admin:** `node scripts/seed-kv.mjs config.hosted.json [views.json]` validates with the shared code, then `wrangler kv key put --remote`. Day-to-day changes via `PUT /api/config` behind Access. Views keep the in-app editor.

## GitHub App ("pr-dash reader")
- Owned by lab3, installed on **all repositories** in Ascera-life, Carecise, Workarea-io and lab3.
- **Permissions:** Metadata read, Pull requests read, Checks read, Commit statuses read. Contents read only if testing shows `headRefOid` or commit fields fail without it. No webhooks, no write permissions.
- **Verify in step 2:** `mergeable` and `mergeStateStatus` populate through an installation token. GitHub computes mergeability lazily on request; if an App token never triggers it, every row would show "merge check pending".
- **Token resolution:** `forOwner(owner)` stays the entry point. Locally: `gh`, `env:`, `keychain:`. In the Worker: `app:<installation id>`, minting a JWT (`iss` = App id, `iat` 60 s back, `exp` 10 min) and exchanging it for an installation token cached per isolate for 50 minutes.

## Deploy pipeline
- **`.github/workflows/deploy.yml`:**
  - **On every push:** `npm ci` → `npm run check` → `npm test` → build → `check-config.mjs` against a placeholder-filled config. Branches never deploy.
  - **Deploy job:** `if: github.ref == 'refs/heads/main'`, `environment: production` (deployment branches limited to main). Fills placeholders from `CF_ACCOUNT_ID`, `PRDASH_HOSTNAME`, `PRDASH_KV_ID`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`; validates; `npx --no-install wrangler deploy`. `CLOUDFLARE_API_TOKEN` exists only in that environment, scoped to Account → Workers Scripts: Edit and Zone → Workers Routes: Edit for `workarea.io`. No KV or Access scope.
  - Wrangler pinned in `package-lock.json`. Actions pinned by SHA, `persist-credentials: false`, `permissions: contents: read`, `cancel-in-progress: false`.
- **Post-deploy check (redirect only):** `check-access.mjs` (ported from carecise-formation): signed-out requests to `/`, `/app.js`, `/api/health` and `/api/prs` must 302 to `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/login/...` for **this** application (AUD pinned). "403 without assertion" and "200 with a valid assertion" are covered by tests against `wrangler dev`, not production. Len confirms the signed-in page in a browser after the first deploy and after Access changes.
- **`schedule:` hourly** (GitHub Actions, UTC): rerun the redirect check, no deploy.
- **Rollback:** `wrangler rollback`.

## Migration steps
1. **Move the pure code to `shared/`** (`github.ts`, `botreviews.ts`, `sanitize.ts`, `config-core.ts`, `views-core.ts`), add `includeViewer` to the query builder and the subrequest budget to `collect()`, update imports and tests. `server.ts` behaves exactly as today; `npm test` passes.
2. **Worker.** `worker/` (fetch handler, scheduled handler, access, github-app, kv), `wrangler.json` with placeholders, `scripts/build.mjs` (esbuild `static/` → `dist/`), `seed-kv.mjs`, `check-config.mjs`, `check-access.mjs`, the footer "cron not running" line. Run `wrangler dev --remote` against real data: `cpuTime` per request and per cron run, `mergeable` populated through the App token, the redirect check against a dev Access app or skipped locally.
3. **Len's one-time setup:** create the GitHub App and install it on the four orgs; create the KV namespace; `wrangler secret put` the App key and id; create the Access application for `pr-dash.workarea.io` and note its AUD; create the Workers-scoped CF API token; create the GitHub `production` environment with its variables and secrets; seed KV from `config.hosted.json` (owners, `allowed_emails: ["len@bitfly.org"]`, `viewer_login`, installation ids).
4. Merge to main, deploy, watch the redirect check pass, sign in and confirm the page. Confirm in Workers Logs that the cron runs every 5 minutes and `cpuTime` stays under 10 ms.
5. Local stays first-class. The two modes don't share views or config unless Len copies them.

## Testing
`node --test`, TypeScript run directly:
- **Shared:** the existing `botreviews`, `sanitize`, `config` and `github` suites pass from their new paths. New: `includeViewer: false` omits `viewer` from every query; `shapePr` uses the passed login; the subrequest budget stops paginating and warns.
- **Access:** valid token; wrong `aud`; wrong `iss`; expired; unknown `kid` (refetches keys); email not in `allowed_emails` and not on an `allowed_domains` domain; missing header → 403 on an API path and an asset path; dev bypass refused when `ACCESS_AUD` is set or the host isn't local; missing variables → 500.
- **Worker API:** `/api/prs` serves the KV value; `?refresh=1` reruns only when older than 60 s; `/api/config` never contains `tokens` or `allowed_emails`; `PUT` without the header, wrong Origin, or invalid data → 4xx; a `PUT /api/views` naming a new owner marks the data stale.
- **Cron:** with a stubbed `fetch`, the handler writes `prs` once with `generatedAt`; a failing owner yields warnings plus data for the rest; a thrown `collect()` leaves the old value. Run through `wrangler dev`'s `/cdn-cgi/local/scheduled?cron=*/5+*+*+*+*`.
- **App tokens:** JWT claims; isolate cache hit and expiry; one mint per org per isolate.
- **Build and config checks:** `dist/` has `app.js` and `_headers` with the CSP; `check-config` rejects `workers_dev`, `preview_urls`, a missing domain, a missing cron, leftover placeholders; `check-access` handles a wrong `kid` and a redirect to another application.
- **Same output in both modes:** one fixture test runs `collect()` with recorded GraphQL responses through the Node transport and the Worker transport and compares the JSON.

## Files to change
| File | Change |
|---|---|
| `shared/github.ts`, `shared/botreviews.ts`, `shared/sanitize.ts` (moved from `src/`) | Pure code, tests moved with them; `includeViewer`, subrequest budget |
| `shared/config-core.ts`, `shared/views-core.ts` (new) | `Config`, `DEFAULTS`, `normalizeConfig`, `DashError`; `validateViews`, `globToRegExp` |
| `src/config.ts`, `src/views.ts` | Shrink to Node pieces: `gh`/`env:`/`keychain:` resolver, file load and save |
| `server.ts` | Import from `shared/`; `/api/config`, `/api/health`; otherwise unchanged |
| `static/app.ts` | Footer: "cron not running" past 10 minutes |
| `worker/index.ts`, `worker/scheduled.ts`, `worker/access.ts`, `worker/github-app.ts`, `worker/kv.ts` (new) | Routing and headers, cron, JWT check, App tokens, KV access |
| `wrangler.json` (new, placeholders) | Assets with `run_worker_first`, KV binding, cron trigger, build, no workers.dev or previews |
| `scripts/build.mjs`, `seed-kv.mjs`, `check-config.mjs`, `check-access.mjs` (new) | Build, seeding, deploy guard rails |
| `.github/workflows/deploy.yml` (new) | Checks on every branch; main-only deploy through `production`; hourly redirect probe |
| `package.json`, `package-lock.json` | Pinned `wrangler`, `esbuild`, `jose`, `@cloudflare/workers-types`; scripts |
| `tsconfig.json`, `tsconfig.worker.json` (new) | Separate type settings for DOM and Workers |
| `.gitignore` | `dist/`, `.dev.vars`, `.wrangler/`, `config.hosted.json` |
| `README.md` | "Hosted on Cloudflare" section; local mode unchanged |
| `docs/specs/watcher-reviews.md` | One line: hosted, the 120-second cache is the KV value refreshed by the cron |

## If we outgrow free
- **Symptoms:** Error 1102 "Worker exceeded resource limits" (`exceededCpu` in Workers Logs); "Too many subrequests" or the budget warning on every run; Error 1027 (100,000 requests a day); KV write errors past 1,000 a day.
- **Fallback:** Workers Paid ($5/mo): 30 s CPU, 10,000 subrequests. No code change to switch.

## Resolved questions
All v2 questions are answered in "Decisions". Nothing is open before code. Before deploy: Len's one-time setup in migration step 3.
