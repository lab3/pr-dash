// Seeds the hosted KV namespace from gitignored local files, after validating them with the
// same code the Worker uses. Needs a rendered wrangler.deploy.json and a wrangler login.
//
//   node scripts/seed-kv.mjs config.hosted.json [views.json]
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULTS, normalizeConfig } from "../shared/config-core.ts";
import { validateViews } from "../shared/views-core.ts";

const [configFile, viewsFile] = process.argv.slice(2);
if (!configFile) {
  console.error("usage: node scripts/seed-kv.mjs config.hosted.json [views.json]");
  process.exit(1);
}

const cfg = normalizeConfig({ ...DEFAULTS, ...JSON.parse(await readFile(configFile, "utf8")) });
if (!cfg.allowed_emails.length) throw new Error("config.hosted.json needs at least one allowed_emails entry.");
if (!cfg.owners.length && !cfg.repos.length) throw new Error("config.hosted.json needs owners or repos (mine is ignored hosted).");
cfg.mine = false; // hosted mode ignores `mine`; keep it off in storage
for (const [owner, spec] of Object.entries(cfg.tokens)) {
  if (!/^(app:\d+|secret:[A-Z0-9_]+)$/.test(spec)) throw new Error(`tokens.${owner} must be app:<id> or secret:NAME, got ${spec}.`);
}

const dir = await mkdtemp(path.join(tmpdir(), "prdash-seed-"));
try {
  const puts = [["config", cfg]];
  if (viewsFile) puts.push(["views", { views: validateViews(JSON.parse(await readFile(viewsFile, "utf8"))) }]);
  for (const [key, value] of puts) {
    const file = path.join(dir, `${key}.json`);
    await writeFile(file, JSON.stringify(value));
    const r = spawnSync("npx", ["--no-install", "wrangler", "kv", "key", "put", "--remote", "--config", "wrangler.deploy.json", "--binding", "PRDASH", key, "--path", file], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`wrangler kv key put ${key} failed (exit ${r.status ?? "signal"}).`);
  }
  console.log(`Seeded ${puts.map(([k]) => k).join(", ")}.`);
} catch (e) {
  console.error(`::error::${e.message}`);
  process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
