import assert from "node:assert/strict";
import { test } from "node:test";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { collect } from "../shared/github.ts";
import type { Env } from "./env.ts";
import { handle } from "./index.ts";

class MemoryKV {
  store = new Map<string, string>();
  writes = 0;
  async get(key: string, type?: "text" | "json" | "stream"): Promise<unknown> {
    const v = this.store.get(key) ?? null;
    if (v === null) return null;
    if (type === "json") return JSON.parse(v);
    if (type === "stream") return new Response(v).body;
    return v;
  }
  async put(key: string, value: string): Promise<void> {
    this.writes++;
    this.store.set(key, value);
  }
}

const TEAM = "https://team.cloudflareaccess.com";
const AUD = "a".repeat(64);
const HOST = "pr.example.test";
const pair = await generateKeyPair("RS256");
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }] });
const jwt = await new SignJWT({ email: "you@example.org" }).setProtectedHeader({ alg: "RS256", kid: "k1" })
  .setIssuer(TEAM).setAudience(AUD).setIssuedAt().setExpirationTime("10m").sign(pair.privateKey);

let now = 1_700_000_000_000;
let collectCalls = 0;
const fakeCollect: typeof collect = async (cfg) => { collectCalls++; return { viewer: cfg.viewer_login, rateLimit: null, warnings: [], repos: [], botReviews: true }; };
const deps = {
  access: { getJwks: () => jwks },
  refresh: { collect: fakeCollect, tokens: () => ({ default: async () => "t", forOwner: async () => "t" }), now: () => now },
};

function setup(): { env: Env; kv: MemoryKV; waits: Promise<unknown>[] } {
  const kv = new MemoryKV();
  kv.store.set("config", JSON.stringify({ owners: ["o"], viewer_login: "len" }));
  const env = { PRDASH: kv, ASSETS: { fetch: async (r: Request) => new Response(`asset:${new URL(r.url).pathname}`, { headers: { "content-type": "text/css" } }) },
    ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, HOSTNAME: HOST } as unknown as Env;
  return { env, kv, waits: [] };
}

const ctxOf = (waits: Promise<unknown>[]) => ({ waitUntil: (p: Promise<unknown>) => { waits.push(p); } });

function req(path: string, init: RequestInit & { auth?: boolean } = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("host", HOST);
  if (init.auth !== false) headers.set("cf-access-jwt-assertion", jwt);
  return new Request(`https://${HOST}${path}`, { ...init, headers });
}

test("everything is 403 without Access, assets included", async () => {
  const { env, waits } = setup();
  for (const p of ["/", "/style.css", "/api/prs", "/api/health"]) {
    const res = await handle(req(p, { auth: false }), env, ctxOf(waits), deps);
    assert.equal(res.status, 403, p);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
  }
});

test("assets pass through with security headers", async () => {
  const { env, waits } = setup();
  const res = await handle(req("/style.css"), env, ctxOf(waits), deps);
  assert.equal(await res.text(), "asset:/style.css");
  assert.ok(res.headers.get("content-security-policy")?.startsWith("default-src 'self'"));
  assert.equal(res.headers.get("x-robots-tag"), "noindex");
  assert.equal(res.headers.get("cache-control"), "private, no-store");
});

test("/api/health and /api/prs before the first cron run", async () => {
  const { env, waits } = setup();
  assert.deepEqual(await (await handle(req("/api/health"), env, ctxOf(waits), deps)).json(), { ok: true });
  const res = await handle(req("/api/prs"), env, ctxOf(waits), deps);
  assert.equal(res.status, 404);
  assert.match(((await res.json()) as { error: string }).error, /cron/);
});

test("/api/prs serves KV; refresh=1 reruns only when older than 60 s", async () => {
  const { env, kv, waits } = setup();
  collectCalls = 0;
  now = 1_700_000_000_000;
  const first = await handle(req("/api/prs?refresh=1"), env, ctxOf(waits), deps);
  assert.equal(first.status, 200);
  assert.equal(collectCalls, 1);
  assert.equal(kv.writes, 1);
  now += 30_000;
  await handle(req("/api/prs?refresh=1"), env, ctxOf(waits), deps);
  assert.equal(collectCalls, 1, "30 s later: served from KV");
  now += 31_000;
  await handle(req("/api/prs?refresh=1"), env, ctxOf(waits), deps);
  assert.equal(collectCalls, 2, "61 s later: refreshed");
  const plain = await handle(req("/api/prs"), env, ctxOf(waits), deps);
  assert.equal(((await plain.json()) as { hosted: boolean }).hosted, true);
  assert.equal(collectCalls, 2);
});

test("refresh=1 with a failing collect keeps old data and reports the error", async () => {
  const { env, kv, waits } = setup();
  kv.store.set("prs", JSON.stringify({ repos: [], warnings: [], generatedAt: new Date(0).toISOString(), hosted: true }));
  const failing = { ...deps, refresh: { ...deps.refresh, collect: (async () => { throw new Error("GitHub down"); }) as typeof collect } };
  const res = await handle(req("/api/prs?refresh=1"), env, ctxOf(waits), failing);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { warnings: string[] };
  assert.ok(body.warnings.some((w) => w.includes("GitHub down")));
});

