# pr-dash: hosting on Cloudflare Workers (free plan), draft spec

Status: spec v2, revised with Len's answers (Oct 8) and the Grok PR Watcher review of #1. No code changes made.

## Goal
Run pr-dash as a private site on Cloudflare's **Workers Free plan**, so it works from any device without a laptop running `node server.ts`. Keep the local app working, and stay compatible with `docs/specs/watcher-reviews.md`.

## Decisions (Len, Oct 8)
1. **Account and hostname:** Len's "bucchino" Cloudflare account, hostname `prs.bucchino.com` (placeholder, Len to confirm), with a dedicated Access application for that hostname. Not `*.carecise.ai`, because the wildcard Carecise Access app admits the whole Carecise sign-in, which would show Ascera-life and Workarea-io PRs to Carecise members.
2. **Users:** Len only. The Access policy allows his email only. Identity is a single configured GitHub login, kept extensible (see Config).
3. **Plan:** it **must** run on Workers Free. No Paid requirement. "If we outgrow free" lists the symptoms and the fallback.
4. **Config out of the public repo:** the org list, repos and owners, identity email, and every other non-secret setting live in **Workers KV**, with a seed script and an admin route. Secrets stay as Worker secrets. Nothing identifying is committed (see "Public repo hygiene").
5. **Storage: KV** (it has a free tier; see the limits below).

