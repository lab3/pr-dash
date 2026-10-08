import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS } from "../shared/config-core.ts";
import type { collect } from "../shared/github.ts";
import type { Env } from "./env.ts";
import { readConfig, readData, readViews, runRefresh } from "./refresh.ts";

export class MemoryKV {
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

const env = (kv: MemoryKV): Env => ({ PRDASH: kv as unknown as KVNamespace, ASSETS: { fetch: async () => new Response() } }) as Env;

const okCollect: typeof collect = async (cfg) => ({
  viewer: cfg.viewer_login, rateLimit: null, warnings: ["w1"], repos: [], botReviews: true,
});

const deps = (c: typeof collect) => ({ collect: c, tokens: () => ({ default: async () => "t", forOwner: async () => "t" }), now: () => 1_700_000_000_000 });

test("readConfig merges KV over defaults, normalizes, and forces mine off", async () => {
  const kv = new MemoryKV();
  kv.store.set("config", JSON.stringify({ mine: true, owners: ["O"], allowed_emails: ["A@B.C"], viewer_login: "len" }));
  const cfg = await readConfig(kv as unknown as KVNamespace);
  assert.equal(cfg.mine, false);
  assert.deepEqual(cfg.owners, ["O"]);
  assert.deepEqual(cfg.allowed_emails, ["a@b.c"]);
  assert.equal(cfg.prs_per_repo, DEFAULTS.prs_per_repo);
});

test("readConfig and readViews tolerate missing keys", async () => {
  const kv = new MemoryKV();
  assert.equal((await readConfig(kv as unknown as KVNamespace)).mine, false);
  assert.deepEqual(await readViews(kv as unknown as KVNamespace), []);
  assert.equal(await readData(kv as unknown as KVNamespace), null);
});

test("readViews validates", async () => {
  const kv = new MemoryKV();
  kv.store.set("views", JSON.stringify({ views: [{ id: "x", name: "X", owners: ["o"], repos: [] }] }));
  assert.equal((await readViews(kv as unknown as KVNamespace))[0].id, "x");
  kv.store.set("views", JSON.stringify({ views: [{ id: "all" }] }));
  await assert.rejects(readViews(kv as unknown as KVNamespace));
});

test("runRefresh writes prs once with hosted, generatedAt, fetchMs and the mine warning", async () => {
  const kv = new MemoryKV();
  kv.store.set("config", JSON.stringify({ mine: true, owners: ["o"], viewer_login: "len", refresh_seconds: 300 }));
  kv.store.set("views", JSON.stringify({ views: [{ id: "v", name: "V", owners: ["p"], repos: ["q/r"] }] }));
  let extra: unknown;
  const spy: typeof collect = async (cfg, _t, e) => { extra = e; return okCollect(cfg, _t, e); };
  const data = await runRefresh(env(kv), deps(spy));
  assert.equal(kv.writes, 1);
  assert.equal(data.hosted, true);
  assert.equal(data.generatedAt, new Date(1_700_000_000_000).toISOString());
  assert.equal(typeof data.fetchMs, "number");
  assert.equal(data.refreshSeconds, 300);
  assert.equal(data.viewer, "len");
  assert.deepEqual(extra, { repos: ["q/r"], owners: ["p"] });
  assert.ok(data.warnings.includes("w1"));
  assert.ok(data.warnings.some((w) => w.includes("mine")));
  assert.deepEqual(await readData(kv as unknown as KVNamespace), data);
});

test("runRefresh leaves the old value when collect throws", async () => {
  const kv = new MemoryKV();
  kv.store.set("prs", JSON.stringify({ old: true }));
  const boom: typeof collect = async () => { throw new Error("rate limited"); };
  await assert.rejects(runRefresh(env(kv), deps(boom)), /rate limited/);
  assert.equal(kv.writes, 0);
  assert.deepEqual(JSON.parse(kv.store.get("prs")!), { old: true });
});
