// Views validation shared by the Node server and the Cloudflare Worker. No "node:*" imports.
import { DashError } from "./config-core.ts";
import type { View } from "../src/types.ts";

const MAX_VIEWS = 50;
const MAX_ENTRIES = 500;
const ENTRY_RE = /^[A-Za-z0-9_.*?-]+\/[A-Za-z0-9_.*?-]+$/;
export const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/; // GitHub user/org login

export const isPattern = (entry: string): boolean => /[*?]/.test(entry);

/** Case-insensitive glob ("my-org/*", "*\/api") to RegExp. */
export function globToRegExp(glob: string): RegExp {
  const body = glob.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`);
}

/** Validate and normalize untrusted input (from the browser or a hand-edited file). */
export function validateViews(input: unknown): View[] {
  const list = (input as { views?: unknown } | null)?.views ?? input;
  if (!Array.isArray(list)) throw new DashError("Expected {\"views\": [...]}.", null, 400);
  if (list.length > MAX_VIEWS) throw new DashError(`At most ${MAX_VIEWS} views.`, null, 400);
  const seen = new Set<string>();
  return list.map((raw, i): View => {
    const v = raw as Partial<View> | null;
    const where = `View ${i + 1}`;
    if (!v || typeof v !== "object") throw new DashError(`${where} is not an object.`, null, 400);
    const id = String(v.id ?? "").trim();
    const name = String(v.name ?? "").trim();
    if (!/^[a-z0-9-]{1,64}$/.test(id) || id === "all") throw new DashError(`${where} has an invalid id.`, null, 400);
    if (seen.has(id)) throw new DashError(`Duplicate view id "${id}".`, null, 400);
    seen.add(id);
    if (!name || name.length > 60) throw new DashError(`${where} needs a name (max 60 characters).`, null, 400);
    const rawRepos = v.repos ?? [];
    const rawOwners = v.owners ?? [];
    if (!Array.isArray(rawRepos) || !Array.isArray(rawOwners)) {
      throw new DashError(`${where}: "repos" and "owners" must be lists.`, null, 400);
    }
    if (rawRepos.length + rawOwners.length > MAX_ENTRIES) throw new DashError(`${where} has too many entries.`, null, 400);
    const dedupe = (items: unknown[], re: RegExp, what: string): string[] => {
      const out: string[] = [];
      const lower = new Set<string>();
      for (const item of items) {
        const entry = String(item).trim();
        if (!re.test(entry)) throw new DashError(`${where}: "${entry}" is not ${what}.`, null, 400);
        if (!lower.has(entry.toLowerCase())) {
          lower.add(entry.toLowerCase());
          out.push(entry);
        }
      }
      return out;
    };
    const owners = dedupe(rawOwners, OWNER_RE, "a valid user or org name");
    const repos = dedupe(rawRepos, ENTRY_RE, "owner/name or a pattern");
    return { id, name, owners, repos };
  });
}

/** Exact owner/name entries across all views, so the server can fetch repos outside the usual sources. */
export function exactViewRepos(views: View[]): string[] {
  const out = new Map<string, string>();
  for (const v of views) for (const r of v.repos) if (!isPattern(r)) out.set(r.toLowerCase(), r);
  return [...out.values()];
}

/** Owners whose whole repo list a view wants: `owners` entries plus "owner/*" patterns. */
export function viewOwners(views: View[]): string[] {
  const out = new Map<string, string>();
  for (const v of views) {
    for (const o of v.owners) out.set(o.toLowerCase(), o);
    for (const r of v.repos) {
      const m = /^([A-Za-z0-9-]+)\/\*$/.exec(r);
      if (m) out.set(m[1].toLowerCase(), m[1]);
    }
  }
  return [...out.values()];
}
