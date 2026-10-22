// Hosted mode sits behind Cloudflare Access. When the Access session expires, API calls stop
// reaching the Worker; the page reloads so Access can show its login screen.

/**
 * True when Access turned the request away. api() sends `X-Requested-With: XMLHttpRequest`,
 * which makes Access answer 401 instead of redirecting to its login page; a redirect is
 * caught too (fetch uses `redirect: "manual"`), since the API itself never redirects. The
 * app's own 401s (GitHub rejected the token) are JSON and stay ordinary errors.
 */
export function signedOut(res: Pick<Response, "status" | "type" | "headers">): boolean {
  if (res.type === "opaqueredirect") return true;
  return res.status === 401 && !(res.headers.get("content-type") ?? "").includes("application/json");
}

const RELOADED_AT = "pr-dash:signin-reload";

/**
 * Reload the page so Access shows its login screen. Returns false without reloading if it
 * already did so in the last minute, so a gate that keeps refusing can't loop the page.
 */
export function reloadToSignIn(now = Date.now()): boolean {
  try {
    if (now - Number(sessionStorage.getItem(RELOADED_AT)) < 60_000) return false;
    sessionStorage.setItem(RELOADED_AT, String(now));
  } catch { /* storage blocked: reload anyway */ }
  location.reload();
  return true;
}