test("views round-trip; a new owner triggers a background refresh; writes need the CSRF headers", async () => {
  const { env, kv, waits } = setup();
  collectCalls = 0;
  const bad = await handle(req("/api/views", { method: "PUT", body: "{}" }), env, ctxOf(waits), deps);
  assert.equal(bad.status, 403);
  const put = await handle(req("/api/views", {
    method: "PUT", body: JSON.stringify({ views: [{ id: "v", name: "V", owners: ["newowner"], repos: [] }] }),
    headers: { "content-type": "application/json", "x-pr-dash": "1", origin: `https://${HOST}` },
  }), env, ctxOf(waits), deps);
  assert.equal(put.status, 200);
  assert.equal(collectCalls, 1, "new owner → refresh, awaited before the response so the next load is fresh");
  assert.equal(kv.store.has("prs"), true);
  assert.equal(((await (await handle(req("/api/views"), env, ctxOf(waits), deps)).json()) as { views: unknown[] }).views.length, 1);
  const wrongOrigin = await handle(req("/api/views", {
    method: "PUT", body: JSON.stringify({ views: [] }),
    headers: { "content-type": "application/json", "x-pr-dash": "1", origin: "https://evil.example" },
  }), env, ctxOf(waits), deps);
  assert.equal(wrongOrigin.status, 403);
});

test("GET /api/config strips secrets; PUT stores and refreshes; the old allowlist key is unknown", async () => {
  const { env, waits } = setup();
  collectCalls = 0;
  const got = (await (await handle(req("/api/config"), env, ctxOf(waits), deps)).json()) as Record<string, unknown>;
  assert.equal("tokens" in got, false);
  assert.equal("host" in got, false, "local-server fields are not shown in hosted mode");
  assert.equal("port" in got, false);
  assert.deepEqual(got.owners, ["o"]);
  const headers = { "content-type": "application/json", "x-pr-dash": "1", origin: `https://${HOST}` };
  const stale = await handle(req("/api/config", { method: "PUT", body: JSON.stringify({ owners: ["o"], allowed_emails: ["other@x.y"] }), headers }), env, ctxOf(waits), deps);
  assert.equal(stale.status, 400, "allowed_emails is no longer a config key");
  const ok = await handle(req("/api/config", { method: "PUT", body: JSON.stringify({ owners: ["o", "p"] }), headers }), env, ctxOf(waits), deps);
  assert.equal(ok.status, 200);
  await Promise.all(waits);
  assert.equal(collectCalls, 1, "config PUT triggers a refresh");
  const after = (await (await handle(req("/api/config"), env, ctxOf(waits), deps)).json()) as Record<string, unknown>;
  assert.deepEqual(after.owners, ["o", "p"]);
});

test("PUT /api/config merges over the stored config, so tokens survive", async () => {
  const { env, kv, waits } = setup();
  kv.store.set("config", JSON.stringify({ owners: ["o"], viewer_login: "len", tokens: { o: "app:5" } }));
  const headers = { "content-type": "application/json", "x-pr-dash": "1", origin: `https://${HOST}` };
  const res = await handle(req("/api/config", { method: "PUT", body: JSON.stringify({ owners: ["o", "p"] }), headers }), env, ctxOf(waits), deps);
  assert.equal(res.status, 200);
  await Promise.all(waits);
  const stored = JSON.parse(kv.store.get("config") as string) as { tokens: unknown; owners: unknown };
  assert.deepEqual(stored.tokens, { o: "app:5" });
  assert.deepEqual(stored.owners, ["o", "p"]);
  assert.equal((stored as { mine: unknown }).mine, false);
});

test("PUT /api/config rejects wrong types, unknown keys and raw tokens", async () => {
  const { env, kv, waits } = setup();
  const before = kv.store.get("config");
  const headers = { "content-type": "application/json", "x-pr-dash": "1", origin: `https://${HOST}` };
  const put = (body: unknown) => handle(req("/api/config", { method: "PUT", body: JSON.stringify(body), headers }), env, ctxOf(waits), deps);
  for (const bad of [{ owners: "my-org" }, { exclude: "x" }, { tokens: { o: "ghp_raw" } }, { refresh_seconds: "5" }, { viewer_login: 5 }, { bogus: 1 },
    { refresh_seconds: 1 }, { refresh_seconds: 300.5 }, { cache_seconds: 99_999 }, { prs_per_repo: 0 }, { port: 8787 }, { host: "x" }]) {
    const res = await put(bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  assert.equal(kv.store.get("config"), before);
  const ok = await put({ owners: ["o"], tokens: { o: "app:5", d: "secret:GH_TOKEN" }, refresh_seconds: 120 });
  assert.equal(ok.status, 200);
});

test("GET /api/config output can be PUT back unchanged", async () => {
  const { env, waits } = setup();
  const got = (await (await handle(req("/api/config"), env, ctxOf(waits), deps)).json()) as Record<string, unknown>;
  const headers = { "content-type": "application/json", "x-pr-dash": "1", origin: `https://${HOST}` };
  const res = await handle(req("/api/config", { method: "PUT", body: JSON.stringify(got), headers }), env, ctxOf(waits), deps);
  assert.equal(res.status, 200, await res.text());
});

test("stale allowlist keys in KV are hidden from GET, round-trip through PUT, and are gone from storage after PUT", async () => {
  const { env, kv, waits } = setup();
  kv.store.set("config", JSON.stringify({ owners: ["o"], viewer_login: "len", allowed_emails: ["len@bitfly.org"], allowed_domains: ["bitfly.org"] }));
  const got = (await (await handle(req("/api/config"), env, ctxOf(waits), deps)).json()) as Record<string, unknown>;
  assert.equal("allowed_emails" in got, false);
  assert.equal("allowed_domains" in got, false);
  const headers = { "content-type": "application/json", "x-pr-dash": "1", origin: `https://${HOST}` };
  const res = await handle(req("/api/config", { method: "PUT", body: JSON.stringify(got), headers }), env, ctxOf(waits), deps);
  assert.equal(res.status, 200, await res.text());
  const stored = JSON.parse(kv.store.get("config") as string) as Record<string, unknown>;
  assert.equal("allowed_emails" in stored, false);
  assert.equal("allowed_domains" in stored, false);
  assert.deepEqual(stored.owners, ["o"]);
});
