import assert from "node:assert/strict";
import { test } from "node:test";
import { signedOut } from "./session.ts";

const res = (status: number, contentType: string | null, type: ResponseType = "basic") =>
  ({ status, type, headers: new Headers(contentType ? { "content-type": contentType } : {}) });

test("Access's 401 for an expired session counts as signed out", () => {
  assert.equal(signedOut(res(401, "text/html")), true);
  assert.equal(signedOut(res(401, null)), true);
});

test("a redirect (Access sending the request to its login page) counts as signed out", () => {
  assert.equal(signedOut(res(0, null, "opaqueredirect")), true);
});

test("the app's own JSON 401 (GitHub rejected the token) is an ordinary error", () => {
  assert.equal(signedOut(res(401, "application/json; charset=utf-8")), false);
});

test("other statuses are not sign-in problems", () => {
  assert.equal(signedOut(res(200, "application/json")), false);
  assert.equal(signedOut(res(403, "text/plain; charset=utf-8")), false);
  assert.equal(signedOut(res(500, "text/html")), false);
});
