// Fills the placeholders in the committed wrangler.json from the environment and writes
// wrangler.deploy.json (gitignored). The repo is public, so account id, hostname, KV id,
// Access team domain and AUD never live in git.
//
//   node scripts/render-wrangler.mjs          # from env: CF_ACCOUNT_ID PRDASH_HOSTNAME PRDASH_KV_ID ACCESS_TEAM_DOMAIN ACCESS_AUD
//   node scripts/render-wrangler.mjs --dev    # dummies for `wrangler dev`; ACCESS_AUD omitted so DEV_ACCESS_EMAIL works
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const PLACEHOLDERS = {
  __ACCOUNT_ID__: "CF_ACCOUNT_ID",
  __HOSTNAME__: "PRDASH_HOSTNAME",
  __KV_ID__: "PRDASH_KV_ID",
  __ACCESS_TEAM_DOMAIN__: "ACCESS_TEAM_DOMAIN",
  __ACCESS_AUD__: "ACCESS_AUD",
};

export const DEV_VALUES = {
  CF_ACCOUNT_ID: "0".repeat(32),
  PRDASH_HOSTNAME: "localhost",
  PRDASH_KV_ID: "dev",
  ACCESS_TEAM_DOMAIN: "https://dev.cloudflareaccess.com",
  ACCESS_AUD: null,
};

export function render(template, values) {
  const text = JSON.stringify(template);
  let out = text;
  for (const [placeholder, name] of Object.entries(PLACEHOLDERS)) {
    const value = values[name];
    if (value === null) continue; // dev: leave the placeholder, remove the key below
    if (!value) throw new Error(`${name} is not set (needed for ${placeholder}).`);
    out = out.split(placeholder).join(name === "ACCESS_TEAM_DOMAIN" ? value.replace(/\/$/, "") : value);
  }
  const config = JSON.parse(out);
  if (values.ACCESS_AUD === null) delete config.vars.ACCESS_AUD;
  return config;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const root = new URL("..", import.meta.url);
  const template = JSON.parse(await readFile(new URL("wrangler.json", root), "utf8"));
  const dev = process.argv.includes("--dev");
  const values = dev ? DEV_VALUES : Object.fromEntries(Object.values(PLACEHOLDERS).map((n) => [n, process.env[n]]));
  const config = render(template, values);
  await writeFile(new URL("wrangler.deploy.json", root), JSON.stringify(config, null, 2) + "\n");
  console.log(`Wrote wrangler.deploy.json${dev ? " (dev values)" : ""}.`);
}
