# pr-dash: hosting on Cloudflare Workers, draft spec

Status: spec v1, draft for Len to react to. No code changes made.

## Goal
Run pr-dash as a team-only site on Cloudflare, so it works from any device without a laptop running `node server.ts`. Keep the local app working, and stay compatible with `docs/specs/watcher-reviews.md`.

## What has to change, and why
- **Type stripping.** `server.ts` strips types from `static/*.ts` as it serves them, using Node's `stripTypeScriptTypes`. Static Assets can't do that.
- **Node-only code.** `src/config.ts` uses `node:child_process` (`gh auth token`, macOS Keychain) and `node:fs` (`config.json`). `src/views.ts` uses `node:fs` (`views.json`, temp file then rename). `src/github.ts` imports `config.ts`, so it pulls in Node APIs too, even though its GraphQL calls only use `fetch` and would run on Workers as they are.
- **Cache.** The cache is three module variables (`cached`, `fetchedAt`, `inflight`). On Workers, isolates come and go and every location has its own, so this needs a shared store.
- **Loopback-only security.** `hostAllowed()` only accepts loopback Host headers, which means nothing on a public hostname. Cloudflare Access plus a check inside the Worker takes its place.
- **"Mine" depends on a personal token.** `mine: true` runs `viewer.repositories`, and `isMine` and `reviewRequestedFromMe` compare against `viewer.login`. With a non-personal token (an App or a shared token), the viewer is a bot, not the person looking at the page.

