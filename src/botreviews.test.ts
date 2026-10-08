import assert from "node:assert/strict";
import { test } from "node:test";
import { botLogin, isNit, mergeBlockers, overallStatus, reviewStatus, shapeWatcher,
  type RawBotReview, type RawThread } from "./botreviews.ts";

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
  assert.deepEqual(mergeBlockers({ ...base, mergeable: null }), ["merge check pending"]);
});

test("mergeBlockers: branch protection states", () => {
  assert.deepEqual(mergeBlockers({ ...base, mergeState: "BLOCKED" }), ["blocked by branch rules"]);
  assert.deepEqual(mergeBlockers({ ...base, mergeState: "BEHIND" }), ["behind base"]);
});
