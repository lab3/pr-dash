// Refuses to deploy a Worker that could be reachable outside the Access sign-in or that
// still carries a placeholder.
//
//   node scripts/check-config.mjs [wrangler.deploy.json]
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
export const CRON = "*/5 * * * *";

export function validate(config, { dev = false } = {}) {
  const text = JSON.stringify(config);
  if (text.includes("__")) throw new Error("wrangler config still contains a placeholder (__NAME__). Run scripts/render-wrangler.mjs.");
  if (!ACCOUNT_ID.test(config.account_id ?? "")) throw new Error("account_id must be a 32-character lowercase hex id.");
  if (config.workers_dev !== false) throw new Error("workers_dev must be false.");
  if (config.preview_urls !== false) throw new Error("preview_urls must be false.");
  const domains = (config.routes ?? []).filter((r) => r.custom_domain).map((r) => r.pattern);
  if (domains.length !== 1) throw new Error(`expected exactly one custom_domain route, found ${domains.length}.`);
  if (!config.assets?.directory || config.assets.run_worker_first !== true) throw new Error("assets.run_worker_first must be true.");
  if (JSON.stringify(config.triggers?.crons) !== JSON.stringify([CRON])) throw new Error(`triggers.crons must be ["${CRON}"].`);
  if (!config.kv_namespaces?.some((k) => k.binding === "PRDASH")) throw new Error("a PRDASH kv_namespaces binding is required.");
  if (!dev) {
    for (const name of ["HOSTNAME", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD"]) {
      if (!config.vars?.[name]) throw new Error(`vars.${name} is required.`);
    }
    if (config.vars.HOSTNAME !== domains[0]) throw new Error("vars.HOSTNAME must equal the custom_domain route.");
  }
  return { name: config.name, hostname: domains[0], teamDomain: config.vars?.ACCESS_TEAM_DOMAIN, aud: config.vars?.ACCESS_AUD };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const file = process.argv[2] ?? "wrangler.deploy.json";
  try {
    const info = validate(JSON.parse(await readFile(file, "utf8")));
    console.log(`${file}: ok (${info.name} at ${info.hostname}).`);
  } catch (e) {
    console.error(`::error::${file}: ${e.message}`);
    process.exit(1);
  }
}