## Verified free-plan limits (Oct 8, 2026)
| Limit | Free | Source |
|---|---|---|
| Worker CPU per request | **10 ms** (waiting on `fetch`, KV and so on doesn't count) | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Subrequests per invocation | **50** (Paid: 10,000) | same |
| Simultaneous outgoing connections per request | 6 | same |
| Requests | 100,000/day (Error 1027 past that) | same |
| Cron Triggers | 5 per account, 10 ms CPU each, **UTC only** | same, plus [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) |
| KV | 100,000 reads/day, **1,000 writes/day**, 1 write/sec per key, 1 GB, values up to 25 MiB | [KV limits](https://developers.cloudflare.com/kv/platform/limits/), [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) |
| D1 | 10 databases, 500 MB each, 5M rows read/day, 100k rows written/day, 50 queries per invocation | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| Cache API | Free, but **"for Workers fronted by Cloudflare Access, the Cache API is not currently available"** | [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) |

**What follows from these limits:**
- The Cache API can't hold the PR snapshot (we're behind Access).
- KV's 1,000 writes a day rule out writing a snapshot on every refresh.
- Parsing several MB of GraphQL JSON in the Worker risks the 10 ms CPU limit.

So the snapshot and the heavy work move to the **browser**, and the Worker becomes a thin, I/O-bound proxy.

## Target architecture
- **One Worker, `pr-dash`,** with Workers Static Assets serving `dist/` (the built `static/`) and a thin API. Same shape as `carecise-formation`.
- **`wrangler.json`** (checked by `scripts/check-config.mjs`, as in formation's `scripts/lib/config.js`):
  - `workers_dev: false`, `preview_urls: false`, exactly one `custom_domain` route
  - `assets: { directory: "./dist", binding: "ASSETS", run_worker_first: true }`. Every request, assets included, passes the Access check in the Worker first, and only then goes to `env.ASSETS.fetch()`.
  - KV namespace `PRDASH` (config and views only)
  - `build: { command: "node scripts/build.mjs", watch_dir: ["static", "shared"] }`
- **The Worker only:**
  1. verifies Access
  2. serves config and views from KV
  3. runs **fixed** GraphQL query templates with the right installation token and **streams GitHub's response body straight back** (`new Response(gh.body)`), without `JSON.parse`
- **The browser:**
  - drives the fetch, one call per source page
  - shapes, merges and filters the data
  - computes the Watcher statuses and personal flags
  - caches the last good snapshot in IndexedDB
- **Shared pure code moves to a new `shared/` folder,** used by the browser, the Worker and `server.ts`: query templates, shaping, `botreviews`, `personalize`, config normalization, views validation. The local server serves `/shared/*.ts` with types stripped, the same way it serves `static/` today. This replaces the current rule that the browser can only import `src/` as types.

## API (the same in both backends)
| Route | Behavior |
|---|---|
| `GET /api/config` | Settings the browser needs: owners, repos, exclude, `prs_per_repo`, `max_repos_per_source`, `cache_seconds`, `refresh_seconds`, `bot_reviewers`, `bot_reviews`, `viewer_login`. **Never** tokens or installation IDs. |
| `PUT /api/config` | Admin route behind `assertWritable`. Validated with `normalizeConfig()`, written to KV. |
| `GET /api/views`, `PUT /api/views` | As today (`validateViews()`, `X-PR-Dash: 1`, JSON body, Origin must equal `https://<host>`), stored in the KV key `views`. |
| `GET /api/gh/owner?login=&cursor=` | One page of `OWNER_QUERY` (25 repos, `$prs` PRs each). The owner must be in config or views. |
| `GET /api/gh/repos?r=a/b,c/d…` | One `explicitQuery()` batch of 20 repos or fewer. |
| `GET /api/gh/watcher?ids=…` | The watcher spec's `nodes(ids:)` enrichment for 20 PR ids or fewer. |
| `GET /api/health` | `{ok:true}`, for the post-deploy probe. |
- The browser never sends GraphQL. It only sends validated parameters (owner and repo name patterns, base64 cursor, PR node IDs), so the Worker can't be used as a general-purpose GitHub proxy.
- `/api/prs` is retired. Its orchestration (`collect()`: sources, pagination, dedupe, exclude/archived/fork filters, the `max_repos_per_source` cap) moves to `static/lib/fetcher.ts`.
- **Local `server.ts` implements the same routes** with the `gh` token and files: `config.json` for config, `views.json` for views. Both modes then run identical browser code, which addresses the review's dual-mode drift nit.

## Browser fetch, cache, and the stale behavior (review finding 1)
- **On load:** paint the IndexedDB snapshot right away if there is one. If it's older than `cache_seconds`, or the user pressed Refresh, start a refresh.
- **Refresh steps:**
  1. Read `/api/config` and `/api/views`.
  2. Build the source list.
  3. Fetch pages with **concurrency 4**, following `hasNextPage` up to `max_repos_per_source`.
  4. Run watcher enrichment for PRs that have a Watcher review.
  5. Shape the data, run `personalize`, render, and save to IndexedDB with `fetchedAt`.
- **Client states.** `stale` is defined here, so the server doesn't need a flag:
  - `refreshing`: the old data stays on screen, the Refresh button spins, and the footer says "Refreshing…".
  - `stale`: shown when the snapshot is older than `cache_seconds` and no refresh is running, for example a background tab or a refresh error. The footer says "Updated 7m ago · stale". A refresh starts on focus (the existing `visibilitychange` hook) or on the next timer tick.
  - `partial`: one or more sources failed. Render what loaded, list the failed owners or batches in the existing warnings notice, and retry just those after 30 seconds. Don't save a partial snapshot over a complete one.
- **Coalescing:** one refresh at a time per tab (the existing `state.loading` guard). Another device or tab runs its own refresh, which is fine for one user.
- Auto-refresh stays on `refresh_seconds`, still paused while the tab is hidden.

## How it fits the free limits
- **CPU:** each Worker call does the Access JWT check (WebCrypto RS256, native), a parameter check, and possibly one cached-key RS256 signature for a GitHub App token. GitHub's response is streamed through without parsing, so the estimate is **about 1 to 3 ms**, well under 10 ms. Step 2 of the migration confirms this in Workers Logs (`cpuTime`) before go-live. All JSON parsing and shaping happens in the browser.
- **Subrequests:** **4 or fewer per call:**
  - 1 GraphQL request
  - 1 installation token request, only on a cold isolate (tokens are cached in isolate memory for about 50 minutes, **not** in KV)
  - 1 Access key set request, only on a cold isolate
  - 1 KV read for config (cached in isolate memory for 60 seconds)

  That's far below 50. The fan-out happens across many small browser requests instead of inside one Worker invocation.
- **Requests:** a refresh is about 10 to 25 API calls (4 owners × 1 to 3 pages, 1 or 2 repo batches, 1 to 3 watcher batches). At 30 refreshes an hour for 10 hours, that's about 7,500 calls a day plus assets, well under 100,000.
- **KV:** a few hundred reads a day. Writes happen only when config or views change, about 10 a day at most, against a limit of 1,000.
- **Why KV over D1:** KV has a free tier with room to spare for two small documents (config, views) that are read often and written rarely. It's one binding, and seeding is `wrangler kv key put`. D1's free tier would work too, but it brings a schema and migrations for no benefit. Revisit D1 only for per-user views with heavy editing.
- **GitHub:** with the watcher spec's two-step fetch, each installation uses well under its 5,000 points an hour.

## If we outgrow free
- **Symptoms:**
  - **Error 1102 "Worker exceeded resource limits"** (`exceededCpu` in Workers Logs)
  - **"Too many subrequests"** errors
  - **Error 1027** (100,000 requests a day used up)
  - KV write errors past 1,000 a day
- **Fallback:** Workers Paid ($5/mo) is a plan switch, with 30 s of CPU and 10,000 subrequests. No code change is needed, and the same design simply gets headroom. Only then consider moving shaping back to the server or adding a shared snapshot.

## Access, identity and security
- **Cloudflare Access app** for `prs.bucchino.com`. The policy is Len's email, plus a **service token used only by the CI probe** (see Deploy). This needs Zero Trust set up on the bucchino account, with its own team domain.
- **The Worker verifies `Cf-Access-Jwt-Assertion` on every request:**
  - RS256 signature against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (key set cached per isolate, fetched again on an unknown `kid`)
  - `aud` equals `ACCESS_AUD`, `iss` is the team domain, `exp` and `nbf` are valid
  - `email` from the **verified** claims is in the KV config `allowed_emails`, or `common_name` matches the probe's service token
  - `Host` equals the configured hostname
  - Otherwise `403` with no detail
- **Identity:** config holds `viewer_login` (Len's GitHub login), and `personalize()` uses it for "yours" and "needs your review." To support more users later, replace it with an `identities: {email: login}` map. The code path doesn't change.
- **Local dev bypass:** `DEV_ACCESS_EMAIL` in `.dev.vars` only works when the hostname is `localhost` or `127.0.0.1` and `ACCESS_AUD` is unset.
- **Secrets** (`wrangler secret put` from Len's machine; never in GitHub Actions or the repo): `GH_APP_PRIVATE_KEY` (PKCS#8), `GH_APP_ID`, `ACCESS_AUD`.
  - The installation IDs for each owner live in KV config `tokens`, for example `"Carecise": "app:<id>"`. They aren't secrets, just unnecessary to publish.
  - GitHub tokens never reach the browser. Streamed bodies are GitHub's GraphQL data only, and upstream error bodies are replaced with short messages.
- **Headers** (`dist/_headers`, and the Worker on API responses):
  - `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`. `h()` sets styles through `el.style.cssText`, which this allows.
  - `Referrer-Policy: same-origin`, `X-Content-Type-Options: nosniff`, `X-Robots-Tag: noindex`
  - `Cache-Control: no-store` on `/api/*`
- **Watcher markdown:** shaping now happens in the browser, so the watcher spec's `bodyHTML` allowlist sanitizer runs there too. It parses into an inert `<template>`, walks it, and keeps only the allowlisted tags and `https://` links. It's still backed by the CSP above. It's the same code in both modes.

## Public repo hygiene
- `wrangler.json` is committed with **placeholders** for `account_id`, the route hostname and the KV namespace ID. The deploy step fills them in from variables in the GitHub `production` environment (`CF_ACCOUNT_ID`, `PRDASH_HOSTNAME`, `PRDASH_KV_ID`), then `check-config.mjs` validates the generated file.
- Config (org list, repos, `allowed_emails`, `viewer_login`, installation IDs) lives only in KV, seeded from a **gitignored** `config.hosted.json`.
- Nothing identifying is committed: no emails, no org inventory, no account or namespace IDs. This spec names the example hostname only as a placeholder.

## Config and views
- **Config:** KV key `config`, same keys as today's `config.json` plus `allowed_emails`, `viewer_login`, and the watcher keys (`bot_reviewers`, `bot_reviews`).
  - `mine` isn't available in hosted mode: the viewer is the App bot, so it's forced to false with a warning. List the orgs in `owners`.
  - `host` and `port` are local only.
- **Seeding and admin:**
  - `node scripts/seed-kv.mjs config.hosted.json [views.json]` checks the files with the shared validators, then runs `wrangler kv key put --remote`. Each run is 1 or 2 KV writes.
  - Day-to-day changes go through `PUT /api/config` behind Access. Views keep their in-app editor through `PUT /api/views`.

## GitHub auth (pending Len's decision)
- **Recommendation: a new read-only GitHub App,** for example "pr-dash reader," owned by lab3 and installed on **all repositories** in Ascera-life, Carecise, Workarea-io and lab3.
  - **Permissions:** Metadata read, Pull requests read, Checks read, Commit statuses read.
  - Contents read **only if testing shows** `headRefOid` or commit fields fail without it.
  - Organization Members read is optional, only for team review-request names.
  - No webhooks, no write permissions.
- **Alternative: four fine-grained PATs** (one per owner) stored as Worker secrets (`secret:GH_TOKEN_CARECISE`). Simpler to set up, but they expire (one year at most), they're tied to Len's account and share his personal rate limit, and a missed rotation quietly drops an org.
- **Not Grok PR Watcher:** it has write permissions, and the watcher spec keeps its key out of pr-dash.
- **Token resolution:** `Tokens.forOwner()` stays the entry point, with a pluggable resolver. Locally: `gh`, `env:` and `keychain:`. In the Worker: `app:<id>` and `secret:<NAME>`. Owners without an entry use the default.

## Cron (not recommended for now)
- Free allows Cron Triggers (5 per account, 10 ms CPU), but a warm cache would need a server-side snapshot, which this design doesn't have. **Recommendation: lazy refresh only.**
- If it's added later: **cron runs in UTC only.** Weekday work hours in Chicago (8 AM to 6 PM) are `*/10 13-22 * * MON-FRI` during CDT (UTC-5) and `*/10 14-23 * * MON-FRI` during CST (UTC-6). Either switch the expression at each DST change, or use `*/10 13-23 * * MON-FRI` all year and accept an extra hour at one end. Tests would run the handler through `wrangler dev`'s `/cdn-cgi/local/scheduled?cron=…&time=…` on both sides of a DST change.

## Deploy pipeline (formation's pattern, with the #23 review fixes)
- **`.github/workflows/deploy.yml`:**
  - **On every push:** `npm ci` → `npm run check` → `node --test` → build → `check-config.mjs` against a placeholder-filled config. Branches never deploy.
  - **Deploy job:** `if: github.ref == 'refs/heads/main'`, `environment: production` (deployment branches limited to main). `CLOUDFLARE_API_TOKEN` exists **only** in that environment.
  - **The CF token is used by this repo only,** scoped to Account → Workers Scripts: Edit, plus Zone → Workers Routes: Edit for the bucchino zone. The KV namespace is created once by hand, so the token has no KV access.
  - **Wrangler is a devDependency pinned in `package-lock.json`,** run with `npx --no-install wrangler deploy`. Actions are pinned by SHA, `persist-credentials: false`, `permissions: contents: read`, `cancel-in-progress: false`.
- **Post-deploy checks (review finding 5):**
  1. `check-access.mjs` (ported, AUD pinned to the redirect's `kid`): a signed-out request to `/`, `/app.js` and `/api/health` must 302 to **this** Access app.
  2. `check-worker.mjs` with the Access **service token** (`CF-Access-Client-Id` and `CF-Access-Client-Secret` as `production` environment secrets): `/`, `/app.js` and `/api/health` must return 200 **through the Worker**, which proves the JWT check, Host pin and `run_worker_first` work on assets.
  3. A request that reaches the Worker without the assertion must get 403. That can't be produced in production (Access always adds the header), so it's covered by tests against `wrangler dev` and Miniflare.
- **`schedule:` hourly** (GitHub Actions cron, also UTC): rerun checks 1 and 2 with no deploy.
- **Rollback:** `wrangler rollback`.

## Migration steps
1. **Watcher spec first, or at least a stub.** Land `shared/botreviews.ts` from `watcher-reviews.md` (or a stub that returns no statuses) before or inside this step, so the port doesn't wait on a missing module (review finding 6).
2. **Refactor with no hosting yet.** Create `shared/` (queries, shaping, `personalize`, `normalizeConfig`, `validateViews`). Move `collect()` orchestration into `static/lib/fetcher.ts` with IndexedDB caching and the client states above. Give `server.ts` the new routes (`/api/config`, `/api/gh/*`) and retire `/api/prs`. Point `index.html` at `/app.js`. Add tests and a CI workflow that only runs checks. `node server.ts` shows the same dashboard as today.
3. Add `worker/`, `wrangler.json` with placeholders, `scripts/build.mjs`, `seed-kv.mjs`, `check-config.mjs`, `check-access.mjs`, `check-worker.mjs`. Run `wrangler dev` and confirm CPU stays at about 3 ms or less on real data, using `wrangler dev --remote` or the first deploy's Workers Logs.
4. **Len's one-time setup:** confirm the hostname and zone. Set up Zero Trust on the bucchino account (team domain), the Access app, a policy for his email, and the probe service token. Create the KV namespace. Set up the GitHub App or PATs, and run `wrangler secret put`. Create the Workers-scoped CF token and the `production` environment with its variables and secrets. Seed KV.
5. Merge to main, deploy, and see the checks pass.
6. Local stays first-class: `node server.ts` with `gh`, `config.json` and `views.json`. The two modes don't share views or config unless Len copies them.

## Testing
`node --test`, with TypeScript running directly:
- **Access:** valid token; wrong `aud`; wrong `iss`; expired; unknown `kid` (refetches keys); email not allowed; service token; missing header → 403 (also on an asset path); dev bypass refused when `ACCESS_AUD` is set or the host isn't local.
- **Worker API:** parameter validation (owner not in config, more than 20 repos or ids, bad cursor → 400); the GitHub body is streamed, not parsed; GitHub's 401 becomes a short error; `/api/config` never contains `tokens`; `PUT` without the header, with the wrong Origin, or with invalid data → 4xx.
- **App tokens:** JWT claims (`iss`, `iat` set 60 seconds back, `exp` 10 minutes or less); isolate cache hit and expiry.
- **Browser fetcher** (fixture GraphQL pages): pagination cap, dedupe, filters, concurrency 4 or less, `partial` on one failing source with a retry, `stale` after `cache_seconds`, a partial snapshot never overwrites a complete one.
- **Shared:** `normalizeConfig`, `validateViews`, `personalize`, shaping, and `botreviews` plus the sanitizer from the watcher spec.
- **Build and config checks:** `dist/` has `app.js` and `_headers` with CSP and Referrer-Policy; `check-config` rejects `workers_dev`, `preview_urls`, a missing domain, and leftover placeholders; `check-access` handles a wrong `kid`.
- **Same output in both modes:** a fixture test loads the same recorded GraphQL pages through `server.ts` and through `wrangler dev`, and checks the rendered data matches.

## Files to change
| File | Change |
|---|---|
| `shared/queries.ts`, `shared/shape.ts`, `shared/personalize.ts`, `shared/config-core.ts`, `shared/views-core.ts` (new) | Pure code from `src/github.ts`, `src/config.ts` and `src/views.ts`, shared by the browser, the Worker and Node |
| `shared/botreviews.ts` | From the watcher spec (or a stub first) |
| `src/config.ts`, `src/views.ts`, `src/github.ts` | Shrink to the Node pieces: the `gh`/`env:`/`keychain:` resolver, fs load and save, GraphQL transport |
| `server.ts` | `/api/config`, `/api/gh/*`, `/api/health`; serve `/shared/*.ts`; `/app.js` alias; retire `/api/prs` |
| `static/lib/fetcher.ts` (new) | Source orchestration, concurrency, IndexedDB cache, refreshing/stale/partial states |
| `static/app.ts`, `static/lib/state.ts` | Use the fetcher; footer shows stale and partial; reword the "server still running?" hint |
| `static/index.html` | `/app.ts` → `/app.js` |
| `worker/index.ts`, `worker/access.ts`, `worker/github-app.ts`, `worker/kv.ts` (new) | Routing and headers, JWT check, App tokens (cached in memory), config and views in KV |
| `wrangler.json` (new, placeholders) | Assets with `run_worker_first`, KV binding, build command, no workers.dev or previews |
| `scripts/build.mjs`, `seed-kv.mjs`, `check-config.mjs`, `check-access.mjs`, `check-worker.mjs` (new) | Build, seeding, deploy guard rails |
| `.github/workflows/deploy.yml` (new) | Checks on every branch; main-only deploy through `production`; hourly probes |
| `package.json`, `package-lock.json` | Pinned devDependencies `wrangler`, `esbuild`, `@cloudflare/workers-types`; scripts |
| `tsconfig.json`, `tsconfig.worker.json` (new) | Separate type settings for DOM and Workers |
| `.gitignore` | `dist/`, `.dev.vars`, `.wrangler/`, `config.hosted.json` |
| `test/*.test.ts` (new) | Tests above |
| `README.md` | "Hosted on Cloudflare" section; local mode unchanged |
| `docs/specs/watcher-reviews.md` | One line: shaping, status and the sanitizer run in the browser (shared code), and the cache is the browser snapshot |

## Open questions for Len
1. **Hostname:** is `prs.bucchino.com` right, and is that zone on the bucchino account? Is Zero Trust (Access team domain) already set up there? Is it OK for this public spec to name the domain, or should it be generic?
2. **GitHub auth (pending):** new read-only App owned by lab3 (recommended), or four fine-grained PATs?
3. **CI probe:** OK to add an Access service token, used only by the post-deploy and hourly probes, to the policy alongside your email?
4. **Cron warming:** lazy only (recommended), or a UTC-scheduled weekday cron, which would also need a small shared snapshot?
5. **Write actions:** assumed read-only for v1. Confirm.
6. **Local mode:** keep it first-class long term, or retire it once the hosted site is trusted?
7. **Views per user:** moot while it's just you. Revisit if anyone else is added.
