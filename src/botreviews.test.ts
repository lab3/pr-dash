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
