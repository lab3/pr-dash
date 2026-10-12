// Shared fixtures for the static/lib unit tests. Not imported by the app, so never bundled.
import type { PullRequest } from "../../src/types.ts";

/** A clean, open, mergeable PR with passing checks; override only the fields a test cares about. */
export function makePr(over: Partial<PullRequest> = {}): PullRequest {
  const number = over.number ?? 1;
  return {
    number, title: `t${number}`, url: `https://github.com/o/r/pull/${number}`, isDraft: false,
    createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z", head: "f", base: "main",
    review: null, ci: "SUCCESS", additions: 1, deletions: 1, comments: 0, author: "len", authorUrl: null,
    avatar: null, labels: [], requestedReviewers: [], requestedTeams: [], isMine: false, reviewRequestedFromMe: false,
    id: `PR_${number}`, headOid: "head1", mergeable: "MERGEABLE", mergeState: "CLEAN",
    watcher: null, watcherIssue: null, blockers: [],
    ...over,
  };
}
