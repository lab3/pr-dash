import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, normalizeConfig, publicConfig } from "./config-core.ts";

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

test("normalizeConfig clamps every numeric field and falls back to defaults for garbage", () => {
  const cfg = normalizeConfig({ ...DEFAULTS, refresh_seconds: 1, cache_seconds: -5, max_repos_per_source: 10_000, port: 0 });
  assert.equal(cfg.refresh_seconds, 60, "a 1 s poll would hammer KV");
  assert.equal(cfg.cache_seconds, 0);
  assert.equal(cfg.max_repos_per_source, 1000);
  assert.equal(cfg.port, 1);
  assert.equal(normalizeConfig({ ...DEFAULTS, refresh_seconds: "soon" as unknown as number }).refresh_seconds, DEFAULTS.refresh_seconds);
  assert.equal(normalizeConfig({ ...DEFAULTS, refresh_seconds: 300.9 }).refresh_seconds, 300);
});

test("normalizeConfig still clamps prs_per_repo", () => {
  assert.equal(normalizeConfig({ ...DEFAULTS, prs_per_repo: 500 }).prs_per_repo, 100);
  assert.equal(normalizeConfig({ ...DEFAULTS, prs_per_repo: -5 }).prs_per_repo, 1);
});

test("new hosted keys default to empty", () => {
  assert.equal(DEFAULTS.viewer_login, null);
  assert.deepEqual(DEFAULTS.allowed_emails, []);
});

test("normalizeConfig lowercases and trims allowed_emails and drops blanks", () => {
  const cfg = normalizeConfig({ ...DEFAULTS, allowed_emails: [" Len@Example.org ", ""] });
  assert.deepEqual(cfg.allowed_emails, ["len@example.org"]);
});

test("normalizeConfig turns a blank viewer_login into null", () => {
  assert.equal(normalizeConfig({ ...DEFAULTS, viewer_login: "  " }).viewer_login, null);
  assert.equal(normalizeConfig({ ...DEFAULTS, viewer_login: " len " }).viewer_login, "len");
});

test("publicConfig strips tokens and allowed_emails", () => {
  const pub = publicConfig({ ...DEFAULTS, tokens: { default: "gh" }, allowed_emails: ["a@b.c"] }) as Record<string, unknown>;
  assert.equal("tokens" in pub, false);
  assert.equal("allowed_emails" in pub, false);
  assert.equal(pub.prs_per_repo, 50);
});
