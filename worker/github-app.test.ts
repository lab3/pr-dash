import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeJwt, exportPKCS8, exportSPKI, generateKeyPair, importSPKI, jwtVerify } from "jose";
import { DEFAULTS } from "../shared/config-core.ts";
import type { Env } from "./env.ts";
import { appTokens, mintAppJwt, resetTokenCache } from "./github-app.ts";

const pair = await generateKeyPair("RS256", { extractable: true });
const pkcs8 = await exportPKCS8(pair.privateKey);
const spki = await exportSPKI(pair.publicKey);

test("mintAppJwt signs RS256 with iss, iat 60s back, exp 540s ahead", async () => {
  const jwt = await mintAppJwt("12345", pkcs8, 1_700_000_000);
  const { payload, protectedHeader } = await jwtVerify(jwt, await importSPKI(spki, "RS256"), { currentDate: new Date(1_700_000_000 * 1000) });
  assert.equal(protectedHeader.alg, "RS256");
  assert.equal(payload.iss, "12345");
  assert.equal(payload.iat, 1_700_000_000 - 60);
  assert.equal(payload.exp, 1_700_000_000 + 540);
  assert.ok(payload.exp! - 1_700_000_000 <= 540, "exp stays clear of GitHub's 10-minute limit");
});

test("installation token is cached until expires_at minus 5 minutes", async () => {
  resetTokenCache();
  let now = 1_700_000_000_000;
  let calls = 0;
  const deps = {
    now: () => now,
    fetch: (async () => {
      calls++;
      return new Response(JSON.stringify({ token: `ghs_${calls}`, expires_at: new Date(1_700_000_000_000 + 20 * 60_000).toISOString() }), { status: 201 });
    }) as typeof fetch,
  };
  const t = appTokens({ ...DEFAULTS, tokens: { o: "app:5" } }, fakeEnv(), deps);
  assert.equal(await t.forOwner("o"), "ghs_1");
  now += 14 * 60_000;
  assert.equal(await t.forOwner("o"), "ghs_1", "still inside expires_at - 5 min");
  now += 2 * 60_000;
  assert.equal(await t.forOwner("o"), "ghs_2", "past expires_at - 5 min, re-minted");
});

function fakeEnv(over: Partial<Env> = {}): Env {
  return { PRDASH: {} as KVNamespace, ASSETS: { fetch: async () => new Response() }, GH_APP_ID: "12345", GH_APP_PRIVATE_KEY: pkcs8, MY_TOKEN: "ghp_secret", ...over } as Env;
}

test("secret:NAME resolves from env", async () => {
  const cfg = { ...DEFAULTS, tokens: { default: "secret:MY_TOKEN" } };
  const t = appTokens(cfg, fakeEnv());
  assert.equal(await t.default(), "ghp_secret");
  assert.equal(await t.forOwner("Anyone"), "ghp_secret");
});

test("app:<id> exchanges a JWT for an installation token and caches it", async () => {
  resetTokenCache();
  const calls: { url: string; auth: string | null }[] = [];
  const deps = {
    now: () => 1_700_000_000_000,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ token: "ghs_inst", expires_at: "2026-01-01T00:00:00Z" }), { status: 201 });
    }) as typeof fetch,
  };
  const cfg = { ...DEFAULTS, tokens: { "my-org": "app:777" } };
  const t = appTokens(cfg, fakeEnv(), deps);
  assert.equal(await t.forOwner("My-Org"), "ghs_inst");
  assert.equal(await t.forOwner("my-org"), "ghs_inst");
  assert.equal(calls.length, 1, "second call served from cache");
  assert.equal(calls[0].url, "https://api.github.com/app/installations/777/access_tokens");
  assert.ok(calls[0].auth?.startsWith("Bearer "));
  assert.equal(decodeJwt(calls[0].auth!.slice(7)).iss, "12345");
});

test("default() uses tokens.default, else the single app entry, else throws", async () => {
  resetTokenCache();
  const deps = { now: () => 0, fetch: (async () => new Response(JSON.stringify({ token: "ghs_x", expires_at: "x" }), { status: 201 })) as typeof fetch };
  assert.equal(await appTokens({ ...DEFAULTS, tokens: { "my-org": "app:1" } }, fakeEnv(), deps).default(), "ghs_x");
  await assert.rejects(appTokens({ ...DEFAULTS, tokens: { a: "app:1", b: "app:2" } }, fakeEnv(), deps).default(), /No default token/);
  await assert.rejects(appTokens({ ...DEFAULTS, tokens: {} }, fakeEnv(), deps).default(), /No default token/);
});

test("an owner with no token spec falls back to default; missing App secrets throw", async () => {
  resetTokenCache();
  await assert.rejects(appTokens({ ...DEFAULTS, tokens: { x: "app:1" } }, fakeEnv({ GH_APP_PRIVATE_KEY: undefined }), { now: () => 0, fetch }).forOwner("x"), /GH_APP_PRIVATE_KEY/);
  const cfg = { ...DEFAULTS, tokens: { default: "secret:MY_TOKEN" } };
  assert.equal(await appTokens(cfg, fakeEnv()).forOwner("unknown-org"), "ghp_secret");
});

test("a failed exchange throws a DashError naming the installation", async () => {
  resetTokenCache();
  const deps = { now: () => 0, fetch: (async () => new Response("nope", { status: 401 })) as typeof fetch };
  await assert.rejects(appTokens({ ...DEFAULTS, tokens: { o: "app:9" } }, fakeEnv(), deps).forOwner("o"), /installation 9/);
});

test("secret:NAME refuses the Worker's own secrets and settings", async () => {
  for (const name of ["GH_APP_PRIVATE_KEY", "GH_APP_ID", "ACCESS_AUD", "ACCESS_TEAM_DOMAIN", "HOSTNAME", "DEV_ACCESS_EMAIL"]) {
    const t = appTokens({ ...DEFAULTS, tokens: { default: `secret:${name}` } }, fakeEnv({ HOSTNAME: "pr.example.test" }));
    await assert.rejects(t.default(), new RegExp(`Refusing to use ${name}`));
  }
});

test("app:<id> must be numeric", async () => {
  resetTokenCache();
  const deps = { now: () => 0, fetch: (async () => { throw new Error("must not be called"); }) as typeof fetch };
  await assert.rejects(appTokens({ ...DEFAULTS, tokens: { o: "app:../x" } }, fakeEnv(), deps).forOwner("o"), /Installation id "\.\.\/x" is not a number/);
});

test("an exchange that returns no token throws", async () => {
  resetTokenCache();
  const deps = { now: () => 0, fetch: (async () => new Response(JSON.stringify({ expires_at: "x" }), { status: 201 })) as typeof fetch };
  await assert.rejects(appTokens({ ...DEFAULTS, tokens: { o: "app:9" } }, fakeEnv(), deps).forOwner("o"), /no token for installation 9/);
});
