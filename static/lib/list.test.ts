import assert from "node:assert/strict";
import { test } from "node:test";
import type { PullRequest } from "../../src/types.ts";
import { isBroken, isRunning, rowClasses } from "./list.ts";

function pr(over: Partial<PullRequest>): PullRequest {
  return {
    number: 1, title: "t", url: "https://github.com/o/r/pull/1", isDraft: false,
    createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z", head: "f", base: "main",
    review: null, ci: "SUCCESS", additions: 1, deletions: 1, comments: 0, author: "len", authorUrl: null,
    avatar: null, labels: [], requestedReviewers: [], requestedTeams: [], isMine: false, reviewRequestedFromMe: false,
    id: "PR_1", headOid: "head1", mergeable: "MERGEABLE", mergeState: "CLEAN",
    watcher: null, watcherIssue: null, blockers: [],
    ...over,
  };
}

test("isRunning: pending and expected checks only", () => {
  assert.equal(isRunning(pr({ ci: "PENDING" })), true);
  assert.equal(isRunning(pr({ ci: "EXPECTED" })), true);
  for (const ci of ["SUCCESS", "FAILURE", "ERROR", null] as const) assert.equal(isRunning(pr({ ci })), false);
});

test("isBroken: failing or errored checks, or merge conflicts", () => {
  assert.equal(isBroken(pr({ ci: "FAILURE" })), true);
  assert.equal(isBroken(pr({ ci: "ERROR" })), true);
  assert.equal(isBroken(pr({ ci: "PENDING", mergeable: "CONFLICTING" })), true);
  assert.equal(isBroken(pr({ ci: "PENDING" })), false);
  assert.equal(isBroken(pr({})), false);
});

test("rowClasses: no modifiers for a clean PR", () => {
  assert.equal(rowClasses(pr({})), "");
});

test("rowClasses: draft, attn and running combine", () => {
  assert.equal(rowClasses(pr({ isDraft: true, reviewRequestedFromMe: true, ci: "PENDING" })), " is-draft attn is-running");
});

// The stylesheet declares .is-broken after .is-running, so the red wash wins only if both classes are present.
test("rowClasses: pending with conflicts carries both running and broken", () => {
  assert.equal(rowClasses(pr({ ci: "PENDING", mergeable: "CONFLICTING" })), " is-running is-broken");
});
