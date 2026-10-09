// Shapes shared by the server (src/*.ts) and the browser (static/app.ts).

export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";
export type CheckState = "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED";
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

export interface Label {
  name: string;
  color: string;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  head: string | null;
  base: string | null;
  review: ReviewDecision | null;
  ci: CheckState | null;
  additions: number | null;
  deletions: number | null;
  comments: number;
  author: string;
  authorUrl: string | null;
  avatar: string | null;
  labels: Label[];
  requestedReviewers: string[];
  requestedTeams: string[];
  isMine: boolean;
  reviewRequestedFromMe: boolean;
  /** GraphQL node id, used for the batched Watcher fetch. */
  id: string;
  headOid: string | null;
  mergeable: MergeableState | null;
  mergeState: MergeStateStatus | null;
  /** null when the PR has no review from a configured bot. */
  watcher: WatcherSummary | null;
  /** Why `watcher` may be missing or incomplete: the second fetch failed or returned nothing
   *  for this PR ("unavailable"), or the PR has more review threads than we fetch ("capped"). */
  watcherIssue: "unavailable" | "capped" | null;
  /** Why the PR isn't ready to merge, in display order. Empty means ready. */
  blockers: string[];
}

export interface Repo {
  name: string; // owner/name
  url: string;
  description: string | null;
  isPrivate: boolean;
  isArchived: boolean;
  isFork: boolean;
  pushedAt: string | null;
  language: string | null;
  languageColor: string | null;
  openCount: number;
  prs: PullRequest[];
}

export interface RateLimit {
  limit: number;
  remaining: number;
  resetAt: string;
}

export interface DashboardData {
  viewer: string | null;
  rateLimit: RateLimit | null;
  warnings: string[];
  repos: Repo[];
  fetchMs: number;
  generatedAt: string;
  refreshSeconds: number;
  /** `bot_reviews` from config, so the UI knows whether to show Watcher chrome. */
  botReviews: boolean;
  /** True when served by the Cloudflare Worker, whose data comes from the cron. */
  hosted?: boolean;
}

/**
 * A saved set of repos: every repo of the listed `owners` (users or orgs), plus `repos`
 * entries, which are "owner/name" or globs like "my-org/web-*".
 */
export interface View {
  id: string;
  name: string;
  owners: string[];
  repos: string[];
}

export interface ViewsPayload {
  views: View[];
}

export interface ApiError {
  error: string;
  hint?: string | null;
}
