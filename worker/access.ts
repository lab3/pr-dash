// Fail-closed gate in front of everything the Worker serves, assets included. Cloudflare Access
// adds a signed JWT to every request in Cf-Access-Jwt-Assertion; we verify it against the team's
// public keys and pin the audience to this application. Who may sign in is decided by the
// Access policy alone; the Worker only checks that the token is genuine and names an email.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Env } from "./env.ts";

export type AccessResult = { ok: true; email: string } | { ok: false; response: Response };

export interface AccessDeps {
  /** Returns a key resolver for the team's JWKS. Tests pass a local key set. */
  getJwks(teamDomain: string): JWTVerifyGetKey;
}

const jwksCache = new Map<string, JWTVerifyGetKey>();

const defaultDeps: AccessDeps = {
  getJwks(teamDomain) {
    let jwks = jwksCache.get(teamDomain);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
      jwksCache.set(teamDomain, jwks);
    }
    return jwks;
  },
};

export function deny(message: string, status = 403): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export function isLocalHost(host: string): boolean {
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return name === "localhost" || name === "127.0.0.1";
}

export async function verifyAccess(
  request: Request, env: Env, deps: AccessDeps = defaultDeps,
): Promise<AccessResult> {
  const host = request.headers.get("host") ?? new URL(request.url).host;

  // Local development only: `wrangler dev` with DEV_ACCESS_EMAIL in .dev.vars and no ACCESS_AUD.
  if (env.DEV_ACCESS_EMAIL && !env.ACCESS_AUD && isLocalHost(host)) {
    return { ok: true, email: env.DEV_ACCESS_EMAIL.toLowerCase() };
  }

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.HOSTNAME) return { ok: false, response: deny("Site is not configured.", 500) };
  if (host.toLowerCase() !== env.HOSTNAME.toLowerCase()) {
    return { ok: false, response: deny("Wrong host.") };
  }

  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) return { ok: false, response: deny("Sign in through Cloudflare Access to view this site.") };

  let email: string;
  try {
    const { payload } = await jwtVerify(jwt, deps.getJwks(env.ACCESS_TEAM_DOMAIN), {
      issuer: env.ACCESS_TEAM_DOMAIN,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat"],
    });
    email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  } catch {
    return { ok: false, response: deny("Access token could not be verified.") };
  }
  if (!email) return { ok: false, response: deny("Access token carries no email.") };
  return { ok: true, email };
}
