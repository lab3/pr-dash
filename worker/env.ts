export interface Env {
  /** KV namespace holding config and cached state. */
  PRDASH: KVNamespace;
  /** Static asset binding that serves the built browser app. */
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** Cloudflare Access team URL, "https://<team>.cloudflareaccess.com". */
  ACCESS_TEAM_DOMAIN?: string;
  /** Cloudflare Access application audience tag. */
  ACCESS_AUD?: string;
  /** Public hostname the Worker must answer on. Requests for other hosts get 403. */
  HOSTNAME?: string;
  /** Email used to bypass Access on localhost during `wrangler dev`. Set in .dev.vars only. */
  DEV_ACCESS_EMAIL?: string;
  /** GitHub App ID. Secret. */
  GH_APP_ID?: string;
  /** GitHub App private key, PKCS#8 PEM. Secret. */
  GH_APP_PRIVATE_KEY?: string;
  /** "secret:NAME" token specs read env[NAME]. */
  [secret: string]: unknown;
}
