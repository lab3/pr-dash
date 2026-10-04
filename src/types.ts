// Shapes shared by the server (src/*.ts) and the browser (static/app.ts).

export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";
export type CheckState = "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED";

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
