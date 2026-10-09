import assert from "node:assert/strict";
import { test } from "node:test";
import { validateViews } from "./views-core.ts";

const base = { id: "work", name: "Work", owners: ["my-org"], repos: [] };

test("validateViews keeps exclude entries and dedupes them case-insensitively", () => {
  const [v] = validateViews({ views: [{ ...base, exclude: ["my-org/sandbox", " My-Org/Sandbox ", "my-org/tmp-*"] }] });
  assert.deepEqual(v.exclude, ["my-org/sandbox", "my-org/tmp-*"]);
});

test("validateViews defaults exclude to an empty list for views saved before it existed", () => {
  const [v] = validateViews({ views: [base] });
  assert.deepEqual(v.exclude, []);
});

test("validateViews rejects an exclude entry that is not owner/name or a pattern", () => {
  assert.throws(() => validateViews({ views: [{ ...base, exclude: ["sandbox"] }] }), /"sandbox" is not owner\/name or a pattern/);
  assert.throws(() => validateViews({ views: [{ ...base, exclude: "my-org/sandbox" }] }), /must be lists/);
});
