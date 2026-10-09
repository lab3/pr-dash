import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { DashboardData, PullRequest, Repo } from "../../src/types.ts";
import { compute, reposIn, residualBlockers, state, viewMatcher, watcherMatch, withExclusion } from "./state.ts";

function pr(number: number, watcher: PullRequest["watcher"]): PullRequest {
  return {
    number, title: `t${number}`, url: `https://github.com/o/r/pull/${number}`, isDraft: false,
    createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z", head: "f", base: "main",
    review: null, ci: "SUCCESS", additions: 1, deletions: 1, comments: 0, author: "len", authorUrl: null,
    avatar: null, labels: [], requestedReviewers: [], requestedTeams: [], isMine: false, reviewRequestedFromMe: false,
    id: `PR_${number}`, headOid: "head1", mergeable: "MERGEABLE", mergeState: "CLEAN",
    watcher, watcherIssue: null, blockers: [],
  };
}

const withFindings = pr(1, { status: "open", open: 2, total: 2, nits: 0, stale: false, latest: {} as never, earlier: [] });
const without = pr(2, null);

const repo: Repo = {
  name: "o/r", url: "https://github.com/o/r", description: null, isPrivate: false, isArchived: false,
  isFork: false, pushedAt: null, language: null, languageColor: null, openCount: 2, prs: [withFindings, without],
};

const data = (botReviews: boolean): DashboardData => ({
  viewer: "len", rateLimit: null, warnings: [], repos: [repo], fetchMs: 1,
  generatedAt: "2026-10-08T00:00:00Z", refreshSeconds: 60, botReviews,
});

beforeEach(() => {
  state.onlyWatcher = false;
  state.filter = "";
  state.hideDrafts = false;
  state.onlyReview = false;
  state.onlyMine = false;
  state.owner = "";
  state.activeView = "all";
  state.views = [];
});

test("watcherMatch handles each token value", () => {
  assert.deepEqual([withFindings, without].map((p) => watcherMatch(p, "open")), [true, false]);
  assert.deepEqual([withFindings, without].map((p) => watcherMatch(p, "none")), [false, true]);
  for (const v of ["addressed", "partly", "summary"]) {
    assert.deepEqual([withFindings, without].map((p) => watcherMatch(p, v)), [false, false], v);
  }
  assert.deepEqual([withFindings, without].map((p) => watcherMatch(p, "bogus")), [true, true]);
});

test("onlyWatcher keeps PRs with open findings when bot reviews are on", () => {
  state.onlyWatcher = true;
  const c = compute(data(true));
  assert.equal(c.withPrs[0].prs.length, 1);
  assert.equal(c.withPrs[0].prs[0].number, 1);
  assert.equal(c.prFilterOn, true);
});

test("onlyWatcher is ignored when bot reviews are off", () => {
  state.onlyWatcher = true;
  const c = compute(data(false));
  assert.equal(c.withPrs[0].prs.length, 2);
  assert.equal(c.prFilterOn, false);
});

test("watcher: search tokens filter PRs", () => {
  state.filter = "watcher:open";
  assert.deepEqual(compute(data(true)).withPrs[0].prs.map((p) => p.number), [1]);
  state.filter = "watcher:none";
  assert.deepEqual(compute(data(true)).withPrs[0].prs.map((p) => p.number), [2]);
});

const other: Repo = { ...repo, name: "o/sandbox", url: "https://github.com/o/sandbox", openCount: 1, prs: [without] };
const two = (): DashboardData => ({ ...data(true), repos: [repo, other] });

test("viewMatcher drops repos listed in exclude even when their owner is selected", () => {
  const match = viewMatcher({ owners: ["o"], repos: [], exclude: ["O/Sandbox"] });
  assert.equal(match("o/r"), true);
  assert.equal(match("o/sandbox"), false);
});

test("viewMatcher applies exclude patterns", () => {
  const match = viewMatcher({ owners: ["o"], repos: [], exclude: ["o/sand*"] });
  assert.equal(match("o/sandbox"), false);
  assert.equal(match("o/r"), true);
});

test("residualBlockers drops blockers the row already shows as a badge or CI line", () => {
  assert.deepEqual(
    residualBlockers(["2 open findings", "draft", "changes requested", "CI failing", "conflicts", "behind base"]),
    ["conflicts", "behind base"],
  );
  assert.deepEqual(residualBlockers(["1 open finding", "CI pending"]), []);
  assert.deepEqual(residualBlockers(["no Watcher review", "Watcher data unavailable", "Watcher findings incomplete", "merge check pending", "blocked by branch rules"]),
    ["no Watcher review", "Watcher data unavailable", "Watcher findings incomplete", "merge check pending", "blocked by branch rules"]);
});

test("withExclusion adds a repo to a view's exclude list once, without touching the original", () => {
  const view = { id: "work", name: "Work", owners: ["o"], repos: [], exclude: ["o/old"] };
  const next = withExclusion(view, "o/sandbox");
  assert.deepEqual(next.exclude, ["o/old", "o/sandbox"]);
  assert.deepEqual(view.exclude, ["o/old"]);
  assert.deepEqual(withExclusion(next, "O/SANDBOX").exclude, ["o/old", "o/sandbox"]);
});

test("compute leaves an excluded repo out of the active view", () => {
  state.views = [{ id: "work", name: "Work", owners: ["o"], repos: [], exclude: ["o/sandbox"] }];
  state.activeView = "work";
  const c = compute(two());
  assert.deepEqual(c.repos.map((r) => r.name), ["o/r"]);
  assert.deepEqual(reposIn(two(), state.views[0]).map((r) => r.name), ["o/r"]);
});
