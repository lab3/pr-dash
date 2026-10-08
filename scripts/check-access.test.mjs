import assert from "node:assert/strict";
import { test } from "node:test";
import { accessVerdict } from "./check-access.mjs";

const expect = { teamDomain: "https://t.cloudflareaccess.com", aud: "f".repeat(64) };
const login = `https://t.cloudflareaccess.com/cdn-cgi/access/login/pr.example.test?kid=${"f".repeat(64)}&redirect_url=%2F`;

test("302 to this application's login is ok", () => {
  assert.deepEqual(accessVerdict({ status: 302, location: login }, expect), { state: "ok" });
});

test("redirect to another application or team fails", () => {
  assert.equal(accessVerdict({ status: 302, location: login.replace("f".repeat(64), "e".repeat(64)) }, expect).state, "fail");
  assert.equal(accessVerdict({ status: 302, location: login.replace("t.cloudflareaccess", "evil.cloudflareaccess") }, expect).state, "fail");
  assert.equal(accessVerdict({ status: 302, location: "https://t.cloudflareaccess.com.evil.example/cdn-cgi/access/login/x?kid=" + "f".repeat(64) }, expect).state, "fail");
});

test("200 fails; 404, 5xx and network errors retry", () => {
  assert.equal(accessVerdict({ status: 200, location: null }, expect).state, "fail");
  assert.equal(accessVerdict({ status: 403, location: null }, expect).state, "fail");
  for (const status of [0, 404, 500, 503]) assert.equal(accessVerdict({ status, location: null }, expect).state, "retry");
});
