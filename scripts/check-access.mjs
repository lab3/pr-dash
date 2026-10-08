// After a deploy, a signed-out request must redirect to THIS Access application's login (the
// team domain and the application AUD in `kid`). Anything else means the site may be public, so
// the workflow fails loudly. A new custom domain can answer 404 or 5xx briefly; those retry.
//
//   ACCESS_TEAM_DOMAIN=https://team.cloudflareaccess.com ACCESS_AUD=... node scripts/check-access.mjs https://pr.example.test
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ATTEMPTS = 12;
const WAIT_MS = 10_000;
const PATHS = ["/", "/app.js", "/api/health", "/api/prs"];

export function accessVerdict({ status, location }, { teamDomain, aud }) {
  if (status === 302 && typeof location === "string") {
    let url;
    try { url = new URL(location); } catch { return { state: "fail", reason: `redirected to an invalid URL ${location}` }; }
    const expected = new URL(teamDomain);
    if (url.origin === expected.origin && url.pathname.startsWith("/cdn-cgi/access/login/") && url.searchParams.get("kid") === aud) {
      return { state: "ok" };
    }
    return { state: "fail", reason: `redirected to ${location}, not this application's Access login` };
  }
  if (status === 0 || status === 404 || status >= 500) return { state: "retry", reason: `answered ${status || "with a network error"}` };
  return { state: "fail", reason: `answered ${status}${location ? ` with a redirect to ${location}` : ""}` };
}

async function probe(url, expect) {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    return accessVerdict({ status: res.status, location: res.headers.get("location") }, expect);
  } catch {
    return accessVerdict({ status: 0, location: null }, expect);
  }
}

async function main(base) {
  const expect = { teamDomain: process.env.ACCESS_TEAM_DOMAIN, aud: process.env.ACCESS_AUD };
  if (!expect.teamDomain || !expect.aud) {
    console.error("::error::ACCESS_TEAM_DOMAIN and ACCESS_AUD must be set.");
    process.exit(1);
  }
  let failed = false;
  for (const path of PATHS) {
    const url = new URL(path, base).toString();
    let verdict;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      verdict = await probe(url, expect);
      if (verdict.state !== "retry") break;
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, WAIT_MS));
    }
    if (verdict.state === "ok") console.log(`${url} sends signed-out visitors to the Access login.`);
    else { failed = true; console.error(`::error::${url} ${verdict.reason}. The site may be reachable without sign-in.`); }
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main(process.argv[2] ?? `https://${process.env.PRDASH_HOSTNAME}`);
}
