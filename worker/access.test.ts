import assert from "node:assert/strict";
import { test } from "node:test";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { verifyAccess } from "./access.ts";
import type { Env } from "./env.ts";

const TEAM = "https://team.cloudflareaccess.com";
const AUD = "a".repeat(64);

const pair = await generateKeyPair("RS256");
const other = await generateKeyPair("RS256");
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }] });
const deps = { getJwks: () => jwks };

async function token(claims: Record<string, unknown>, key = pair.privateKey, exp = "10m"): Promise<string> {
  return new SignJWT({ email: "len@bitfly.org", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(TEAM).setAudience(AUD).setIssuedAt().setExpirationTime(exp).sign(key);
}

const env = (over: Partial<Env> = {}): Env =>
  ({ PRDASH: {} as KVNamespace, ASSETS: { fetch: async () => new Response("asset") }, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, HOSTNAME: "pr.example.test", ...over }) as Env;

const req = (jwt: string | null, host = "pr.example.test"): Request =>
  new Request(`https://${host}/`, { headers: jwt ? { "cf-access-jwt-assertion": jwt, host } : { host } });

const allowed = ["len@bitfly.org"];

test("valid token for an allowed email passes", async () => {
  const r = await verifyAccess(req(await token({})), env(), allowed, deps);
  assert.deepEqual(r, { ok: true, email: "len@bitfly.org" });
});

test("missing header is 403 with no-store", async () => {
  const r = await verifyAccess(req(null), env(), allowed, deps);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.response.status, 403);
    assert.equal(r.response.headers.get("cache-control"), "no-store");
  }
});

test("wrong audience, wrong issuer, expired, wrong key are all 403", async () => {
  for (const jwt of [
    await new SignJWT({ email: "len@bitfly.org" }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(TEAM).setAudience("b".repeat(64)).setIssuedAt().setExpirationTime("10m").sign(pair.privateKey),
    await new SignJWT({ email: "len@bitfly.org" }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer("https://evil.cloudflareaccess.com").setAudience(AUD).setIssuedAt().setExpirationTime("10m").sign(pair.privateKey),
    await new SignJWT({ email: "len@bitfly.org" }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(TEAM).setAudience(AUD).setIssuedAt(Math.floor(Date.now() / 1000) - 7200).setExpirationTime(Math.floor(Date.now() / 1000) - 3600).sign(pair.privateKey),
    await token({}, other.privateKey),
  ]) {
    const r = await verifyAccess(req(jwt), env(), allowed, deps);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.response.status, 403);
  }
});

test("email not in the allowlist is 403; comparison is case-insensitive", async () => {
  const bad = await verifyAccess(req(await token({ email: "someone@bitfly.org" })), env(), allowed, deps);
  assert.equal(bad.ok, false);
  const ok = await verifyAccess(req(await token({ email: "Len@Bitfly.org" })), env(), allowed, deps);
  assert.equal(ok.ok, true);
});

test("wrong Host is 403 even with a valid token", async () => {
  const r = await verifyAccess(req(await token({}), "other.example.test"), env(), allowed, deps);
  assert.equal(r.ok, false);
});

test("missing ACCESS_TEAM_DOMAIN or ACCESS_AUD is 500 not configured", async () => {
  for (const over of [{ ACCESS_TEAM_DOMAIN: undefined }, { ACCESS_AUD: undefined }]) {
    const r = await verifyAccess(req(await token({})), env(over), allowed, deps);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.response.status, 500);
      assert.equal(await r.response.text(), "Site is not configured.");
    }
  }
});

test("dev bypass works only on a local host with ACCESS_AUD unset", async () => {
  const dev = env({ ACCESS_AUD: undefined, ACCESS_TEAM_DOMAIN: undefined, HOSTNAME: undefined, DEV_ACCESS_EMAIL: "len@bitfly.org" });
  const local = await verifyAccess(req(null, "localhost:8787"), dev, allowed, deps);
  assert.deepEqual(local, { ok: true, email: "len@bitfly.org" });
  const remote = await verifyAccess(req(null, "pr.example.test"), dev, allowed, deps);
  assert.equal(remote.ok, false);
  const withAud = await verifyAccess(req(null, "localhost:8787"), env({ DEV_ACCESS_EMAIL: "len@bitfly.org" }), allowed, deps);
  assert.equal(withAud.ok, false);
});
