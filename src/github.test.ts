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
