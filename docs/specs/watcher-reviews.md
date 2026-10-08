# pr-dash: PR Watcher reviews, draft spec

Status: spec v2, updated with Len's answers. No code changes made.

## Goal
Show each Grok PR Watcher review right on the dashboard, with a status indicator that says whether its findings are still open or have been addressed.

## How pr-dash works today
- A local Node app (`node server.ts` on 127.0.0.1:8787). TypeScript, no framework, no build step, no CI, no tests.
- All GitHub calls are GraphQL from the server (`src/github.ts`). The token comes from your `gh` login, with optional overrides per org. The browser never sees it.
- The list layout is `static/lib/list.ts`, the grid layout is `static/lib/grid.ts`, and the summary bar and toggles live in `static/app.ts`.

## Data
1. **Cheap marker.** Add `id`, `headRefOid`, and `latestReviews(first:10){author{login}}` to the existing PR query, so we know which PRs have a Watcher review.
2. **Second fetch.** Only for those PRs, batch about 20 per query using `nodes(ids:)` to get:
   - `reviews(author:"grok-pr-watcher[bot]")`: id, state, submittedAt, url, commit oid, body text.
   - `reviewThreads`: isResolved, isOutdated, path, line, the first comment's author, url and text, its review id, and the reply count.
   This two-step fetch costs about 1 rate-limit point per batch. Putting threads into the main query would have cost about 84 points for 10 repos.
3. The status logic goes in a new pure module, `src/botreviews.ts`, so it can be tested. It uses the existing 120-second cache. Hosted on Cloudflare, the 120-second cache is the KV value the Worker cron rewrites every 5 minutes (see `cloudflare-hosting.md`).
4. Config adds `bot_reviewers: ["grok-pr-watcher[bot]"]` and `bot_reviews: true`.

## Status rules
- A finding counts as **open** until its thread is **resolved**. An outdated thread is still open, but it gets an "outdated" marker so you know the code has changed under it.
- **Nits** (findings whose text starts with "Nit") never count toward Open. They get their own gray badge, for example `2 nits`.
- Each review gets one of four statuses:
  - **Open**: every finding is still open.
  - **Partly addressed**: some findings are open, some are done.
  - **Addressed**: every non-nit finding is resolved.
  - **Summary only**: the review has no inline findings.
- **New commits since review** is a separate chip, shown when the review's commit isn't the PR's current head commit.
- A PR's overall status is its latest Watcher review's status, but if any older review still has open findings, it's at least "Partly addressed".
- Colors are red for Open, yellow for Partly addressed, green for Addressed, and gray for Summary only.

## UI
- **List row:** a badge such as `Watcher: 3/4 open`, a separate `2 nits` badge, the `new commits` chip, and a **mergeable indicator**.
- **Mergeable indicator:** a green "Ready to merge" when all of these hold: Watcher status is Addressed or Summary only, GitHub `mergeable` is MERGEABLE, CI is passing or there is no CI, it isn't a draft, and no review is requesting changes. Otherwise it's gray and says what's blocking, for example "2 open findings · CI pending · conflicts". The data comes from `mergeable`, `mergeStateStatus`, and the CI rollup that's already fetched.
- **Visibility:** open PRs are always shown, whatever their Watcher status.
- **Collapsible panel under the row**, closed by default:
  - Review age and a link to the review.
  - The summary as **rendered markdown**, collapsed and capped at about 12 lines with a "show more" control. The server fetches GitHub's own `bodyHTML`, which GitHub has already rendered and sanitized, then passes it through a small strict allowlist (p, ul, ol, li, code, pre, a with https links only, strong, em, h3, h4, blockquote, table) before it reaches the browser. That keeps the app dependency-free with no client-side markdown parser. Finding text in the list is rendered the same way.
  - Findings, open ones first, each with ● open, ✓ resolved, or ↻ outdated, plus `path:line` linking to the comment, the first line of the finding, and a reply count.
  - An "Earlier reviews (n)" section.
- **Grid card:** a status dot with a tooltip, and an "n with open Watcher findings" stat.
- **Summary bar:** a chip showing `n open Watcher findings`.
- **Filter:** an "Only open Watcher findings" toggle. Search also understands `watcher:open` and `watcher:addressed`.

## Files
`src/types.ts`, `src/config.ts`, `config.example.json`, `src/github.ts`, new `src/botreviews.ts`, `static/lib/list.ts`, `static/lib/grid.ts`, `static/lib/state.ts`, `static/app.ts`, `static/index.html`, `static/lib/dom.ts`, `static/style.css`, `README.md`. Optional: `src/botreviews.test.ts` with `node --test`, plus a small CI workflow.

## Auth
- Keep using your `gh` token. The App's private key stays out of pr-dash.
- Check on your Mac that `gh` can see each org: `gh api graphql -f query='{repositoryOwner(login:"Carecise"){repositories(first:1){nodes{nameWithOwner}}}}'`
- Add `"owners": ["Ascera-life","Carecise","Workarea-io","lab3"]` to `config.json`.

## Decisions (Len, Oct 8)
1. Nits get a separate badge and don't count toward Open.
2. Only resolved threads count as addressed. Outdated threads stay open, with a marker.
3. Open PRs are never hidden. Each one gets a mergeable indicator.
4. Summaries and findings are rendered as markdown.