## Target architecture
- **One Worker, `pr-dash`**, with Workers Static Assets serving `dist/` (the built `static/`) and the API in the same Worker. This is the `carecise-formation` setup with an API added.
- `wrangler.json` (enforced by a config check, as in formation's `scripts/lib/config.js`):
  - `workers_dev: false`, `preview_urls: false`, exactly one `custom_domain` route
  - `assets: { directory: "./dist", binding: "ASSETS", run_worker_first: true }`. Every request, assets included, passes the Access check in the Worker first and then goes to `env.ASSETS.fetch()`. This fixes the #23 finding that "the Worker serves static assets with no check of its own."
  - A KV namespace bound as `PRDASH` (snapshot, views, cached tokens)
  - `build: { command: "node scripts/build.mjs", watch_dir: ["static", "src"] }`, so `wrangler dev` rebuilds on change
- **Request flow:** Cloudflare Access (at the edge) → the Worker checks the Access JWT → `/api/*` goes to the handlers, everything else to `ASSETS`.
- **Shared code (runs on both Node and Workers):** `src/github.ts`, `src/types.ts`, the pure half of `src/config.ts`, the pure half of `src/views.ts`, and `src/botreviews.ts` from the watcher spec. Platform-specific code lives in `server.ts` (Node) and `worker/` (Cloudflare).

## Serving the browser code
- **Decision: a small build step with esbuild,** pinned as a devDependency in `package-lock.json`.
  - `scripts/build.mjs` bundles `static/app.ts` into `dist/app.js` (ESM with a sourcemap, minifying optional). It copies `index.html` and `style.css`, and writes `dist/_headers`.
  - esbuild only strips types, which is the same thing the current code assumes (`erasableSyntaxOnly`), so nothing in `static/` needs rewriting.
- `static/index.html` changes `<script src="/app.ts">` to `/app.js`.
- **Local Node mode keeps working:** `server.ts` answers `/app.js` with the type-stripped `app.ts`. The `./lib/*.ts` imports still resolve through the existing stripping path. There's no build for `node server.ts`.
- **Local Worker mode:** `npx --no-install wrangler dev` runs the build and serves the Worker on localhost with secrets from `.dev.vars`, which is gitignored.
- I considered committing prebuilt JS instead and rejected it: it drifts out of sync and is noise in reviews.

## Porting server.ts route by route
| Today (`server.ts`) | On Workers |
|---|---|
| `GET /api/prs[?refresh=1]` → `getData()` | Same route and same response shape. It reads the snapshot from KV, and refreshes it when it's older than `cache_seconds` or `refresh=1` is passed. |
| In-memory `cached` / `fetchedAt` | KV key `snapshot:v1` = `{ data, fetchedAt, viewsHash }`, plus the same module variables kept as a per-isolate first-level cache. KV is global, so Len's phone and laptop share one snapshot, and editing views can mark it stale. |
| `inflight` (one fetch shared by concurrent requests) | The same promise within an isolate. Across isolates, a best-effort KV key `lock:refresh` (60-second TTL): if another isolate is already refreshing, serve the stale snapshot with `stale: true`, and the page picks up the fresh one on its next poll. A Durable Object would make this exact but isn't worth it for a handful of users. |
| Refresh timing | **Lazy, as today:** refresh in the foreground when the snapshot is stale and someone loads the page. An optional Cron Trigger (for example every 5 minutes on weekdays during work hours) keeps it warm. It's off by default so the app doesn't use GitHub quota when nobody's looking. |
| `GET /api/views` | Reads KV key `views`, validated with the existing `validateViews()`. |
| `PUT /api/views` + `assertWritable` | Same validation and the same `X-PR-Dash: 1` and JSON checks. The Origin must equal `https://<custom domain>`. Writes the KV key `views`. If the views add a repo or owner that isn't in the snapshot, the snapshot is marked stale, as the current `fetchedAt = 0` does. Last write wins. |
| `hostAllowed()` (loopback names) | Replaced by the Access JWT check on **every** request (below), plus Host must equal the configured custom domain. |
| `serveStatic` + type stripping | `env.ASSETS.fetch()` serves the built `dist/`. |
| `/src/*` blocked | Doesn't exist in `dist/`, so nothing to block. |
| Error JSON (`DashError` → `{error, hint}`) | Same shape and status codes. The hints change to fit hosted mode, for example "token for Carecise is unavailable, check the App installation" instead of "run `gh auth login`." |

**Per-user flags.** The snapshot is shared by everyone, so `isMine` and `reviewRequestedFromMe` get filled in for each request by a pure `personalize(data, githubLogin)` function. It's the same comparison `shapePr` does today, moved out of it. Both modes use it: locally the login comes from `gh`, and hosted it comes from the Access email through an `identities` map in the config (for example `{ "<Len's email>": "<Len's GitHub login>" }`). Users with no mapping just don't see "yours" or "needs your review."

## Access check in the Worker
- Cloudflare Access app for the hostname. The policy allows only the people Len names; see open questions.
- The Worker verifies `Cf-Access-Jwt-Assertion` on every request:
  - RS256 signature against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (the key set is cached per isolate and fetched again when it sees an unknown `kid`)
  - `aud` contains `ACCESS_AUD`, `iss` equals the team domain, `exp` and `nbf` are valid
  - Built on WebCrypto in about 60 lines in `worker/access.ts`, with no `jose` dependency (open to using `jose` if Len prefers)
- A missing or invalid token gets `403` with no body detail. Assets are never served without it, since `run_worker_first` is on.
- `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are vars. The email comes from the verified JWT payload, never from the unsigned `Cf-Access-Authenticated-User-Email` header.
- **Local dev bypass:** `.dev.vars` can set `DEV_ACCESS_EMAIL`. It only takes effect when the request's hostname is `localhost` or `127.0.0.1` **and** `ACCESS_AUD` is unset, so a deployed Worker can't be put into bypass mode by a variable alone.
- **Warning:** a hostname under `*.carecise.ai` would fall under the wildcard Carecise Access app, which admits the whole Carecise Google sign-in. That would show Ascera-life and Workarea-io PRs to Carecise members. Use a dedicated Access app with a narrower policy, or a hostname on another zone.

## Config and views
- **`config.json` → one JSON var, `CONFIG`,** in `wrangler.json` with the same keys and the same normalization (`loadConfig`'s clamps become a pure `normalizeConfig()`).
  - Dropped in hosted mode: `host`, `port`, and `mine`, which needs a personal viewer and is forced to `false` with a warning. List the orgs in `owners` instead: `["Ascera-life", "Carecise", "Workarea-io", "lab3"]`.
  - New: `identities` (email to GitHub login), `cron_refresh` (on/off).
  - Watcher keys from the companion spec (`bot_reviewers`, `bot_reviews`) work unchanged.
  - **The repo is public.** A `CONFIG` var in `wrangler.json` would publish the org and repo list and the identity emails. Alternative: keep `CONFIG` in KV (`config` key, edited with `wrangler kv key put`). See open questions.
- **`views.json` → KV key `views`.** It's one small document with very few writes, so KV is enough. KV's eventual consistency (up to about 60 seconds across locations) only matters if two people edit views at the same moment. Switch to D1 only if views become per-user with real editing traffic.
- **Seeding:** `wrangler kv key put views --path views.json` once, from the Mac's current file.

## GitHub auth
`gh auth token` and Keychain don't exist on Workers. `Tokens.forOwner()` stays the single entry point, with a pluggable resolver: Node keeps `gh` / `env:` / `keychain:`, and the Worker adds `app:<installationId>` and `secret:<NAME>`.

| | **A. Fine-grained PAT per org** (Worker secrets, `secret:GH_TOKEN_CARECISE` …) | **B. Separate read-only GitHub App** (installation tokens made in the Worker) |
|---|---|---|
| Setup | 4 PATs, since a fine-grained PAT targets exactly one owner. Org approval may be needed. | 1 App, 4 installations, 1 private key secret |
| Expiry | Max 1 year (orgs may require less). 4 rotations a year, and when one is missed, that org's data quietly disappears. | None. Installation tokens are made hourly and cached in KV for about 50 minutes. |
| Tied to | Len's personal account and his personal 5,000 points per hour (shared with his `gh` use) | The App. Each installation has its own rate-limit budget. |
| "Mine" | `viewer` = Len, so `mine` works for him only | `viewer` is the bot, so it uses the `identities` map (needed anyway for more than one user) |
| Code | About 0 new lines | About 80 lines (an RS256 JWT with WebCrypto, `POST /app/installations/{id}/access_tokens`, caching) |

- **Recommendation: B, a new read-only App** (for example "pr-dash reader," owned by lab3, installed on all repositories in each org). Reasons:
  - Tokens don't expire.
  - It's least-privilege and revocable per org.
  - Each org has its own rate limit.
  - It isn't tied to Len's personal account.
- **Don't reuse Grok PR Watcher.** It has write permissions to post reviews, and the watcher spec already decided its private key stays out of pr-dash.
- **Permissions** (repository, **read-only**, the same for **Ascera-life, Carecise, Workarea-io, lab3**):
  - Metadata: read (mandatory)
  - Pull requests: read. This covers PRs, reviews, `reviewThreads`, review requests, `mergeable`, and `latestReviews` for the watcher spec.
  - Checks: read and Commit statuses: read, for `statusCheckRollup` (CI)
  - Contents: read, **only if testing shows** `commits(last:1){commit{…}}` / `headRefOid` fail without it. Try without it first.
  - Organization → Members: read, optional, only if team review requests should show team slugs
  - No webhooks, no write permissions, no account permissions
- **The private key** needs converting once from PKCS#1 to PKCS#8 for WebCrypto (`openssl pkcs8 -topk8 -nocrypt`). Len stores it with `wrangler secret put GH_APP_PRIVATE_KEY` from his Mac. It never goes into GitHub Actions or the repo. `GH_APP_ID` and the installation IDs go in `CONFIG.tokens`, for example `"Carecise": "app:<id>"`.
- **Installation tokens** are cached in KV (`ghtoken:<owner>`, 50-minute TTL) and used only inside the Worker. They never appear in a response, a log, or the snapshot.

## Workers limits, and how the design stays within them
| Limit | Free | Paid ($5/mo) | pr-dash need |
|---|---|---|---|
| CPU per request | 10 ms | 30 s default (up to 5 min) | Parsing and shaping several MB of GraphQL JSON for about 30 repos × 50 PRs, plus the watcher enrichment, is likely to go over 10 ms. |
| Subrequests per request | 50 | 10,000 | Per refresh: about 4 owners × 1–3 pages, 1–2 explicit batches, 1–3 watcher batches, up to 4 token mints, 3–5 KV operations, 1 key set fetch. That's about 15–30. |
| Simultaneous connections waiting on headers | 6 | 6 | Run GitHub calls with **concurrency ≤ 4** (today's `collect()` is sequential, so add a small pool). |
| Cron CPU | 10 ms | 30 s | Only matters if the cron refresh is on. |
- **Recommendation: Workers Paid.** On Free the fan-out fits, but CPU doesn't reliably.
- **GitHub:** GraphQL is limited by cost points.
  - The watcher spec's two-step fetch keeps the extra cost to about 1 point per 20 PRs.
  - With a lazy 120-second cache, the worst case is about 30 refreshes an hour across all users. That's well under each installation's 5,000+ points per hour.
  - The ≤4 concurrency stays clear of GitHub's secondary limits on concurrent requests.
  - `rateLimit` per installation goes in the footer as it does today: show the lowest remaining value.
- **Snapshot size:** KV allows values up to 25 MiB. The watcher `bodyHTML` adds the most, but at about 30 open PRs it stays well under 1 MB.

## Security
- **Access:** a dedicated application for the hostname with an explicit allowlist of emails (or a group). The `kid` / AUD is pinned in the post-deploy and scheduled checks.
- **Never public:** `workers_dev: false` and `preview_urls: false`, enforced by `scripts/check-config.mjs` in CI. There's no other route.
- **Defense in depth:** JWT check in the Worker on every request (assets included) and `Host` pinned to the custom domain.
- **Secrets:** the App key goes in a Workers secret, set by Len. The CI token can deploy but can't read secrets. Local `.dev.vars` is gitignored. GitHub tokens never reach the browser: API responses carry only shaped data, and errors are rewritten so they don't echo upstream bodies that might contain headers.
- **Headers:** `dist/_headers` for assets, and the same set added by the Worker on API responses:
  - `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`. `h()` sets styles through `el.style.cssText`, which this policy allows. The favicon is a `data:` SVG.
  - `Referrer-Policy: same-origin`, so GitHub links don't leak the private hostname
  - `X-Content-Type-Options: nosniff`, `X-Robots-Tag: noindex`
  - `Cache-Control: no-store` on `/api/*`
- **Watcher markdown:** the companion spec's `bodyHTML` allowlist sanitizer has to be pure TypeScript (no DOM, no Node), so it runs in both modes. It drops `img` (blocked by CSP anyway) and keeps only `https://` links.
- **Writes:** `PUT /api/views` is still the only write route, behind `assertWritable` (custom header, JSON body, exact Origin match).

## Deploy pipeline (formation's pattern, with the #23 review fixes)
- `.github/workflows/deploy.yml`:
  - **On every push:** `npm ci` → `npm run check` (tsc) → `node --test` → `node scripts/check-config.mjs` → build. Nothing deploys from branches.
  - **Deploy job:** `if: github.ref == 'refs/heads/main'`, `environment: production` (GitHub environment with *Deployment branches: main only*). `CLOUDFLARE_API_TOKEN` lives **only** in that environment, not at repo level.
  - **The CF token is used by this repo only,** scoped to Account → Workers Scripts: Edit, plus Zone → Workers Routes: Edit for the one zone. The KV namespace is created once by hand, so the token doesn't need KV edit access.
  - **Wrangler is a devDependency pinned in `package-lock.json`** and run with `npx --no-install wrangler deploy`. Actions are pinned by SHA, `persist-credentials: false`, `permissions: contents: read`, concurrency group with `cancel-in-progress: false`.
  - **Post-deploy:** `scripts/check-access.mjs`, ported from formation with the AUD pinned to the redirect's `kid`. It probes `/` and `/api/prs`, and both must 302 to this Access app.
  - **`schedule:` hourly:** runs the same access check with no deploy, so a change to the Access app gets caught.
- **Rollback:** `wrangler rollback`, documented in the README.

## Custom domain
- **Placeholder:** `prs.<zone Len chooses>`.
- It must be a zone on the same Cloudflare account as the Access team.
- Avoid `*.carecise.ai` unless it gets its own more specific Access app (see the warning above). A lab3 or personal zone fits better, since the dashboard covers four orgs.

## Migration steps
1. **Refactor with no behavior change.** Split `src/config.ts` into a pure core and a Node loader, and `src/views.ts` into pure validation and fs storage. Add `personalize()` and a concurrency pool in `collect()`. Point `index.html` at `/app.js` and add the alias in `server.ts`. Add tests and a CI workflow that only runs checks. `node server.ts` behaves exactly as today.
2. Add `worker/`, `wrangler.json`, `scripts/build.mjs`, `scripts/check-config.mjs`, `scripts/check-access.mjs`. Test with `wrangler dev` on localhost (dev bypass on).
3. **Len's one-time setup:** create the read-only App and install it on the 4 orgs. Convert the key and `wrangler secret put` it. Create the KV namespace. Create the Access app and policy and note the AUD. Create the Workers-scoped CF token. Create the GitHub `production` environment holding that token.
4. Merge to main, deploy, and confirm the access check passes. Seed `views` (and `config`, if it goes in KV).
5. Use the hosted site. **Local stays fully supported:** `node server.ts` with `gh`, `config.json` and `views.json`, unchanged. The two modes don't share views unless Len copies them.

## Testing
`node --test` (TypeScript runs directly, no extra dependency):
- **Access:** valid token, wrong `aud`, wrong `iss`, expired, unknown `kid` (refetches the key set), missing header → 403. The dev bypass is refused when `ACCESS_AUD` is set or the host isn't local.
- **App tokens:** JWT claims (`iss` = app id, `iat` 60 seconds back, `exp` ≤ 10 minutes), cache hit and expiry.
- **Routes:** `/api/prs` cache hit, stale refresh, `refresh=1`, lock held → stale served. `PUT /api/views` without the header, with the wrong Origin, with invalid views → 4xx, and a valid write marks the snapshot stale.
- **Pure functions:** `normalizeConfig`, `validateViews`, `personalize`, the concurrency pool, plus `botreviews` and the sanitizer from the watcher spec.
- **Build and deploy checks:** `dist/` contains `app.js`, `index.html` references it, `_headers` has CSP and Referrer-Policy. `check-config` rejects `workers_dev: true`, `preview_urls: true`, or a missing custom domain. `check-access` verdicts, including a wrong `kid`.
- Run with Miniflare and `wrangler dev` before the first deploy.

## Files to change
| File | Change |
|---|---|
| `wrangler.json` (new) | Worker name, account, custom domain, `workers_dev`/`preview_urls` false, assets with `run_worker_first`, KV binding, build command, vars |
| `worker/index.ts` (new) | Fetch handler: Access check, Host pin, `/api/*` routing, `ASSETS` fallback, security headers, optional `scheduled` handler |
| `worker/access.ts` (new) | Access JWT verification (WebCrypto, cached key set) |
| `worker/github-app.ts` (new) | App JWT and installation tokens, cached in KV |
| `worker/store.ts` (new) | KV snapshot, lock, views, config |
| `src/config.ts` → `src/config-core.ts` + `src/config.ts` | Pure types, defaults, `normalizeConfig`, and `Tokens` with a pluggable resolver. The Node loader (`gh`, `env:`, `keychain:`) stays in `config.ts`. |
| `src/views.ts` → `src/views-core.ts` + `src/views.ts` | Pure validation and helpers; fs load and save stay Node-only |
| `src/github.ts` | Import only the core modules; concurrency pool; drop the per-viewer flags from `shapePr` (moved to `personalize`) |
| `src/personalize.ts` (new) | `isMine` and `reviewRequestedFromMe` for a given login |
| `server.ts` | `/app.js` alias, import updates, call `personalize` |
| `static/index.html` | `/app.ts` → `/app.js` |
| `scripts/build.mjs` (new) | esbuild bundle, copy assets, write `_headers` |
| `scripts/check-config.mjs`, `scripts/check-access.mjs` (new) | Ported from carecise-formation, with the AUD pinned |
| `.github/workflows/deploy.yml` (new) | Checks on every branch; main-only deploy through the `production` environment; hourly access check |
| `package.json` / `package-lock.json` | devDependencies `wrangler`, `esbuild`, `@cloudflare/workers-types` (pinned). Scripts `build`, `dev`, `test`, `check`. |
| `tsconfig.json` + `tsconfig.worker.json` (new) | Separate type settings so DOM and Workers types don't clash |
| `.gitignore` | `dist/`, `.dev.vars`, `.wrangler/` |
| `test/*.test.ts` (new) | Tests listed above |
| `README.md` | "Hosted on Cloudflare" section: setup, secrets, deploy, rollback; local mode unchanged |
| `static/app.ts`, `static/lib/*` | No changes expected (API paths are already relative). Only the error hint "Is the server still running?" needs rewording. |

## Open questions for Len
1. **Cloudflare account and hostname.** Which account and zone (Carecise's or a personal or lab3 one), and therefore which Access team domain? What subdomain?
2. **Who gets in?** Only you, or teammates too? Anyone you add sees PRs from all four orgs unless we add per-user org filtering.
3. **Workers Paid ($5/mo):** OK? Free is unlikely to stay under 10 ms of CPU per refresh.
4. **GitHub auth:** OK with a new read-only "pr-dash reader" App (recommended) instead of four fine-grained PATs? Should lab3 or an org own it?
5. **Config location.** The repo is public, so should `CONFIG` (org list, identity emails) go in KV instead of `wrangler.json`?
6. **Views:** one shared set for everyone (simplest), or per-user views keyed by Access email?
7. **Identities:** which email maps to which GitHub login for "yours" and "needs your review"?
8. **Refresh:** lazy only (recommended), or a weekday cron to keep it warm?
9. **Write actions:** ever planned (approve, merge)? This spec assumes read-only, and adding them would mean App write permissions and a stricter review.
10. **Local mode:** keep it as a first-class option long term, or retire it once the hosted site is trusted?
