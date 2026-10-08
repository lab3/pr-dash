// Pure logic for bot (PR Watcher) reviews: which actor is a bot, what counts as a nit,
// and how findings roll up into a status. No I/O, so `node --test` covers it.
import { sanitizeHtml } from "./sanitize.ts";
import type { Finding, PullRequest, WatcherReview, WatcherStatus, WatcherSummary } from "./types.ts";

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
