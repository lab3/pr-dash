import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { isBroken, isRunning, rowClasses } from "./list.ts";
import { makePr as pr } from "./test-fixtures.ts";

/** rowClasses output as a sorted token list. Order is irrelevant to the cascade, but the leading space is not. */
function classes(s: string): string[] {
  if (s) assert.match(s, /^ \S/, "non-empty rowClasses must start with one space, it is appended to the base class");
  return s.split(" ").filter(Boolean).sort();
}

test("isRunning: pending and expected checks only", () => {
  assert.equal(isRunning(pr({ ci: "PENDING" })), true);
  assert.equal(isRunning(pr({ ci: "EXPECTED" })), true);
  for (const ci of ["SUCCESS", "FAILURE", "ERROR", null] as const) assert.equal(isRunning(pr({ ci })), false);
});

test("isBroken: failing or errored checks, or merge conflicts", () => {
  assert.equal(isBroken(pr({ ci: "FAILURE" })), true);
  assert.equal(isBroken(pr({ ci: "ERROR" })), true);
  assert.equal(isBroken(pr({ ci: "FAILURE", mergeable: "CONFLICTING" })), true);
  assert.equal(isBroken(pr({ ci: "PENDING", mergeable: "CONFLICTING" })), true);
  assert.equal(isBroken(pr({ ci: null, mergeable: "CONFLICTING" })), true);
  assert.equal(isBroken(pr({ ci: "PENDING" })), false);
  assert.equal(isBroken(pr({})), false);
});

test("isBroken: unknown or missing mergeability is not a conflict", () => {
  for (const mergeable of ["UNKNOWN", null] as const) assert.equal(isBroken(pr({ mergeable })), false);
});

test("rowClasses: no modifiers for a clean PR", () => {
  assert.equal(rowClasses(pr({})), "");
});

test("rowClasses: draft, attn and running combine", () => {
  assert.deepEqual(classes(rowClasses(pr({ isDraft: true, reviewRequestedFromMe: true, ci: "PENDING" }))),
    ["attn", "is-draft", "is-running"]);
});

test("rowClasses: in-flight checks with conflicts carry both running and broken", () => {
  for (const ci of ["PENDING", "EXPECTED"] as const) {
    assert.deepEqual(classes(rowClasses(pr({ ci, mergeable: "CONFLICTING" }))), ["is-broken", "is-running"]);
  }
});

test("rowClasses: failing checks with conflicts add is-broken once", () => {
  assert.deepEqual(classes(rowClasses(pr({ ci: "FAILURE", mergeable: "CONFLICTING" }))), ["is-broken"]);
});

// Both washes have equal specificity, so the red one wins only because it is declared later.
test("style.css: .is-broken rules come after .is-running rules", async () => {
  const css = await readFile(new URL("../style.css", import.meta.url), "utf8");
  for (const sel of [".pr.is-running", ".gpr.is-running"]) {
    const broken = sel.replace("is-running", "is-broken");
    assert.ok(css.includes(sel) && css.includes(broken), `${sel} and ${broken} must both exist`);
    assert.ok(css.lastIndexOf(sel) < css.indexOf(broken), `${broken} must be declared after every ${sel} rule`);
  }
});
