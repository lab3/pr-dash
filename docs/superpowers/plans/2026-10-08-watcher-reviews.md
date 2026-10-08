# Watcher Reviews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each Grok PR Watcher review on the dashboard with a status that says whether its findings are open, partly addressed, addressed, or summary only, plus a per-PR mergeable indicator.

**Architecture:** The server adds a cheap marker (`latestReviews` authors, `headRefOid`, `mergeable`, `mergeStateStatus`) to the existing PR query, then runs one batched `nodes(ids:)` query for only the PRs that have a Watcher review. Two new pure server modules do the work: `src/sanitize.ts` turns GitHub's `bodyHTML` into allowlisted HTML, and `src/botreviews.ts` turns raw reviews and threads into a `WatcherSummary` and a list of merge blockers. The browser only renders what the server computed; a new `static/lib/watcher.ts` holds the badges, panel and indicator, and `state.ts` grows one toggle plus `watcher:` search tokens.

**Tech Stack:** TypeScript run directly by Node 22.18+ (type stripping, no build), GitHub GraphQL v4, `node --test` with `node:assert/strict`, plain DOM. No new dependencies.

**Spec:** `docs/specs/watcher-reviews.md`

## Global Constraints

- Node `>=22.18` (package.json `engines`). Node runs `.ts` directly; nothing is emitted.
- Only erasable TypeScript syntax: no `enum`, `namespace` or parameter properties (`erasableSyntaxOnly` in tsconfig).
- Browser code (`static/`) may import `src/` only with `import type`.
- No runtime dependencies. No client-side markdown parser. HTML comes from GitHub's `bodyHTML` and passes a server-side allowlist.
- The browser never sees the GitHub token.
- Status colors: red = Open, yellow (amber) = Partly addressed, green = Addressed, gray = Summary only.
- Nits (finding text starts with "Nit") never count toward Open. Outdated threads stay open, with a marker. Only resolved threads count as addressed.
- Open PRs are never hidden by Watcher status.
- Config keys: `bot_reviewers: ["grok-pr-watcher[bot]"]`, `bot_reviews: true`.
- The second fetch batches about 20 PRs per query with `nodes(ids:)`, reusing the existing `cache_seconds` cache.
- `npm run check` (`tsc --noEmit`, strict) must pass after every task.

## Review Focus

Verified live against GitHub on 2026-10-08 (PR Ascera-life/ascera-mobile#368): `reviews(author: "grok-pr-watcher[bot]")` returns the review, `reviews(author: "grok-pr-watcher")` returns nothing, and `latestReviews.nodes[].author` comes back as `{ __typename: "Bot", login: "grok-pr-watcher" }` with no `[bot]` suffix. `mergeStateStatus` works without a preview header. One PR with `reviewThreads(first: 50)` cost 1 rate-limit point.

1. **Bot login format mismatch.** GraphQL actors give `grok-pr-watcher`; config and `reviews(author:)` use `grok-pr-watcher[bot]`. A user expects the marker to match either way. Pinned by `botLogin` tests in Task 3.
2. **Unsafe HTML in a review body.** `<script>`, `onerror=`, `javascript:` hrefs or `<img>` in `bodyHTML` must never reach `innerHTML`. Pinned by `sanitizeHtml` tests in Task 2.
3. **Watcher fetch fails but the main fetch worked.** A rate-limit error or a token that cannot read one org must leave the dashboard loading, with a warning and no Watcher data, not a blank page. Pinned by the `attachBotReviews` failing-fetcher test in Task 5.
4. **`mergeable: UNKNOWN` right after a push.** GitHub computes mergeability asynchronously; the indicator must not say "Ready to merge" until it is `MERGEABLE`. Pinned by `mergeBlockers` test in Task 4.
5. **More than 50 review threads on one PR.** Findings past the cap are not fetched; the user should see a warning rather than a silently low count. Pinned by the `capWarning` test in Task 5.

Also tested along the way: a review whose only findings are nits is "addressed" with a nits badge (Task 4); a file-level thread with `line: null` renders as the path alone (Tasks 4, 7); threads from other reviewers are ignored (Task 4).

## File Structure

| File | Responsibility |
| --- | --- |
| `src/types.ts` (modify) | `WatcherStatus`, `Finding`, `WatcherReview`, `WatcherSummary`, merge enums; new `PullRequest` and `DashboardData` fields |
| `src/config.ts` (modify) | `bot_reviews`, `bot_reviewers` keys; `normalizeConfig` |
| `src/sanitize.ts` (create) | `sanitizeHtml`: allowlist filter for GitHub `bodyHTML` |
| `src/botreviews.ts` (create) | Pure status logic: `botLogin`, `isNit`, `reviewStatus`, `overallStatus`, `shapeWatcher`, `mergeBlockers` |
| `src/github.ts` (modify) | Marker fields in `RepoFields`; `botReviewsQuery`, `fetchBotReviews`, `attachBotReviews`, `hasBotReview`, `capWarning`; wiring in `collect` |
| `src/*.test.ts` (create) | `node --test` suites for the pure modules |
| `static/lib/state.ts` (modify) | `onlyWatcher` toggle, `watcher:` tokens, panel open-state sets |
| `static/lib/dom.ts` (modify) | `html()` helper for server-sanitized markup |
| `static/lib/watcher.ts` (create) | `watcherBadges`, `mergeIndicator`, `watcherPanel` |
| `static/lib/list.ts`, `static/lib/grid.ts` (modify) | Call the new render helpers |
| `static/app.ts`, `static/index.html`, `static/style.css` (modify) | Toggle, summary chip, styles |
| `config.example.json`, `README.md`, `package.json`, `.github/workflows/check.yml` | Config example, docs, `npm test`, CI |

---

### Task 1: Shared types, config keys, test runner

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `config.example.json`
- Modify: `package.json`
- Test: `src/config.test.ts`

**Interfaces:**
- Produces: the types below, used by every later task. `normalizeConfig(cfg: Config): Config`. `Config.bot_reviews: boolean`, `Config.bot_reviewers: string[]`. `npm test` runs `node --test 'src/**/*.test.ts'`.

- [ ] **Step 1: Add the test script**

In `package.json`, add to `"scripts"`:

```json
"test": "node --test 'src/**/*.test.ts'"
```

- [ ] **Step 2: Write the failing config test**

Create `src/config.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, normalizeConfig } from "./config.ts";

test("bot review defaults", () => {
  assert.equal(DEFAULTS.bot_reviews, true);
  assert.deepEqual(DEFAULTS.bot_reviewers, ["grok-pr-watcher[bot]"]);
});

test("normalizeConfig trims bot_reviewers and drops blanks", () => {
  const cfg = normalizeConfig({ ...DEFAULTS, bot_reviewers: [" a[bot] ", "", "b[bot]"] });
  assert.deepEqual(cfg.bot_reviewers, ["a[bot]", "b[bot]"]);
});

test("normalizeConfig falls back to defaults when bot_reviewers is not an array", () => {
  const cfg = normalizeConfig({ ...DEFAULTS, bot_reviewers: "grok" as unknown as string[] });
  assert.deepEqual(cfg.bot_reviewers, ["grok-pr-watcher[bot]"]);
});

test("normalizeConfig treats anything but false as bot_reviews on", () => {
  assert.equal(normalizeConfig({ ...DEFAULTS, bot_reviews: false }).bot_reviews, false);
  assert.equal(normalizeConfig({ ...DEFAULTS, bot_reviews: "yes" as unknown as boolean }).bot_reviews, true);
});

test("normalizeConfig still clamps prs_per_repo", () => {
  assert.equal(normalizeConfig({ ...DEFAULTS, prs_per_repo: 500 }).prs_per_repo, 100);
  assert.equal(normalizeConfig({ ...DEFAULTS, prs_per_repo: -5 }).prs_per_repo, 1);
});
```

- [ ] **Step 3: Run the test to see it fail**

Run: `npm test`
Expected: FAIL. `normalizeConfig` is not exported (`SyntaxError: The requested module './config.ts' does not provide an export named 'normalizeConfig'`).

- [ ] **Step 4: Add the config keys and `normalizeConfig`**

In `src/config.ts`, extend the `Config` interface after `refresh_seconds`:

```ts
  /** Fetch bot (PR Watcher) reviews and show their status. */
  bot_reviews: boolean;
  /** Bot logins whose reviews count, in GitHub's "[bot]" form. */
  bot_reviewers: string[];
```

Extend `DEFAULTS`:

```ts
  refresh_seconds: 300,
  bot_reviews: true,
  bot_reviewers: ["grok-pr-watcher[bot]"],
```

Replace the last two lines of `loadConfig` (the `prs_per_repo` clamp and `return cfg;`) with `return normalizeConfig(cfg);`, and add below it:

```ts
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
```

- [ ] **Step 5: Add the shared types**

In `src/types.ts`, after `CheckState`:

```ts
export type MergeableState = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
export type MergeStateStatus =
  | "BEHIND" | "BLOCKED" | "CLEAN" | "DIRTY" | "DRAFT" | "HAS_HOOKS" | "UNKNOWN" | "UNSTABLE";

/** Status of one Watcher review, or of a PR's Watcher reviews as a whole. */
export type WatcherStatus = "open" | "partly" | "addressed" | "summary";

/** One inline comment thread opened by a Watcher review. */
export interface Finding {
  path: string;
  line: number | null;
  url: string;
  /** Sanitized HTML of the first comment (see src/sanitize.ts). */
  html: string;
  /** Text starts with "Nit": never counts toward Open. */
  nit: boolean;
  resolved: boolean;
  /** The code under the thread changed. Still open unless resolved. */
  outdated: boolean;
  /** Comments in the thread after the first one. */
  replies: number;
}

export interface WatcherReview {
  id: string;
  url: string;
  submittedAt: string;
  /** Commit the review was posted against. */
  commit: string | null;
  /** Sanitized HTML of the review summary. */
  html: string;
  status: WatcherStatus;
  /** Open non-nit findings. */
  open: number;
  /** All non-nit findings. */
  total: number;
  /** Unresolved nits. */
  nits: number;
  /** Open first, then resolved; nits after non-nits within each group. */
  findings: Finding[];
  /** The PR has commits newer than `commit`. */
  stale: boolean;
}

export interface WatcherSummary {
  status: WatcherStatus;
  open: number;
  total: number;
  nits: number;
  stale: boolean;
  latest: WatcherReview;
  earlier: WatcherReview[];
}
```

Extend `PullRequest` (after `reviewRequestedFromMe`):

```ts
  /** GraphQL node id, used for the batched Watcher fetch. */
  id: string;
  headOid: string | null;
  mergeable: MergeableState | null;
  mergeState: MergeStateStatus | null;
  /** null when the PR has no review from a configured bot. */
  watcher: WatcherSummary | null;
  /** Why the PR isn't ready to merge, in display order. Empty means ready. */
  blockers: string[];
```

Extend `DashboardData` (after `refreshSeconds`):

```ts
  /** `bot_reviews` from config, so the UI knows whether to show Watcher chrome. */
  botReviews: boolean;
```

- [ ] **Step 6: Update the config example**

In `config.example.json`, after the `refresh_seconds` line:

```json
  "_bot_reviews_comment": "Show Grok PR Watcher reviews and whether their findings are addressed.",
  "bot_reviews": true,
  "bot_reviewers": ["grok-pr-watcher[bot]"],
```

- [ ] **Step 7: Run the test to see it pass**

Run: `npm test`
Expected: `ℹ pass 5`, `ℹ fail 0`.

- [ ] **Step 8: Type check**

Run: `npm run check`
Expected: errors in `src/github.ts` only, where `shapePr` doesn't yet set `id`, `headOid`, `mergeable`, `mergeState`, `watcher`, `blockers`, and `collect` doesn't return `botReviews`. Task 5 fixes these. Make sure no other file errors.

- [ ] **Step 9: Commit**

```bash
git add package.json src/types.ts src/config.ts src/config.test.ts config.example.json
git commit -m "feat: config keys and shared types for Watcher reviews"
```

---

### Task 2: HTML allowlist sanitizer

**Files:**
- Create: `src/sanitize.ts`
- Test: `src/sanitize.test.ts`

**Interfaces:**
- Produces: `sanitizeHtml(input: string): string`. Input is GitHub's `bodyHTML`. Output contains only `p br ul ol li code pre a strong b em i h3 h4 blockquote table thead tbody tr th td del hr`, no attributes except `href` (https only) plus `target="_blank" rel="noopener"` on `a`. Tags are balanced.

- [ ] **Step 1: Write the failing tests**

Create `src/sanitize.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeHtml } from "./sanitize.ts";

test("keeps allowlisted tags and strips their attributes", () => {
  assert.equal(
    sanitizeHtml('<p dir="auto">Hi <code class="notranslate">x</code> <strong>y</strong></p>'),
    "<p>Hi <code>x</code> <strong>y</strong></p>",
  );
});

test("drops script and style with their contents", () => {
  assert.equal(sanitizeHtml("<p>a</p><script>alert(1)</script><style>p{}</style><p>b</p>"), "<p>a</p><p>b</p>");
});

test("unwraps unknown tags but keeps their text", () => {
  assert.equal(
    sanitizeHtml('<div class="highlight"><pre>code</pre></div><span>t</span>'),
    "<pre>code</pre>t",
  );
});

test("keeps https links with safe attributes only", () => {
  assert.equal(
    sanitizeHtml('<a href="https://github.com/x" class="user-mention" onclick="evil()">@x</a>'),
    '<a href="https://github.com/x" target="_blank" rel="noopener">@x</a>',
  );
});

test("unwraps links that are not https", () => {
  assert.equal(sanitizeHtml('<a href="javascript:alert(1)">click</a>'), "click");
  assert.equal(sanitizeHtml('<a href="http://example.com">plain</a>'), "plain");
  assert.equal(sanitizeHtml("<a>no href</a>"), "no href");
});

test("drops event handler attributes on kept tags", () => {
  assert.equal(sanitizeHtml('<p onclick="x()" onmouseover=y>a</p>'), "<p>a</p>");
});

test("downgrades h1 and h2 to h3, h5 and h6 to h4", () => {
  assert.equal(sanitizeHtml("<h2>T</h2><h1>U</h1><h6>V</h6>"), "<h3>T</h3><h3>U</h3><h4>V</h4>");
});

test("drops img and other void tags that are not allowed", () => {
  assert.equal(sanitizeHtml('<p><img src="x" onerror="alert(1)">after</p>'), "<p>after</p>");
  assert.equal(sanitizeHtml('<input type="checkbox" checked> item'), "item");
});

test("closes unclosed tags and ignores stray closers", () => {
  assert.equal(sanitizeHtml("<ul><li>a</li>"), "<ul><li>a</li></ul>");
  assert.equal(sanitizeHtml("<p>x"), "<p>x</p>");
  assert.equal(sanitizeHtml("</p>x</div>"), "x");
});

test("escapes a stray less-than in text", () => {
  assert.equal(sanitizeHtml("<p>a < b</p>"), "<p>a &lt; b</p>");
});

test("keeps tables and removes comments", () => {
  assert.equal(
    sanitizeHtml("<!-- c --><table><thead><tr><th>a</th></tr></thead><tbody><tr><td>b</td></tr></tbody></table>"),
    "<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>b</td></tr></tbody></table>",
  );
});

test("keeps br and hr as void tags", () => {
  assert.equal(sanitizeHtml("a<br>b<hr>c"), "a<br>b<hr>c");
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test src/sanitize.test.ts`
Expected: FAIL with `Cannot find module` for `./sanitize.ts`.

- [ ] **Step 3: Write the sanitizer**

Create `src/sanitize.ts`:

```ts
// Allowlist filter for HTML that GitHub already rendered from markdown (`bodyHTML`).
// It keeps a small set of tags with no attributes (except https hrefs), drops script-like
// elements with their contents, and unwraps everything else so the text survives. The
// browser puts the output straight into innerHTML, so this is the only guard between a
// review body and the page. No dependencies: a tag tokenizer is enough because the input
// is already well-formed, entity-encoded HTML from GitHub, not arbitrary user text.

const KEEP = new Set([
  "p", "br", "ul", "ol", "li", "code", "pre", "a", "strong", "b", "em", "i", "h3", "h4",
  "blockquote", "table", "thead", "tbody", "tr", "th", "td", "del", "hr",
]);
const RENAME: Record<string, string> = { h1: "h3", h2: "h3", h5: "h4", h6: "h4" };
const DROP_CONTENT = new Set(["script", "style", "svg", "math", "template", "iframe", "object", "embed", "noscript"]);
const VOID = new Set(["br", "hr"]);

// One match per comment or tag. Group 1 = tag name, group 2 = raw attribute text.
const TAG = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s<>"'=/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>`]+))?)*)\s*\/?>/g;

