import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validate } from "./check-config.mjs";
import { DEV_VALUES, render } from "./render-wrangler.mjs";

const template = JSON.parse(await readFile(new URL("../wrangler.json", import.meta.url), "utf8"));
const values = { CF_ACCOUNT_ID: "0".repeat(32), PRDASH_HOSTNAME: "pr.example.test", PRDASH_KV_ID: "abc123", ACCESS_TEAM_DOMAIN: "https://t.cloudflareaccess.com", ACCESS_AUD: "f".repeat(64) };

test("the committed template has only placeholders and fails validation as is", () => {
  assert.throws(() => validate(template), /placeholder/);
});

test("render fills every placeholder and the result validates", () => {
  const out = render(template, values);
  assert.equal(out.account_id, values.CF_ACCOUNT_ID);
  assert.equal(out.routes[0].pattern, "pr.example.test");
  assert.equal(out.vars.ACCESS_AUD, values.ACCESS_AUD);
  assert.equal(out.kv_namespaces[0].id, "abc123");
  assert.doesNotThrow(() => validate(out));
  assert.ok(!JSON.stringify(out).includes("__"));
});

test("render refuses a missing value", () => {
  assert.throws(() => render(template, { ...values, ACCESS_AUD: "" }), /ACCESS_AUD/);
});

test("dev values omit ACCESS_AUD so the local bypass can work, and still validate otherwise", () => {
  const out = render(template, DEV_VALUES);
  assert.equal(out.vars.ACCESS_AUD, undefined);
  assert.equal(out.routes[0].pattern, "localhost");
  assert.doesNotThrow(() => validate(out, { dev: true }));
});

test("validate rejects the dangerous settings", () => {
  const good = render(template, values);
  assert.throws(() => validate({ ...good, workers_dev: true }), /workers_dev/);
  assert.throws(() => validate({ ...good, preview_urls: true }), /preview_urls/);
  assert.throws(() => validate({ ...good, routes: [] }), /custom_domain/);
  assert.throws(() => validate({ ...good, assets: { ...good.assets, run_worker_first: false } }), /run_worker_first/);
  assert.throws(() => validate({ ...good, triggers: { crons: ["* * * * *"] } }), /cron/);
  assert.throws(() => validate({ ...good, account_id: "nope" }), /account_id/);
  const { observability: _drop, ...noObs } = good;
  assert.throws(() => validate(noObs), /observability\.enabled must be true/);
  assert.throws(() => validate({ ...good, observability: { enabled: false } }), /observability/);
});

test("validate checks the Access team domain and AUD formats", () => {
  const good = render(template, values);
  const withVars = (vars) => ({ ...good, vars: { ...good.vars, ...vars } });
  assert.throws(() => validate(withVars({ ACCESS_TEAM_DOMAIN: "http://t.cloudflareaccess.com" })), /ACCESS_TEAM_DOMAIN/);
  assert.throws(() => validate(withVars({ ACCESS_TEAM_DOMAIN: "https://t.cloudflareaccess.com/" })), /ACCESS_TEAM_DOMAIN/);
  assert.throws(() => validate(withVars({ ACCESS_AUD: "abc1234567" })), /ACCESS_AUD/);
});

test("render strips one trailing slash from the team domain", () => {
  const out = render(template, { ...values, ACCESS_TEAM_DOMAIN: "https://t.cloudflareaccess.com/" });
  assert.equal(out.vars.ACCESS_TEAM_DOMAIN, "https://t.cloudflareaccess.com");
  assert.doesNotThrow(() => validate(out));
});