export function sanitizeHtml(input: string): string {
  let out = "";
  let last = 0;
  let skipping: string | null = null; // inside an element whose content we drop
  const open: string[] = []; // kept tags currently open, for balancing

  for (const m of input.matchAll(TAG)) {
    const text = input.slice(last, m.index);
    last = m.index + m[0].length;
    if (!skipping) out += escapeText(text);

    const raw = m[1];
    if (!raw) continue; // comment
    const closing = m[0].startsWith("</");
    const name = raw.toLowerCase();

    if (skipping) {
      if (closing && name === skipping) skipping = null;
      continue;
    }
    if (DROP_CONTENT.has(name)) {
      if (!closing) skipping = name;
      continue;
    }
    const tag = RENAME[name] ?? name;
    if (!KEEP.has(tag)) continue; // unwrap: drop the tag, keep its children

    if (closing) {
      if (open.includes(tag)) {
        let t: string | undefined;
        do {
          t = open.pop();
          out += `</${t}>`;
        } while (t !== tag);
      }
      continue;
    }
    if (tag === "a") {
      const href = attr(m[2], "href");
      if (!href || !/^https:\/\//i.test(href)) continue; // unwrap non-https links
      out += `<a href="${href.replace(/"/g, "&quot;")}" target="_blank" rel="noopener">`;
      open.push("a");
      continue;
    }
    out += `<${tag}>`;
    if (!VOID.has(tag)) open.push(tag);
  }
  if (!skipping) out += escapeText(input.slice(last));
  while (open.length) out += `</${open.pop()}>`;
  return out.trim();
}

function attr(attrs: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'<>\`]+))`, "i");
  const m = re.exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

/** Text between tags is already entity-encoded by GitHub; only a stray "<" can remain. */
const escapeText = (s: string): string => s.replace(/</g, "&lt;");
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --test src/sanitize.test.ts`
Expected: `ℹ pass 12`, `ℹ fail 0`.

- [ ] **Step 5: Type check and commit**

Run: `npm run check` (same pre-existing `github.ts` errors as Task 1, nothing new).

```bash
git add src/sanitize.ts src/sanitize.test.ts
git commit -m "feat: allowlist sanitizer for GitHub bodyHTML"
```

---

### Task 3: Status rules (bot login, nits, review and overall status)

**Files:**
- Create: `src/botreviews.ts`
- Test: `src/botreviews.test.ts`

**Interfaces:**
- Produces:
  - `botLogin(author: { __typename?: string; login: string } | null | undefined): string | null` → `"grok-pr-watcher[bot]"` form.
  - `isNit(text: string): boolean`
  - `reviewStatus(findings: Pick<Finding, "nit" | "resolved">[]): WatcherStatus`
  - `overallStatus(latest: WatcherStatus, earlierOpen: number): WatcherStatus`

- [ ] **Step 1: Write the failing tests**

Create `src/botreviews.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { botLogin, isNit, overallStatus, reviewStatus } from "./botreviews.ts";

test("botLogin adds [bot] for Bot actors and keeps it when already present", () => {
  assert.equal(botLogin({ __typename: "Bot", login: "grok-pr-watcher" }), "grok-pr-watcher[bot]");
  assert.equal(botLogin({ __typename: "Bot", login: "grok-pr-watcher[bot]" }), "grok-pr-watcher[bot]");
  assert.equal(botLogin({ login: "dependabot[bot]" }), "dependabot[bot]");
});

test("botLogin leaves users alone and handles missing authors", () => {
  assert.equal(botLogin({ __typename: "User", login: "len" }), "len");
  assert.equal(botLogin(null), null);
  assert.equal(botLogin({ login: "" }), null);
});

test("isNit matches Nit prefixes through markdown decoration", () => {
  assert.equal(isNit("Nit: this measures the raw string"), true);
  assert.equal(isNit("**Nit** rename this"), true);
  assert.equal(isNit("nitpick: spacing"), true);
  assert.equal(isNit("  > nit — trailing comma"), true);
});

test("isNit does not match Nit inside words or later in the text", () => {
  assert.equal(isNit("Nitrogen levels"), false);
  assert.equal(isNit("This is a nit"), false);
  assert.equal(isNit("Unit tests missing"), false);
});

const f = (nit: boolean, resolved: boolean) => ({ nit, resolved });

test("reviewStatus: no findings is summary only", () => {
  assert.equal(reviewStatus([]), "summary");
});

test("reviewStatus: every non-nit finding open is open", () => {
  assert.equal(reviewStatus([f(false, false), f(false, false), f(true, false)]), "open");
});

test("reviewStatus: mixed is partly", () => {
  assert.equal(reviewStatus([f(false, false), f(false, true)]), "partly");
});

test("reviewStatus: every non-nit finding resolved is addressed, nits ignored", () => {
  assert.equal(reviewStatus([f(false, true), f(true, false)]), "addressed");
});

test("reviewStatus: only nits, all unresolved, is addressed", () => {
  assert.equal(reviewStatus([f(true, false), f(true, false)]), "addressed");
});

test("overallStatus raises addressed or summary to partly when older reviews have open findings", () => {
  assert.equal(overallStatus("addressed", 1), "partly");
  assert.equal(overallStatus("summary", 2), "partly");
  assert.equal(overallStatus("addressed", 0), "addressed");
});

test("overallStatus never lowers open or partly", () => {
  assert.equal(overallStatus("open", 3), "open");
  assert.equal(overallStatus("partly", 1), "partly");
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test src/botreviews.test.ts`
Expected: FAIL with `Cannot find module` for `./botreviews.ts`.

- [ ] **Step 3: Write the status rules**

Create `src/botreviews.ts`:

```ts
// Pure logic for bot (PR Watcher) reviews: which actor is a bot, what counts as a nit,
// and how findings roll up into a status. No I/O, so `node --test` covers it.
import type { Finding, WatcherStatus } from "./types.ts";

/**
 * GraphQL reports bots with a bare login ("grok-pr-watcher") and `__typename: "Bot"`,
 * while config and the `reviews(author:)` filter use "grok-pr-watcher[bot]". Normalize
 * every actor to the "[bot]" form so the two can be compared.
 */
export function botLogin(author: { __typename?: string; login: string } | null | undefined): string | null {
  if (!author?.login) return null;
  const bare = author.login.replace(/\[bot\]$/i, "");
  const isBot = author.__typename === "Bot" || /\[bot\]$/i.test(author.login);
  return isBot ? `${bare}[bot]` : author.login;
}

/** A finding whose text starts with "Nit" (after any markdown decoration) is a nit. */
export function isNit(text: string): boolean {
  return /^[\s*_`#>\-]*nit(pick)?\b/i.test(text);
}

/** Status of one review from its findings. Nits are ignored; outdated threads are still open. */
export function reviewStatus(findings: Pick<Finding, "nit" | "resolved">[]): WatcherStatus {
  if (!findings.length) return "summary";
  const real = findings.filter((f) => !f.nit);
  const open = real.filter((f) => !f.resolved).length;
  if (open === 0) return "addressed";
  return open === real.length ? "open" : "partly";
}

const RANK: Record<WatcherStatus, number> = { summary: 0, addressed: 1, partly: 2, open: 3 };

/** A PR takes its latest review's status, but is at least "partly" if an older review still has open findings. */
export function overallStatus(latest: WatcherStatus, earlierOpen: number): WatcherStatus {
  return earlierOpen > 0 && RANK[latest] < RANK.partly ? "partly" : latest;
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --test src/botreviews.test.ts`
Expected: `ℹ pass 11`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/botreviews.ts src/botreviews.test.ts
git commit -m "feat: Watcher status rules (bot login, nits, review status)"
```

---

### Task 4: Shape raw reviews into a WatcherSummary; merge blockers

**Files:**
- Modify: `src/botreviews.ts`
- Test: `src/botreviews.test.ts`

**Interfaces:**
- Consumes: `sanitizeHtml` (Task 2), `isNit`, `reviewStatus`, `overallStatus` (Task 3).
- Produces:
  - `interface RawActor { __typename?: string; login: string }`
  - `interface RawBotReview { id: string; state: string; submittedAt: string | null; url: string; bodyHTML: string; author: RawActor | null; commit: { oid: string } | null }`
  - `interface RawThread { isResolved: boolean; isOutdated: boolean; path: string; line: number | null; comments: { totalCount: number; nodes: (RawRootComment | null)[] | null } | null }`
  - `interface RawRootComment { url: string; body: string; bodyHTML: string; author: RawActor | null; pullRequestReview: { id: string } | null }`
  - `shapeWatcher(reviews: RawBotReview[], threads: RawThread[], headOid: string | null): WatcherSummary | null`
  - `mergeBlockers(pr: Pick<PullRequest, "isDraft" | "review" | "ci" | "mergeable" | "mergeState" | "watcher">): string[]`

- [ ] **Step 1: Write the failing tests**

Append to `src/botreviews.test.ts` (add `mergeBlockers`, `shapeWatcher` and the raw types to the import):

```ts
import { botLogin, isNit, mergeBlockers, overallStatus, reviewStatus, shapeWatcher,
  type RawBotReview, type RawThread } from "./botreviews.ts";
```

```ts
// ---------------------------------------------------------------- shapeWatcher fixtures

function review(id: string, submittedAt: string, commit = "head1"): RawBotReview {
  return {
    id, state: "COMMENTED", submittedAt, url: `https://github.com/o/r/pull/1#pullrequestreview-${id}`,
    bodyHTML: `<h2>Grok PR Watcher review</h2><p dir="auto">Summary for ${id}</p>`,
    author: { __typename: "Bot", login: "grok-pr-watcher" }, commit: { oid: commit },
  };
}

function thread(reviewId: string, body: string, opts: Partial<RawThread> & { replies?: number; url?: string } = {}): RawThread {
  const { replies = 0, url = `https://github.com/o/r/pull/1#discussion_r${Math.random().toString(36).slice(2, 8)}`, ...rest } = opts;
  return {
    isResolved: false, isOutdated: false, path: "src/a.ts", line: 10,
    comments: {
      totalCount: replies + 1,
      nodes: [{ url, body, bodyHTML: `<p dir="auto">${body}</p>`, author: { __typename: "Bot", login: "grok-pr-watcher" },
        pullRequestReview: { id: reviewId } }],
    },
    ...rest,
  };
}

test("shapeWatcher returns null when there are no submitted reviews", () => {
  assert.equal(shapeWatcher([], [], "head1"), null);
  assert.equal(shapeWatcher([{ ...review("r1", ""), submittedAt: null }], [], "head1"), null);
});

test("shapeWatcher: review with no threads is summary only", () => {
  const w = shapeWatcher([review("r1", "2026-10-08T10:00:00Z")], [], "head1")!;
  assert.equal(w.status, "summary");
  assert.deepEqual([w.open, w.total, w.nits], [0, 0, 0]);
  assert.equal(w.latest.html, "<h3>Grok PR Watcher review</h3><p>Summary for r1</p>");
  assert.equal(w.earlier.length, 0);
});

test("shapeWatcher counts open and total non-nit findings and unresolved nits", () => {
  const threads = [
    thread("r1", "Bug here"),
    thread("r1", "Another bug", { isResolved: true }),
    thread("r1", "Nit: spacing"),
    thread("r1", "Nit: resolved one", { isResolved: true }),
  ];
  const w = shapeWatcher([review("r1", "2026-10-08T10:00:00Z")], threads, "head1")!;
  assert.equal(w.status, "partly");
  assert.deepEqual([w.open, w.total, w.nits], [1, 2, 1]);
});

test("shapeWatcher: outdated unresolved thread stays open and is flagged", () => {
  const w = shapeWatcher([review("r1", "2026-10-08T10:00:00Z")], [thread("r1", "x", { isOutdated: true })], "head1")!;
  assert.equal(w.status, "open");
  assert.equal(w.latest.findings[0].outdated, true);
  assert.equal(w.latest.findings[0].resolved, false);
});

test("shapeWatcher sorts open findings first, nits after non-nits", () => {
  const threads = [
    thread("r1", "Nit: a", { path: "a.ts" }),
    thread("r1", "done", { isResolved: true, path: "b.ts" }),
    thread("r1", "open one", { path: "c.ts" }),
  ];
  const w = shapeWatcher([review("r1", "2026-10-08T10:00:00Z")], threads, "head1")!;
  assert.deepEqual(w.latest.findings.map((f) => f.path), ["c.ts", "a.ts", "b.ts"]);
});

test("shapeWatcher records replies, a null line, and sanitized finding html", () => {
  const t = thread("r1", "Bug <script>x</script> here", { line: null, replies: 2, url: "https://github.com/o/r/pull/1#discussion_r1" });
  const w = shapeWatcher([review("r1", "2026-10-08T10:00:00Z")], [t], "head1")!;
  const f = w.latest.findings[0];
  assert.equal(f.replies, 2);
  assert.equal(f.line, null);
  assert.equal(f.url, "https://github.com/o/r/pull/1#discussion_r1");
  assert.equal(f.html, "<p>Bug  here</p>");
});

test("shapeWatcher ignores threads that belong to other reviews", () => {
  const other = thread("someone-else", "human comment");
  const w = shapeWatcher([review("r1", "2026-10-08T10:00:00Z")], [other], "head1")!;
  assert.equal(w.status, "summary");
});

test("shapeWatcher marks a review stale when its commit is not the head", () => {
  const w = shapeWatcher([review("r1", "2026-10-08T10:00:00Z", "old")], [], "head1")!;
  assert.equal(w.stale, true);
  assert.equal(w.latest.stale, true);
  assert.equal(shapeWatcher([review("r1", "2026-10-08T10:00:00Z", "head1")], [], "head1")!.stale, false);
  assert.equal(shapeWatcher([review("r1", "2026-10-08T10:00:00Z", "old")], [], null)!.stale, false);
});

test("shapeWatcher orders reviews newest first and lifts old open findings to partly", () => {
  const reviews = [review("old", "2026-10-01T10:00:00Z"), review("new", "2026-10-08T10:00:00Z")];
  const threads = [thread("old", "still open"), thread("new", "fixed", { isResolved: true })];
  const w = shapeWatcher(reviews, threads, "head1")!;
  assert.equal(w.latest.id, "new");
  assert.deepEqual(w.earlier.map((r) => r.id), ["old"]);
  assert.equal(w.latest.status, "addressed");
  assert.equal(w.status, "partly");
  assert.deepEqual([w.open, w.total], [1, 2]);
});

// ---------------------------------------------------------------- mergeBlockers

const base = { isDraft: false, review: null, ci: "SUCCESS" as const, mergeable: "MERGEABLE" as const, mergeState: "CLEAN" as const, watcher: null };
const withOpen = (open: number) => ({ status: "open" as const, open, total: open, nits: 0, stale: false,
  latest: {} as never, earlier: [] });

test("mergeBlockers: clean PR with no Watcher review is ready", () => {
  assert.deepEqual(mergeBlockers(base), []);
  assert.deepEqual(mergeBlockers({ ...base, ci: null }), []);
});

test("mergeBlockers lists each blocker in display order", () => {
  assert.deepEqual(
    mergeBlockers({ ...base, watcher: withOpen(2), isDraft: true, review: "CHANGES_REQUESTED", ci: "PENDING", mergeable: "CONFLICTING" }),
    ["2 open findings", "draft", "changes requested", "CI pending", "conflicts"],
  );
  assert.deepEqual(mergeBlockers({ ...base, watcher: withOpen(1), ci: "FAILURE" }), ["1 open finding", "CI failing"]);
});

test("mergeBlockers: UNKNOWN mergeability is not ready", () => {
  assert.deepEqual(mergeBlockers({ ...base, mergeable: "UNKNOWN" }), ["merge check pending"]);
});

test("mergeBlockers: branch protection states", () => {
  assert.deepEqual(mergeBlockers({ ...base, mergeState: "BLOCKED" }), ["blocked by branch rules"]);
  assert.deepEqual(mergeBlockers({ ...base, mergeState: "BEHIND" }), ["behind base"]);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test src/botreviews.test.ts`
Expected: FAIL. `shapeWatcher` and `mergeBlockers` are not exported.

- [ ] **Step 3: Implement `shapeWatcher` and `mergeBlockers`**

In `src/botreviews.ts`, change the imports to:

```ts
import { sanitizeHtml } from "./sanitize.ts";
import type { Finding, PullRequest, WatcherReview, WatcherStatus, WatcherSummary } from "./types.ts";
```

Append:

```ts
// ---------------------------------------------------------------- raw GraphQL shapes

export interface RawActor { __typename?: string; login: string }

export interface RawBotReview {
  id: string;
  state: string;
  submittedAt: string | null;
  url: string;
  bodyHTML: string;
  author: RawActor | null;
  commit: { oid: string } | null;
}

export interface RawRootComment {
  url: string;
  body: string;
  bodyHTML: string;
  author: RawActor | null;
  pullRequestReview: { id: string } | null;
}

export interface RawThread {
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  comments: { totalCount: number; nodes: (RawRootComment | null)[] | null } | null;
}

// ---------------------------------------------------------------- shaping

/** Open before resolved; within each group non-nits before nits; then by location. */
function findingOrder(a: Finding, b: Finding): number {
  return Number(a.resolved) - Number(b.resolved)
    || Number(a.nit) - Number(b.nit)
    || a.path.localeCompare(b.path)
    || (a.line ?? 0) - (b.line ?? 0);
}

/**
 * Turn a PR's bot reviews and review threads into the dashboard's summary.
 * A thread belongs to a review when its first comment's `pullRequestReview.id` matches;
 * threads from anyone else are ignored.
 */
export function shapeWatcher(reviews: RawBotReview[], threads: RawThread[], headOid: string | null): WatcherSummary | null {
  const submitted = reviews
    .filter((r): r is RawBotReview & { submittedAt: string } => !!r.submittedAt)
    .sort((a, b) => +new Date(b.submittedAt) - +new Date(a.submittedAt));
  if (!submitted.length) return null;

  const byReview = new Map<string, Finding[]>();
  for (const t of threads) {
    const root = t.comments?.nodes?.[0];
    const reviewId = root?.pullRequestReview?.id;
    if (!root || !reviewId) continue;
    const list = byReview.get(reviewId) ?? [];
    list.push({
      path: t.path,
      line: t.line,
      url: root.url,
      html: sanitizeHtml(root.bodyHTML),
      nit: isNit(root.body),
      resolved: t.isResolved,
      outdated: t.isOutdated,
      replies: Math.max(0, (t.comments?.totalCount ?? 1) - 1),
    });
    byReview.set(reviewId, list);
  }

  const shaped: WatcherReview[] = submitted.map((r) => {
    const findings = (byReview.get(r.id) ?? []).sort(findingOrder);
    const real = findings.filter((f) => !f.nit);
    const commit = r.commit?.oid ?? null;
    return {
      id: r.id,
      url: r.url,
      submittedAt: r.submittedAt,
      commit,
      html: sanitizeHtml(r.bodyHTML),
      status: reviewStatus(findings),
      open: real.filter((f) => !f.resolved).length,
      total: real.length,
      nits: findings.filter((f) => f.nit && !f.resolved).length,
      findings,
      stale: !!headOid && !!commit && commit !== headOid,
    };
  });

  const [latest, ...earlier] = shaped;
  const sum = (key: "open" | "total" | "nits") => shaped.reduce((n, r) => n + r[key], 0);
  return {
    status: overallStatus(latest.status, earlier.reduce((n, r) => n + r.open, 0)),
    open: sum("open"),
    total: sum("total"),
    nits: sum("nits"),
    stale: latest.stale,
    latest,
    earlier,
  };
}

// ---------------------------------------------------------------- mergeability

/**
 * Why a PR isn't ready to merge, in display order. Empty means "Ready to merge": no open
 * Watcher findings, not a draft, nobody requesting changes, CI passing or absent, GitHub
 * says MERGEABLE, and branch protection isn't holding it.
 */
export function mergeBlockers(
  pr: Pick<PullRequest, "isDraft" | "review" | "ci" | "mergeable" | "mergeState" | "watcher">,
): string[] {
  const out: string[] = [];
  const open = pr.watcher?.open ?? 0;
  if (open) out.push(`${open} open finding${open === 1 ? "" : "s"}`);
  if (pr.isDraft) out.push("draft");
  if (pr.review === "CHANGES_REQUESTED") out.push("changes requested");
  if (pr.ci === "FAILURE" || pr.ci === "ERROR") out.push("CI failing");
  else if (pr.ci === "PENDING" || pr.ci === "EXPECTED") out.push("CI pending");
  if (pr.mergeable === "CONFLICTING") out.push("conflicts");
  else if (pr.mergeable === "UNKNOWN") out.push("merge check pending");
  if (pr.mergeState === "BLOCKED") out.push("blocked by branch rules");
  else if (pr.mergeState === "BEHIND") out.push("behind base");
  return out;
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --test src/botreviews.test.ts`
Expected: `ℹ pass 24`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/botreviews.ts src/botreviews.test.ts
git commit -m "feat: shape Watcher reviews into a summary; merge blockers"
```

---

### Task 5: GitHub fetch: marker fields, batched Watcher query, wiring

**Files:**
- Modify: `src/github.ts`
- Test: `src/github.test.ts`

**Interfaces:**
- Consumes: `shapeWatcher`, `mergeBlockers`, `botLogin`, `RawBotReview`, `RawThread` (Tasks 3, 4); `Config.bot_reviews`, `Config.bot_reviewers` (Task 1).
- Produces:
  - `export interface Context { warnings: string[]; viewer: string | null; rate: RateLimit | null }` (now exported)
  - `export interface RawPR` (now exported) with `id`, `headRefOid`, `mergeable`, `mergeStateStatus`, `latestReviews`
  - `botReviewsQuery(botCount: number): string`
  - `hasBotReview(pr: Pick<RawPR, "latestReviews">, bots: Set<string>): boolean` (bots are lowercase `[bot]` logins)
  - `capWarning(name: string, total: number): string | null`
  - `interface BotReviewRaw { reviews: RawBotReview[]; threads: RawThread[]; threadTotal: number }`
  - `type BotFetcher = (token: string, ids: string[], bots: string[], ctx: Context) => Promise<Map<string, BotReviewRaw>>`
  - `attachBotReviews(cfg: Config, tokens: Pick<Tokens, "forOwner">, repos: Repo[], candidates: Map<string, string[]>, ctx: Context, fetcher?: BotFetcher): Promise<void>` where `candidates` maps lowercase owner → PR node ids.
  - `collect` now returns `botReviews` and fills `pr.watcher` and `pr.blockers`.

- [ ] **Step 1: Write the failing tests**

Create `src/github.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RawBotReview, RawThread } from "./botreviews.ts";
import { DEFAULTS, type Config } from "./config.ts";
import { VIEWER_QUERY, attachBotReviews, botReviewsQuery, capWarning, hasBotReview, type BotReviewRaw, type Context } from "./github.ts";
import type { PullRequest, Repo } from "./types.ts";

test("repo query carries the Watcher marker fields", () => {
  for (const field of ["id", "headRefOid", "mergeable", "mergeStateStatus", "latestReviews(first: 10)"]) {
    assert.ok(VIEWER_QUERY.includes(field), `missing ${field}`);
  }
});

test("botReviewsQuery has one aliased reviews field per bot", () => {
  const q = botReviewsQuery(2);
  assert.ok(q.includes("$ids: [ID!]!"));
  assert.ok(q.includes("$a0: String!") && q.includes("$a1: String!"));
  assert.ok(q.includes("b0: reviews(author: $a0, last: 10)"));
  assert.ok(q.includes("b1: reviews(author: $a1, last: 10)"));
  assert.ok(q.includes("nodes(ids: $ids)"));
  assert.ok(q.includes("reviewThreads(first: 50)"));
  assert.ok(q.includes("pullRequestReview { id }"));
});

test("hasBotReview matches the bare GraphQL login against the [bot] config form", () => {
  const bots = new Set(["grok-pr-watcher[bot]"]);
  assert.equal(hasBotReview({ latestReviews: { nodes: [{ author: { __typename: "Bot", login: "grok-pr-watcher" } }] } }, bots), true);
  assert.equal(hasBotReview({ latestReviews: { nodes: [{ author: { __typename: "User", login: "len" } }] } }, bots), false);
  assert.equal(hasBotReview({ latestReviews: { nodes: [{ author: null }] } }, bots), false);
  assert.equal(hasBotReview({ latestReviews: null }, bots), false);
});

test("capWarning only fires past the thread cap", () => {
  assert.equal(capWarning("o/r#1", 50), null);
  assert.equal(capWarning("o/r#1", 51), "o/r#1: only the first 50 of 51 review threads were checked.");
});

// ---------------------------------------------------------------- attachBotReviews

function fakePr(id: string, number: number): PullRequest {
  return {
    id, number, title: "t", url: `https://github.com/o/r/pull/${number}`, isDraft: false,
    createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z", head: "f", base: "main",
    review: null, ci: "SUCCESS", additions: 1, deletions: 1, comments: 0, author: "len", authorUrl: null,
    avatar: null, labels: [], requestedReviewers: [], requestedTeams: [], isMine: false, reviewRequestedFromMe: false,
    headOid: "head1", mergeable: "MERGEABLE", mergeState: "CLEAN", watcher: null, blockers: [],
  };
}

function fakeRepo(prs: PullRequest[]): Repo {
  return { name: "o/r", url: "https://github.com/o/r", description: null, isPrivate: false, isArchived: false,
    isFork: false, pushedAt: null, language: null, languageColor: null, openCount: prs.length, prs };
}

const ctx = (): Context => ({ warnings: [], viewer: "len", rate: null });
const tokens = { forOwner: async () => "token" };
const cfg: Config = { ...DEFAULTS };

const rawReview: RawBotReview = {
  id: "r1", state: "COMMENTED", submittedAt: "2026-10-08T10:00:00Z", url: "https://github.com/o/r/pull/1#pullrequestreview-1",
  bodyHTML: "<p>sum</p>", author: { __typename: "Bot", login: "grok-pr-watcher" }, commit: { oid: "head1" },
};
const rawThread: RawThread = {
  isResolved: false, isOutdated: false, path: "a.ts", line: 3,
  comments: { totalCount: 1, nodes: [{ url: "https://github.com/o/r/pull/1#discussion_r1", body: "bug", bodyHTML: "<p>bug</p>",
    author: { __typename: "Bot", login: "grok-pr-watcher" }, pullRequestReview: { id: "r1" } }] },
};

test("attachBotReviews fills watcher for fetched PRs and warns past the cap", async () => {
  const pr = fakePr("PR_1", 1);
  const repos = [fakeRepo([pr, fakePr("PR_2", 2)])];
  const c = ctx();
  const seen: { token: string; ids: string[]; bots: string[] }[] = [];
  const fetcher = async (token: string, ids: string[], bots: string[]): Promise<Map<string, BotReviewRaw>> => {
    seen.push({ token, ids, bots });
    return new Map([["PR_1", { reviews: [rawReview], threads: [rawThread], threadTotal: 60 }]]);
  };
  await attachBotReviews(cfg, tokens, repos, new Map([["o", ["PR_1"]]]), c, fetcher);
  assert.deepEqual(seen, [{ token: "token", ids: ["PR_1"], bots: ["grok-pr-watcher[bot]"] }]);
  assert.equal(pr.watcher?.status, "open");
  assert.deepEqual([pr.watcher?.open, pr.watcher?.total], [1, 1]);
  assert.equal(repos[0].prs[1].watcher, null);
  assert.deepEqual(c.warnings, ["o/r#1: only the first 50 of 60 review threads were checked."]);
});

test("attachBotReviews turns a failed fetch into a warning and leaves PRs intact", async () => {
  const pr = fakePr("PR_1", 1);
  const c = ctx();
  const fetcher = async (): Promise<Map<string, BotReviewRaw>> => { throw new Error("rate limited"); };
  await attachBotReviews(cfg, tokens, [fakeRepo([pr])], new Map([["o", ["PR_1"]]]), c, fetcher);
  assert.equal(pr.watcher, null);
  assert.deepEqual(c.warnings, ["Watcher reviews unavailable for o: rate limited"]);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test src/github.test.ts`
Expected: FAIL. `attachBotReviews`, `botReviewsQuery`, `capWarning`, `hasBotReview` are not exported.

- [ ] **Step 3: Add the marker fields to the repo fragment**

In `src/github.ts`, inside `REPO_FRAGMENT`'s `pullRequests { nodes { ... } }`, add after `number`:

```graphql
      id
      headRefOid
      mergeable
      mergeStateStatus
      latestReviews(first: 10) { nodes { author { __typename login } } }
```

Add to the constants at the top:

```ts
const BOT_BATCH = 20;     // PRs per nodes(ids:) query
const THREAD_CAP = 50;    // review threads fetched per PR
```

Update imports:

```ts
import { botLogin, mergeBlockers, shapeWatcher, type RawBotReview, type RawThread } from "./botreviews.ts";
import { DashError, type Config, type Tokens } from "./config.ts";
import type {
  CheckState, DashboardData, MergeStateStatus, MergeableState, PullRequest, RateLimit, Repo, ReviewDecision,
} from "./types.ts";
import { globToRegExp } from "./views.ts";
```

- [ ] **Step 4: Extend `RawPR`, export it and `Context`**

Change `interface RawPR` to `export interface RawPR` and add after `number: number;`:

```ts
  id: string;
  headRefOid: string | null;
  mergeable: MergeableState | null;
  mergeStateStatus: MergeStateStatus | null;
  latestReviews: { nodes: ({ author: { __typename?: string; login: string } | null } | null)[] | null } | null;
```

Change `interface Context` to `export interface Context`.

- [ ] **Step 5: Add the batched query and fetcher**

After `explicitQuery`, add:

```ts
/** One `nodes(ids:)` query that fetches every configured bot's reviews plus all review threads. */
export function botReviewsQuery(botCount: number): string {
  const decls = ["$ids: [ID!]!"];
  const fields: string[] = [];
  for (let i = 0; i < botCount; i++) {
    decls.push(`$a${i}: String!`);
    fields.push(`b${i}: reviews(author: $a${i}, last: 10) { nodes { id state submittedAt url bodyHTML author { __typename login } commit { oid } } }`);
  }
  return `query(${decls.join(", ")}) {
  nodes(ids: $ids) {
    ... on PullRequest {
      id
      ${fields.join("\n      ")}
      reviewThreads(first: ${THREAD_CAP}) {
        totalCount
        nodes {
          isResolved isOutdated path line
          comments(first: 1) {
            totalCount
            nodes { url body bodyHTML author { __typename login } pullRequestReview { id } }
          }
        }
      }
    }
  }
  rateLimit { limit remaining resetAt }
}`;
}
```

After the `fetchExplicit` function, add:

```ts
// --------------------------------------------------------------------------- bot reviews

export interface BotReviewRaw {
  reviews: RawBotReview[];
  threads: RawThread[];
  threadTotal: number;
}

export type BotFetcher = (token: string, ids: string[], bots: string[], ctx: Context) => Promise<Map<string, BotReviewRaw>>;

interface RawBotNode {
  id: string;
  reviewThreads: { totalCount: number; nodes: (RawThread | null)[] | null } | null;
  [alias: string]: unknown;
}

/** Does this PR's latest-review-per-author list include one of the configured bots? */
export function hasBotReview(pr: Pick<RawPR, "latestReviews">, bots: Set<string>): boolean {
  return (pr.latestReviews?.nodes ?? []).some((n) => {
    const login = botLogin(n?.author);
    return !!login && bots.has(login.toLowerCase());
  });
}

export function capWarning(name: string, total: number): string | null {
  return total > THREAD_CAP ? `${name}: only the first ${THREAD_CAP} of ${total} review threads were checked.` : null;
}

/** Fetch bot reviews and review threads for a list of PR node ids, BOT_BATCH at a time. */
export async function fetchBotReviews(token: string, ids: string[], bots: string[], ctx: Context): Promise<Map<string, BotReviewRaw>> {
  const out = new Map<string, BotReviewRaw>();
  const query = botReviewsQuery(bots.length);
  for (let start = 0; start < ids.length; start += BOT_BATCH) {
    const batch = ids.slice(start, start + BOT_BATCH);
    const variables: Record<string, unknown> = { ids: batch };
    bots.forEach((b, i) => { variables[`a${i}`] = b; });
    const { data, errors } = await graphql(token, query, variables);
    ctx.warnings.push(...errors);
    ctx.rate = data.rateLimit ?? ctx.rate;
    for (const node of (data.nodes as (RawBotNode | null)[] | undefined) ?? []) {
      if (!node) continue;
      const reviews: RawBotReview[] = [];
      bots.forEach((_, i) => {
        const conn = node[`b${i}`] as { nodes: (RawBotReview | null)[] | null } | null | undefined;
        for (const r of conn?.nodes ?? []) if (r) reviews.push(r);
      });
      const threads = (node.reviewThreads?.nodes ?? []).filter((t): t is RawThread => !!t);
      out.set(node.id, { reviews, threads, threadTotal: node.reviewThreads?.totalCount ?? threads.length });
    }
  }
  return out;
}

/**
 * Attach Watcher summaries to the PRs in `candidates` (lowercase owner → PR node ids), one
 * token per owner. A failed fetch becomes a warning so the dashboard still loads.
 */
export async function attachBotReviews(
  cfg: Config, tokens: Pick<Tokens, "forOwner">, repos: Repo[], candidates: Map<string, string[]>,
  ctx: Context, fetcher: BotFetcher = fetchBotReviews,
): Promise<void> {
  const prById = new Map<string, { pr: PullRequest; repo: Repo }>();
  for (const repo of repos) for (const pr of repo.prs) prById.set(pr.id, { pr, repo });
  for (const [owner, ids] of candidates) {
    let got: Map<string, BotReviewRaw>;
    try {
      got = await fetcher(await tokens.forOwner(owner), ids, cfg.bot_reviewers, ctx);
    } catch (e) {
      ctx.warnings.push(`Watcher reviews unavailable for ${owner}: ${(e as Error).message}`);
      continue;
    }
    for (const [id, raw] of got) {
      const hit = prById.get(id);
      if (!hit) continue;
      hit.pr.watcher = shapeWatcher(raw.reviews, raw.threads, hit.pr.headOid);
      const warn = capWarning(`${hit.repo.name}#${hit.pr.number}`, raw.threadTotal);
      if (warn) ctx.warnings.push(warn);
    }
  }
}
```

Note `QueryData` has an index signature (`[alias: string]: unknown`), so `data.nodes` type-checks as `unknown` and the cast above is needed.

- [ ] **Step 6: Wire it into `collect` and `shapePr`**

In `collect`, change the return type to `Promise<Omit<DashboardData, "fetchMs" | "generatedAt" | "refreshSeconds">>` (unchanged) and make the result include `botReviews`. Replace the final block from `const excludes = ...` to the `return` with:

```ts
  const excludes = cfg.exclude.map(globToRegExp);
  const botsOn = cfg.bot_reviews && cfg.bot_reviewers.length > 0;
  const bots = new Set(cfg.bot_reviewers.map((b) => b.toLowerCase()));
  const candidates = new Map<string, string[]>(); // lowercase owner → PR node ids with a bot review
  const result: Repo[] = [];
  for (const [key, node] of repos) {
    if (!explicit.has(key)) {
      if (excludes.some((re) => re.test(key))) continue;
      if (node.isArchived && !cfg.include_archived) continue;
      if (node.isFork && !cfg.include_forks) continue;
    }
    result.push(shapeRepo(node, ctx.viewer));
    if (!botsOn) continue;
    const owner = key.split("/")[0];
    for (const raw of node.pullRequests.nodes ?? []) {
      if (raw && hasBotReview(raw, bots)) candidates.set(owner, [...(candidates.get(owner) ?? []), raw.id]);
    }
  }
  if (candidates.size) await attachBotReviews(cfg, tokens, result, candidates, ctx);
  for (const repo of result) for (const pr of repo.prs) pr.blockers = mergeBlockers(pr);

  const warnings = [...new Set(ctx.warnings.filter((w) => !w.includes("Could not resolve to a RepositoryOwner")))].sort();
  return { viewer: ctx.viewer, rateLimit: ctx.rate, warnings, repos: result, botReviews: cfg.bot_reviews };
```

In `shapePr`, add to the returned object after `reviewRequestedFromMe`:

```ts
    id: pr.id,
    headOid: pr.headRefOid ?? null,
    mergeable: pr.mergeable ?? null,
    mergeState: pr.mergeStateStatus ?? null,
    watcher: null,
    blockers: [],
```

- [ ] **Step 7: Run all tests and the type check**

Run: `npm test && npm run check`
Expected: `ℹ pass 47`, `ℹ fail 0` (5 config + 12 sanitize + 24 botreviews + 6 github), and `tsc` exits 0 with no output.

- [ ] **Step 8: Check against live GitHub**

Run the server on a spare port and inspect one PR (needs `gh auth status` logged in and a `config.json` or default `mine: true`):

```bash
node server.ts --port 8790 &
sleep 1
curl -s 'http://127.0.0.1:8790/api/prs?refresh=1' | python3 -c '
import json,sys
d=json.load(sys.stdin)
print("botReviews:", d["botReviews"], "warnings:", d["warnings"])
for r in d["repos"]:
  for p in r["prs"]:
    w=p.get("watcher")
    if w: print(r["name"], "#"+str(p["number"]), w["status"], str(w["open"])+"/"+str(w["total"])+" open", w["nits"], "nits", "stale" if w["stale"] else "", "| blockers:", p["blockers"])
'
kill %1
```

Expected: at least one line like `Ascera-life/ascera-mobile #368 open 3/3 open 1 nits  | blockers: ['3 open findings']`, and `botReviews: True`. `warnings` should not mention "Watcher reviews unavailable". If every PR shows `watcher: null`, check that `latestReviews` in the response includes a `Bot` author and that `config.json` doesn't set `bot_reviews: false`.

- [ ] **Step 9: Commit**

```bash
git add src/github.ts src/github.test.ts
git commit -m "feat: fetch Watcher reviews in a batched second query"
```

---

### Task 6: Browser filter: toggle, `watcher:` search tokens, summary chip

**Files:**
- Modify: `static/lib/state.ts`
- Modify: `static/index.html`
- Modify: `static/app.ts`

**Interfaces:**
- Consumes: `PullRequest.watcher`, `DashboardData.botReviews` (Task 1).
- Produces: `ToggleKey` includes `"onlyWatcher"`; `state.onlyWatcher: boolean`; `state.openPanels: Set<string>`; `state.expandedBodies: Set<string>` (both used by Task 7); `watcherMatch(pr: PullRequest, value: string): boolean` (exported for clarity, not used elsewhere).

- [ ] **Step 1: Extend state**

In `static/lib/state.ts`:

```ts
export type ToggleKey = "hideDrafts" | "onlyReview" | "onlyMine" | "showEmpty" | "onlyWatcher";
```

Add to `State` after `showEmpty: boolean;`:

```ts
  onlyWatcher: boolean;   // only PRs with open Watcher findings
```

and after `expanded: Set<string>;`:

```ts
  openPanels: Set<string>;     // PR urls whose Watcher panel is open (not persisted)
  expandedBodies: Set<string>; // review ids whose summary is fully shown (not persisted)
```

Add to the `state` object:

```ts
  onlyWatcher: store.get("onlyWatcher", false),
  openPanels: new Set(),
  expandedBodies: new Set(),
```

- [ ] **Step 2: Add the search tokens and toggle to filtering**

Replace `prVisible` and the start of `compute` in `static/lib/state.ts`:

```ts
/**
 * `watcher:<value>` search tokens. "open" = has open findings, "none" = no Watcher review,
 * otherwise the PR's overall status ("addressed", "partly", "summary").
 */
export function watcherMatch(pr: PullRequest, value: string): boolean {
  const w = pr.watcher;
  switch (value) {
    case "open": return !!w && w.open > 0;
    case "none": return !w;
    case "addressed": case "partly": case "summary": return w?.status === value;
    default: return true; // unknown value: don't filter anything out
  }
}

function prVisible(pr: PullRequest, repo: Repo, terms: string[]): boolean {
  if (state.hideDrafts && pr.isDraft) return false;
  if (state.onlyReview && !pr.reviewRequestedFromMe) return false;
  if (state.onlyMine && !pr.isMine) return false;
  if (state.onlyWatcher && !(pr.watcher && pr.watcher.open > 0)) return false;
  if (!terms.length) return true;
  const hay = [repo.name, pr.title, "#" + pr.number, pr.author, pr.head ?? "", pr.base ?? "",
    ...pr.labels.map((l) => l.name)].join(" ").toLowerCase();
  return terms.every((t) => (t.startsWith("watcher:") ? watcherMatch(pr, t.slice("watcher:".length)) : hay.includes(t)));
}
```

In `compute`, after `const q = state.filter.trim().toLowerCase();` add:

```ts
  const terms = q ? q.split(/\s+/) : [];
```

Change `const prFilterOn = !!q || state.hideDrafts || state.onlyReview || state.onlyMine;` to:

```ts
  const prFilterOn = !!q || state.hideDrafts || state.onlyReview || state.onlyMine || state.onlyWatcher;
```

Change `const prs = repo.prs.filter((pr) => prVisible(pr, repo, q));` to:

```ts
    const prs = repo.prs.filter((pr) => prVisible(pr, repo, terms));
```

- [ ] **Step 3: Add the toggle and placeholder hint**

In `static/index.html`, change the filter placeholder to:

```html
<input id="filter" type="search" placeholder="Filter repos, titles, authors, labels, watcher:open…  ( / )" autocomplete="off">
```

and add after the "Only mine" label:

```html
      <label id="t-watcher-label"><input type="checkbox" id="t-watcher"> Only open Watcher findings</label>
```

- [ ] **Step 4: Bind the toggle and add the summary chip**

In `static/app.ts`, add to `els`:

```ts
  watcher: byId<HTMLInputElement>("t-watcher"),
  watcherLabel: byId("t-watcher-label"),
```

After `bindToggle(els.showEmpty, "showEmpty");`:

```ts
bindToggle(els.watcher, "onlyWatcher");
```

In `renderSummary`, after the `drafts` chip in the `chips` array:

```ts
  ];
  if (c.botReviews) {
    const open = prs.reduce((n, p) => n + (p.watcher?.open ?? 0), 0);
    chips.push(stat(open, "open Watcher findings", open ? "attn" : ""));
  }
```

(`prs` is already `c.repos.flatMap((r) => r.prs)` at the top of `renderSummary`.) In `render()`, after `renderOwnerFilter(c);` add:

```ts
  els.watcherLabel.hidden = !c.botReviews;
```

Add `botReviews: boolean;` to the `Computed` interface in `state.ts` (comment: `// bot_reviews is on, so Watcher chrome should show`) and set it in `compute`'s return: `botReviews: data.botReviews,`.

- [ ] **Step 5: Type check and try it**

Run: `npm run check` → exits 0.

Run `node server.ts --port 8790`, open http://localhost:8790, and check:
- The "Only open Watcher findings" toggle appears and, when on, hides PRs without open findings. The summary shows "N match filters".
- Typing `watcher:open` in the filter does the same; `watcher:none` shows only PRs without a Watcher review; `watcher:addressed` shows addressed ones.
- The summary bar has an "N open Watcher findings" chip.
- Setting `"bot_reviews": false` in `config.json` and pressing Refresh hides the toggle and the chip.

- [ ] **Step 6: Commit**

```bash
git add static/lib/state.ts static/index.html static/app.ts
git commit -m "feat: Watcher filter toggle, watcher: search tokens, summary chip"
```

---

### Task 7: List row: badges, mergeable indicator, collapsible panel

**Files:**
- Create: `static/lib/watcher.ts`
- Modify: `static/lib/dom.ts`
- Modify: `static/lib/list.ts`
- Modify: `static/style.css`

**Interfaces:**
- Consumes: `Finding`, `PullRequest`, `WatcherReview`, `WatcherStatus` types (Task 1); `state.openPanels`, `state.expandedBodies`, `hooks.render` (Task 6); `h`, `link`, `ago` from `dom.ts`.
- Produces:
  - `html(cls: string, markup: string): HTMLDivElement` in `dom.ts`
  - `STATUS_LABEL: Record<WatcherStatus, string>`
  - `watcherBadges(pr: PullRequest): HTMLElement[]`
  - `mergeIndicator(pr: PullRequest): HTMLElement`
  - `watcherPanel(pr: PullRequest): HTMLElement | null`
  - `watcherDot(pr: PullRequest): HTMLElement | null` (used by Task 8)

- [ ] **Step 1: Add the `html` helper**

In `static/lib/dom.ts`, after `link`:

```ts
/**
 * Render HTML the server already sanitized (src/sanitize.ts: GitHub's bodyHTML through a
 * strict allowlist). Never pass anything else here; everything else goes through h().
 */
export function html(cls: string, markup: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = cls;
  el.innerHTML = markup;
  return el;
}
```

- [ ] **Step 2: Create the Watcher render module**

Create `static/lib/watcher.ts`:

```ts
// Watcher (bot review) chrome shared by the list and grid layouts: status badges, the
// mergeable indicator, the grid status dot, and the collapsible review panel.
import type { Finding, PullRequest, WatcherReview, WatcherStatus } from "../../src/types.ts";
import { ago, h, html, link } from "./dom.ts";
import { hooks, state } from "./state.ts";

export const STATUS_LABEL: Record<WatcherStatus, string> = {
  open: "open",
  partly: "partly addressed",
  addressed: "addressed",
  summary: "summary only",
};

/** A review body with more blocks than this is clamped until "Show more" is clicked. */
const CLAMP_BLOCKS = 8;

const countLabel = (open: number, total: number, status: WatcherStatus): string =>
  open ? `${open}/${total} open` : STATUS_LABEL[status];

/** Status badge, nits badge and "new commits" chip for a PR row. Empty without a Watcher review. */
export function watcherBadges(pr: PullRequest): HTMLElement[] {
  const w = pr.watcher;
  if (!w) return [];
  const out = [h("span", { class: `badge w-${w.status}`, title: `Watcher: ${STATUS_LABEL[w.status]}` },
    "Watcher: ", countLabel(w.open, w.total, w.status))];
  if (w.nits) out.push(h("span", { class: "badge nits", title: "Nits never count toward open findings" },
    `${w.nits} nit${w.nits === 1 ? "" : "s"}`));
  if (w.stale) out.push(h("span", { class: "badge stale", title: "The PR has new commits since the latest Watcher review" },
    "new commits"));
  return out;
}

/** Small colored dot for the grid layout. */
export function watcherDot(pr: PullRequest): HTMLElement | null {
  const w = pr.watcher;
  if (!w) return null;
  return h("span", { class: `wdot ${w.status}`, title: `Watcher: ${countLabel(w.open, w.total, w.status)}` });
}

/** Green "Ready to merge", or gray with what's blocking. Shown for every PR. */
export function mergeIndicator(pr: PullRequest): HTMLElement {
  const ready = pr.blockers.length === 0;
  return h("span", {
    class: "merge " + (ready ? "ready" : "blocked"),
    title: ready ? "Watcher clear, mergeable, CI passing, not a draft, no changes requested" : "Blocking: " + pr.blockers.join(", "),
  }, h("span", { class: "dot" }), ready ? "Ready to merge" : pr.blockers.join(" · "));
}

/** Collapsible panel under a list row: latest review, then earlier ones. Closed by default. */
export function watcherPanel(pr: PullRequest): HTMLElement | null {
  const w = pr.watcher;
  if (!w) return null;
  const key = pr.url;
  return h("details", {
    class: "wpanel",
    open: state.openPanels.has(key),
    ontoggle: (e: Event) => {
      if ((e.currentTarget as HTMLDetailsElement).open) state.openPanels.add(key);
      else state.openPanels.delete(key);
    },
  },
    h("summary", null, "Watcher review", h("span", { class: "muted" }, ` · ${ago(w.latest.submittedAt)}`),
      w.earlier.length ? h("span", { class: "muted" }, ` · ${w.earlier.length} earlier`) : null),
    reviewBlock(w.latest),
    w.earlier.length
      ? h("details", { class: "wearlier" },
        h("summary", null, `Earlier reviews (${w.earlier.length})`),
        w.earlier.map(reviewBlock))
      : null,
  );
}

const blockCount = (markup: string): number => (markup.match(/<(p|li|h3|h4|pre|tr|blockquote)>/g) ?? []).length;

function reviewBlock(r: WatcherReview): HTMLElement {
  const long = blockCount(r.html) > CLAMP_BLOCKS;
  const expanded = state.expandedBodies.has(r.id);
  return h("div", { class: "wreview" },
    h("div", { class: "wreview-head" },
      h("span", { class: `badge w-${r.status}` }, countLabel(r.open, r.total, r.status)),
      r.nits ? h("span", { class: "badge nits" }, `${r.nits} nit${r.nits === 1 ? "" : "s"}`) : null,
      r.stale ? h("span", { class: "badge stale" }, "new commits since") : null,
      h("span", { class: "muted", title: new Date(r.submittedAt).toLocaleString() }, ago(r.submittedAt)),
      link(r.url, { class: "muted" }, "view on GitHub ↗"),
    ),
    html("md" + (long && !expanded ? " clamped" : ""), r.html),
    long ? h("button", {
      type: "button", class: "linkish",
      onclick: () => {
        if (expanded) state.expandedBodies.delete(r.id);
        else state.expandedBodies.add(r.id);
        hooks.render();
      },
    }, expanded ? "Show less" : "Show more") : null,
    r.findings.length
      ? h("ul", { class: "findings" }, r.findings.map(findingRow))
      : h("div", { class: "muted fnone" }, "No inline findings."),
  );
}

function findingRow(f: Finding): HTMLElement {
  const [cls, mark, label] = f.resolved
    ? ["resolved", "✓", "resolved"]
    : f.outdated ? ["outdated", "↻", "open; the code changed since"] : ["open", "●", "open"];
  return h("li", { class: "finding f-" + cls },
    h("span", { class: "fmark", title: label, "aria-label": label }, mark),
    link(f.url, { class: "floc" }, f.path + (f.line === null ? "" : ":" + f.line)),
    f.nit ? h("span", { class: "badge nits" }, "nit") : null,
    html("ftext md", f.html),
    f.replies ? h("span", { class: "muted freplies" }, `${f.replies} repl${f.replies === 1 ? "y" : "ies"}`) : null,
  );
}
```

- [ ] **Step 3: Use it in the list row**

In `static/lib/list.ts`, add the import:

```ts
import { mergeIndicator, watcherBadges, watcherPanel } from "./watcher.ts";
```

In `renderPr`, after the `review ? h("span", { class: "badge " + review[0] }, review[1]) : null,` line inside `pr-title-row`, add:

```ts
        ...watcherBadges(pr),
```

At the top of the `pr-side` div, before the `pr.ci ?` line:

```ts
      mergeIndicator(pr),
```

After the closing of the `pr-side` div (as the last child of the `li`):

```ts
    watcherPanel(pr),
```

- [ ] **Step 4: Styles**

Append to `static/style.css`:

```css
/* ---------- Watcher reviews ---------- */
.badge.w-open { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, transparent); }
.badge.w-partly { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 45%, transparent); }
.badge.w-addressed { color: var(--green); border-color: color-mix(in srgb, var(--green) 45%, transparent); }
.badge.w-summary { color: var(--muted); }
.badge.nits { color: var(--muted); background: var(--panel-2); }
.badge.stale { color: var(--amber); border-style: dashed; }

.merge { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; font-size: 12px; max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
.merge .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
.merge.ready { color: var(--green); font-weight: 600; }
.merge.ready .dot { background: var(--green); }
.merge.blocked { color: var(--muted); }

.wpanel { grid-column: 1 / -1; margin-top: 4px; font-size: 13px; }
.wpanel > summary { cursor: pointer; color: var(--muted); font-size: 12.5px; user-select: none; }
.wpanel > summary:hover { color: var(--text); }
.wreview { margin: 8px 0 0; padding: 10px 12px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; }
.wreview-head { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; margin-bottom: 8px; font-size: 12.5px; }
.wearlier { margin-top: 8px; }
.wearlier > summary { cursor: pointer; color: var(--muted); font-size: 12.5px; }

.md { line-height: 1.5; overflow-wrap: anywhere; }
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md p, .md ul, .md ol, .md blockquote, .md pre, .md table { margin: 6px 0; }
.md h3, .md h4 { margin: 10px 0 4px; font-size: 13.5px; }
.md ul, .md ol { padding-left: 20px; }
.md code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--panel); padding: 1px 5px; border-radius: 4px; }
.md pre { background: var(--panel); padding: 8px 10px; border-radius: 6px; overflow: auto; }
.md pre code { padding: 0; background: none; }
.md blockquote { border-left: 3px solid var(--border); padding-left: 10px; color: var(--muted); }
.md table { border-collapse: collapse; }
.md th, .md td { border: 1px solid var(--border); padding: 3px 8px; }
.md a { color: var(--accent); }
.md.clamped { max-height: 240px; overflow: hidden; position: relative; }
.md.clamped::after {
  content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 48px;
  background: linear-gradient(to bottom, transparent, var(--panel-2));
}
.wreview .linkish { margin-top: 4px; font-size: 12.5px; }

.findings { list-style: none; margin: 10px 0 0; padding: 0; border-top: 1px solid var(--border); }
.finding { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; padding: 6px 0; border-bottom: 1px solid var(--border); }
.finding:last-child { border-bottom: 0; }
.fmark { flex: none; width: 14px; text-align: center; font-size: 12px; }
.f-open .fmark { color: var(--red); }
.f-outdated .fmark { color: var(--amber); }
.f-resolved .fmark { color: var(--green); }
.f-resolved .ftext { color: var(--muted); }
.floc { font: 11.5px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--accent); }
.ftext { flex: 1 1 100%; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
.ftext p { margin: 0; display: inline; }
.freplies { font-size: 12px; }
.fnone { margin-top: 8px; font-size: 12.5px; }
```

The 240px cap is about 12 lines at this font size (14px × 1.5 line height = 21px per line, minus paragraph gaps).

- [ ] **Step 5: Type check and try it**

Run: `npm run check` → exits 0.

Run `node server.ts --port 8790`, open http://localhost:8790 in the list layout, and check on a PR with a Watcher review:
- The title row shows `Watcher: 3/4 open` (red), `1 nit` (gray) and `new commits` (amber, dashed) badges as applicable.
- The right column shows either green "Ready to merge" or gray "2 open findings · CI pending".
- A "Watcher review · 3h ago" line under the row expands to the summary (rendered headings, lists, code) and a findings list with ● / ✓ / ↻ marks, `path:line` links to the comment, and reply counts. A file-level finding shows just the path.
- Long summaries are cut with a fade and a "Show more" button; clicking it expands and the state survives a Refresh.
- Opening a panel, then pressing `r`, keeps the panel open.
- "Earlier reviews (n)" appears only when there is more than one review.
- Check with the browser dev tools that no `<script>`, `class=` or `onclick=` attributes exist inside `.md` elements.

- [ ] **Step 6: Commit**

```bash
git add static/lib/watcher.ts static/lib/dom.ts static/lib/list.ts static/style.css
git commit -m "feat: Watcher badges, mergeable indicator and review panel in the list layout"
```

---

### Task 8: Grid card: status dot and open-findings stat

**Files:**
- Modify: `static/lib/grid.ts`
- Modify: `static/style.css`

**Interfaces:**
- Consumes: `watcherDot(pr)` (Task 7); `PullRequest.watcher`.

- [ ] **Step 1: Add the stat and dot**

In `static/lib/grid.ts`, add the import:

```ts
import { watcherDot } from "./watcher.ts";
```

In `card`, after `const drafts = ...` add:

```ts
  const watcher = prs.filter((p) => (p.watcher?.open ?? 0) > 0).length;
```

and in the `stats` array, after the `failing` entry:

```ts
    watcher ? h("span", { class: "gstat bad" }, `${watcher} with open Watcher findings`) : null,
```

In `row`, inside `gpr-meta` after `h("span", null, pr.author),` add:

```ts
        watcherDot(pr),
```

- [ ] **Step 2: Style the dot**

Append to `static/style.css`:

```css
.wdot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; background: var(--muted); flex: none; }
.wdot.open { background: var(--red); }
.wdot.partly { background: var(--amber); }
.wdot.addressed { background: var(--green); }
```

- [ ] **Step 3: Type check and try it**

Run: `npm run check` → exits 0.

Run `node server.ts --port 8790`, press `g` for the grid, and check: PR rows with a Watcher review show a red / amber / green / gray dot after the author with a tooltip like "Watcher: 3/4 open"; cards with such PRs show "N with open Watcher findings" among the stats.

- [ ] **Step 4: Commit**

```bash
git add static/lib/grid.ts static/style.css
git commit -m "feat: Watcher status dot and stat in the grid layout"
```

---

### Task 9: README and CI workflow

**Files:**
- Modify: `README.md`
- Create: `.github/workflows/check.yml`

- [ ] **Step 1: Document the feature**

In `README.md`:

Add to the feature bullets, after the CI status bullet:

```markdown
- **PR Watcher reviews**: each Grok PR Watcher review with a status (open, partly addressed, addressed, summary only), a nits count, a "new commits" marker, and a per-PR "Ready to merge" indicator
```

Add a section after "## Layouts and shortcuts":

````markdown
## Watcher reviews

When a PR has a review from a configured bot (by default `grok-pr-watcher[bot]`), its row shows a `Watcher: 3/4 open` badge. The count is open findings over all non-nit findings across that PR's Watcher reviews. Each review, and the PR as a whole, has one of four statuses:

| status | meaning | color |
| --- | --- | --- |
| Open | every non-nit finding is still open | red |
| Partly addressed | some findings open, some resolved; or an older review still has open findings | yellow |
| Addressed | every non-nit finding is resolved | green |
| Summary only | the review has no inline findings | gray |

A finding is a review thread the bot opened. It counts as open until the thread is **resolved** on GitHub. A thread GitHub marks as outdated (the code under it changed) is still open and shows ↻. Findings whose text starts with "Nit" never count toward Open; they get their own gray `2 nits` badge. A `new commits` chip means the PR's head moved since the latest review.

Click **Watcher review** under a row to see the summary (GitHub's rendered markdown, passed through a strict allowlist on the server), the findings with `path:line` links, and earlier reviews.

**Ready to merge** turns green when there are no open findings, GitHub reports the PR as mergeable, CI is passing or absent, it isn't a draft, nobody is requesting changes, and branch protection isn't holding it. Otherwise it's gray and lists what's blocking, for example `2 open findings · CI pending · conflicts`.

Filter with the **Only open Watcher findings** toggle, or type `watcher:open`, `watcher:addressed`, `watcher:partly`, `watcher:summary` or `watcher:none` in the filter box.

Watcher data is fetched in a second, batched GraphQL query only for PRs whose latest reviews include a configured bot, so it costs about one rate-limit point per 20 PRs. Only the first 50 review threads of a PR are checked; a warning appears if there are more. The reviews come from the same `gh` token as everything else, so that token must be able to read each org (`gh api graphql -f query='{repositoryOwner(login:"my-org"){repositories(first:1){nodes{nameWithOwner}}}}'` should return a repo).
````

Add two rows to the config table after `refresh_seconds`:

```markdown
| `bot_reviews` | Fetch and show PR Watcher reviews (default `true`). |
| `bot_reviewers` | Bot logins whose reviews count, in GitHub's `[bot]` form (default `["grok-pr-watcher[bot]"]`). |
```

Update the "Run it" section's type-check paragraph:

```markdown
You don't need `npm install` to run it. It's only for type checking and tests:

```bash
npm install && npm run check    # tsc --noEmit, strict
npm test                        # node --test, pure server modules
```
```

Update the project layout block:

```
src/github.ts        GraphQL queries, pagination, shaping into the dashboard model, batched Watcher fetch
src/botreviews.ts    Watcher status rules and merge blockers (pure, tested)
src/sanitize.ts      allowlist filter for GitHub's rendered bodyHTML (pure, tested)
src/*.test.ts        node --test suites
...
static/lib/watcher.ts Watcher badges, mergeable indicator, review panel
```

- [ ] **Step 2: Add the CI workflow**

Create `.github/workflows/check.yml`:

```yaml
name: check
on:
  push:
    branches: [main]
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install
      - run: npm run check
      - run: npm test
```

(There is no `package-lock.json`, so `npm install` rather than `npm ci`.)

- [ ] **Step 3: Final verification**

Run: `npm test && npm run check`
Expected: `ℹ pass 47`, `ℹ fail 0`; `tsc` exits 0.

Run `node server.ts --port 8790` once more and confirm the page loads with no console errors in both layouts.

- [ ] **Step 4: Commit**

```bash
git add README.md .github/workflows/check.yml
git commit -m "docs: Watcher reviews, test command, CI workflow"
```

---

## Self-review notes

- **Spec coverage.** Data (marker fields, second fetch, pure module, config): Tasks 1, 3–5. Status rules (open until resolved, outdated marker, nits, four statuses, new-commits chip, overall status, colors): Tasks 3, 4, 7. UI list row, mergeable indicator, panel with rendered markdown and findings, earlier reviews: Task 7. Grid dot and stat: Task 8. Summary chip and filters: Task 6. Files list: all named files are touched; `src/views.ts` and `static/lib/editor.ts` need no change. Auth: README (Task 9); `owners` in `config.json` is the user's local config, not code.
- **Decisions not in the spec, made here.** The `Watcher:` badge counts across all of a PR's reviews, not only the latest. The nits badge counts unresolved nits. `mergeStateStatus` BLOCKED and BEHIND are blockers too, since "Ready to merge" would otherwise be wrong under branch protection. A review whose only findings are nits is "addressed". Review bodies clamp when they have more than 8 block elements, since the panel is closed at render time and can't be measured.
- **Type consistency.** `WatcherStatus` values `open | partly | addressed | summary` are used identically in `botreviews.ts`, `state.ts` (`watcherMatch`), `watcher.ts` (`STATUS_LABEL`, CSS classes `w-*`, `wdot.*`). `PullRequest.headOid` (not `headRefOid`) is the shaped field; `RawPR.headRefOid` is the raw one. `attachBotReviews`'s `candidates` keys are lowercase owners, matching `tokens.forOwner`'s own lowercasing.
